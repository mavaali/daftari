// Provider-neutral reconciliation. Provider adapters own OAuth HTTP, discovery,
// and normalization; this module owns encrypted metadata and the change gate.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { err, ok, type Result } from "../frontmatter/types.js";
import { sha256Hex } from "../utils/hash.js";
import {
  readIntegrationState,
  resolveIntegrationStateKey,
  writeIntegrationState,
} from "./state.js";
import type {
  IntegrationConfig,
  IntegrationProviderConfig,
  ProviderName,
  ProviderState,
  SourceState,
} from "./types.js";

export interface AuthorizationRequest {
  provider: ProviderName;
  clientId: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

export interface CodeExchange {
  code: string;
  clientId: string;
  clientSecret: string;
  callbackNonce: string;
  pkceVerifier: string;
}

export interface ProviderTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt?: string;
}

export interface RefreshTokenRequest {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface WebhookChannel {
  id: string;
  secret: string;
  expiresAt?: string;
  verificationRequired?: boolean;
}

export interface EnsureWebhookInput {
  callbackUrl: string;
  now: Date;
  renewBefore: Date;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
  /** One-time route nonce for an unsigned manual provider verification request. */
  setupToken?: string;
}

export type RefreshHint =
  | { kind: "reconcile" }
  | { kind: "sources"; sourceIds: string[]; rediscover: boolean };

export type VerifiedWebhook =
  | { kind: "verification"; channel: WebhookChannel }
  | { kind: "event"; eventId: string; hint: RefreshHint };

export interface RemoteSource {
  id: string;
  revision: string;
}

export interface NormalizedRemoteSource extends RemoteSource {
  text: string;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  authorizationUrl(input: AuthorizationRequest): string;
  exchangeCode(input: CodeExchange): Promise<Result<ProviderTokens, Error>>;
  // Optional while existing provider adapters are migrated to the expanded
  // contract. The engine rejects an expired or webhook-enabled provider that
  // has not implemented the corresponding capability.
  refreshTokens?(input: RefreshTokenRequest): Promise<Result<ProviderTokens, Error>>;
  ensureWebhook?(
    state: ProviderState,
    input: EnsureWebhookInput,
  ): Promise<Result<WebhookChannel, Error>>;
  verifyWebhook?(
    input: WebhookRequest,
    state: ProviderState,
  ): Promise<Result<VerifiedWebhook, Error>>;
  discover(state: ProviderState): Promise<Result<RemoteSource[], Error>>;
  fetch(source: RemoteSource, state: ProviderState): Promise<Result<NormalizedRemoteSource, Error>>;
}

export interface DistillationInput {
  providerSourceId: string;
  revision: string;
  text: string;
}

export interface DistillationRun {
  runId: string;
}

export interface UnavailableSourceEvent {
  idempotencyKey: string;
  providerSourceId: string;
  reason: "no_longer_discovered";
  revision: string;
  occurredAt: string;
}

export interface EngineDeps {
  config: IntegrationConfig;
  environment: NodeJS.ProcessEnv;
  adapters: Partial<Record<ProviderName, ProviderAdapter>>;
  now?: () => Date;
  distill(input: DistillationInput): Promise<Result<DistillationRun, Error>>;
  recordUnavailable?(event: UnavailableSourceEvent): Result<void, Error>;
  writeIntegrationState?: typeof writeIntegrationState;
}

export interface ReconcileOutcome {
  distilledSourceIds: string[];
  unchangedSourceIds: string[];
  failedSourceIds: string[];
  unavailableSourceIds: string[];
}

export interface ContinuousAdapterCapabilityOptions {
  webhooksRequired: boolean;
}

const activeReconciliations = new Set<string>();

export function providerConfig(
  config: IntegrationConfig,
  provider: ProviderName,
): Result<IntegrationProviderConfig, Error> {
  const value = config[provider];
  if (value === undefined)
    return err(new Error(`integration provider ${provider} is not configured`));
  return ok(value);
}

// Migration keeps the new adapter methods optional at the type level so old
// adapters continue to compile. Serve validates this boundary at startup before
// it starts any continuous sync or webhook route.
export function validateContinuousAdapterCapabilities(
  adapter: ProviderAdapter,
  options: ContinuousAdapterCapabilityOptions,
): Result<void, Error> {
  if (adapter.refreshTokens === undefined) {
    return err(new Error(`integration provider ${adapter.name} lacks token refresh capability`));
  }
  if (options.webhooksRequired && adapter.ensureWebhook === undefined) {
    return err(new Error(`integration provider ${adapter.name} lacks webhook setup capability`));
  }
  if (options.webhooksRequired && adapter.verifyWebhook === undefined) {
    return err(
      new Error(`integration provider ${adapter.name} lacks webhook verification capability`),
    );
  }
  return ok(undefined);
}

export function configuredCredential(
  environment: NodeJS.ProcessEnv,
  name: string,
  label: string,
): Result<string, Error> {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    return err(new Error(`${label} environment variable ${name} is not set`));
  }
  return ok(value);
}

export function sourceIdentity(provider: ProviderName, sourceId: string): string {
  return `${provider}:${sourceId}`;
}

export function unavailableEventKey(
  provider: ProviderName,
  sourceId: string,
  revision: string,
): string {
  return `${sourceIdentity(provider, sourceId)}:${revision}`;
}

function timestamp(deps: EngineDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

function currentTime(deps: Pick<EngineDeps, "now">): Date {
  return (deps.now ?? (() => new Date()))();
}

function reconciliationKey(vaultRoot: string, provider: ProviderName): string {
  return `${vaultRoot}\u0000${provider}`;
}

function sourceState(
  source: NormalizedRemoteSource,
  previous: SourceState | undefined,
  lastSeenAt: string,
): SourceState {
  return {
    id: source.id,
    revision: source.revision,
    contentHash: previous?.contentHash ?? "",
    available: true,
    lastSeenAt,
    ...(previous?.lastDistillRunId === undefined
      ? {}
      : { lastDistillRunId: previous.lastDistillRunId }),
  };
}

function validRemoteSource(source: RemoteSource): boolean {
  return (
    typeof source.id === "string" &&
    source.id.length > 0 &&
    typeof source.revision === "string" &&
    source.revision.length > 0
  );
}

function writeState(
  vaultRoot: string,
  key: Buffer,
  state: Parameters<typeof writeIntegrationState>[1],
  deps: Pick<EngineDeps, "writeIntegrationState">,
): Result<void, Error> {
  return (deps.writeIntegrationState ?? writeIntegrationState)(vaultRoot, state, key);
}

function accessTokenExpired(state: ProviderState, deps: Pick<EngineDeps, "now">): boolean {
  if (state.accessTokenExpiresAt === undefined) return false;
  const expiration = Date.parse(state.accessTokenExpiresAt);
  return !Number.isFinite(expiration) || expiration <= currentTime(deps).getTime();
}

async function refreshExpiredTokens(
  vaultRoot: string,
  adapter: ProviderAdapter,
  key: Buffer,
  persisted: Parameters<typeof writeIntegrationState>[1],
  state: ProviderState,
  deps: EngineDeps,
): Promise<Result<ProviderState, Error>> {
  if (!accessTokenExpired(state, deps)) return ok(state);
  if (adapter.refreshTokens === undefined) {
    return err(new Error(`integration provider ${adapter.name} cannot refresh expired tokens`));
  }
  const configuration = providerConfig(deps.config, adapter.name);
  if (!configuration.ok) return configuration;
  const clientId = configuredCredential(
    deps.environment,
    configuration.value.clientIdEnv,
    `${adapter.name} OAuth client ID`,
  );
  if (!clientId.ok) return clientId;
  const clientSecret = configuredCredential(
    deps.environment,
    configuration.value.clientSecretEnv,
    `${adapter.name} OAuth client secret`,
  );
  if (!clientSecret.ok) return clientSecret;

  let refreshed: Result<ProviderTokens, Error>;
  try {
    refreshed = await adapter.refreshTokens({
      clientId: clientId.value,
      clientSecret: clientSecret.value,
      refreshToken: state.refreshToken,
    });
  } catch {
    return err(new Error(`integration provider ${adapter.name} token refresh failed`));
  }
  if (!refreshed.ok)
    return err(new Error(`integration provider ${adapter.name} token refresh failed`));
  if (refreshed.value.accessToken.length === 0 || refreshed.value.refreshToken.length === 0) {
    return err(
      new Error(`integration provider ${adapter.name} token refresh returned incomplete tokens`),
    );
  }

  const { accessTokenExpiresAt: _previousExpiration, ...unchanged } = state;
  const refreshedState: ProviderState = {
    ...unchanged,
    accessToken: refreshed.value.accessToken,
    refreshToken: refreshed.value.refreshToken,
    ...(refreshed.value.accessTokenExpiresAt === undefined
      ? {}
      : { accessTokenExpiresAt: refreshed.value.accessTokenExpiresAt }),
  };
  persisted.providers[adapter.name] = refreshedState;
  const written = writeState(vaultRoot, key, persisted, deps);
  if (!written.ok) return written;
  return ok(refreshedState);
}

function validWebhookChannel(channel: WebhookChannel): boolean {
  return (
    typeof channel.id === "string" &&
    channel.id.length > 0 &&
    typeof channel.secret === "string" &&
    channel.secret.length > 0 &&
    (channel.expiresAt === undefined || typeof channel.expiresAt === "string") &&
    (channel.verificationRequired === undefined ||
      typeof channel.verificationRequired === "boolean")
  );
}

function validRefreshHint(hint: RefreshHint): boolean {
  if (hint.kind === "reconcile") return true;
  return (
    hint.kind === "sources" &&
    Array.isArray(hint.sourceIds) &&
    hint.sourceIds.every((sourceId) => typeof sourceId === "string" && sourceId.length > 0) &&
    typeof hint.rediscover === "boolean"
  );
}

function validVerifiedWebhook(value: VerifiedWebhook): boolean {
  if (value.kind === "verification") return validWebhookChannel(value.channel);
  return (
    value.kind === "event" &&
    typeof value.eventId === "string" &&
    value.eventId.length > 0 &&
    validRefreshHint(value.hint)
  );
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function armProviderWebhookSetup(
  vaultRoot: string,
  provider: ProviderName,
  deps: Pick<EngineDeps, "config" | "environment" | "writeIntegrationState">,
  createToken: () => string = () => randomBytes(32).toString("base64url"),
): Result<{ setupToken: string }, Error> {
  const configured = providerConfig(deps.config, provider);
  if (!configured.ok) return configured;
  const key = resolveIntegrationStateKey(deps.config.encryptionKeyEnv, deps.environment);
  if (!key.ok) return key;
  const persisted = readIntegrationState(vaultRoot, key.value);
  if (!persisted.ok) return persisted;
  const providerState = persisted.value.providers[provider];
  if (providerState === undefined) {
    return err(new Error(`integration provider ${provider} is not authorized`));
  }
  if (providerState.webhook !== undefined) {
    return err(new Error(`integration provider ${provider} already has a webhook channel`));
  }
  const setupToken = createToken();
  if (typeof setupToken !== "string" || setupToken.length < 16) {
    return err(new Error("integration webhook setup token generation failed"));
  }
  providerState.webhookSetupToken = setupToken;
  const written = writeState(vaultRoot, key.value, persisted.value, deps);
  return written.ok ? ok({ setupToken }) : written;
}

export function readProviderWebhookVerificationToken(
  vaultRoot: string,
  provider: ProviderName,
  deps: Pick<EngineDeps, "config" | "environment">,
): Result<{ verificationToken: string }, Error> {
  const configured = providerConfig(deps.config, provider);
  if (!configured.ok) return configured;
  const key = resolveIntegrationStateKey(deps.config.encryptionKeyEnv, deps.environment);
  if (!key.ok) return key;
  const persisted = readIntegrationState(vaultRoot, key.value);
  if (!persisted.ok) return persisted;
  const providerState = persisted.value.providers[provider];
  const webhook = providerState?.webhook;
  if (webhook?.verificationRequired !== true) {
    return err(new Error(`integration provider ${provider} has no pending webhook verification`));
  }
  return ok({ verificationToken: webhook.secret });
}

export function confirmProviderWebhookVerification(
  vaultRoot: string,
  provider: ProviderName,
  deps: Pick<EngineDeps, "config" | "environment" | "writeIntegrationState">,
): Result<void, Error> {
  const configured = providerConfig(deps.config, provider);
  if (!configured.ok) return configured;
  const key = resolveIntegrationStateKey(deps.config.encryptionKeyEnv, deps.environment);
  if (!key.ok) return key;
  const persisted = readIntegrationState(vaultRoot, key.value);
  if (!persisted.ok) return persisted;
  const webhook = persisted.value.providers[provider]?.webhook;
  if (webhook?.verificationRequired !== true) {
    return err(new Error(`integration provider ${provider} has no pending webhook verification`));
  }
  webhook.verificationRequired = false;
  return writeState(vaultRoot, key.value, persisted.value, deps);
}

export async function reconcileProvider(
  vaultRoot: string,
  adapter: ProviderAdapter,
  deps: EngineDeps,
): Promise<Result<ReconcileOutcome, Error>> {
  const lockKey = reconciliationKey(vaultRoot, adapter.name);
  if (activeReconciliations.has(lockKey)) {
    return err(new Error(`integration provider ${adapter.name} is already reconciling`));
  }
  activeReconciliations.add(lockKey);

  try {
    const configured = providerConfig(deps.config, adapter.name);
    if (!configured.ok) return configured;
    const key = resolveIntegrationStateKey(deps.config.encryptionKeyEnv, deps.environment);
    if (!key.ok) return key;
    const persisted = readIntegrationState(vaultRoot, key.value);
    if (!persisted.ok) return persisted;
    let providerState = persisted.value.providers[adapter.name];
    if (providerState === undefined) {
      return err(new Error(`integration provider ${adapter.name} is not authorized`));
    }
    const refreshed = await refreshExpiredTokens(
      vaultRoot,
      adapter,
      key.value,
      persisted.value,
      providerState,
      deps,
    );
    if (!refreshed.ok) return refreshed;
    providerState = refreshed.value;

    let discovered: Result<RemoteSource[], Error>;
    try {
      discovered = await adapter.discover(providerState);
    } catch {
      return err(new Error(`integration provider ${adapter.name} discovery failed`));
    }
    if (!discovered.ok)
      return err(new Error(`integration provider ${adapter.name} discovery failed`));
    if (!discovered.value.every(validRemoteSource)) {
      return err(new Error(`integration provider ${adapter.name} returned an invalid source`));
    }

    const currentSources = new Map(discovered.value.map((source) => [source.id, source]));
    if (currentSources.size !== discovered.value.length) {
      return err(new Error(`integration provider ${adapter.name} returned duplicate source IDs`));
    }
    const outcome: ReconcileOutcome = {
      distilledSourceIds: [],
      unchangedSourceIds: [],
      failedSourceIds: [],
      unavailableSourceIds: [],
    };
    const seenAt = timestamp(deps);

    for (const [sourceId, previous] of Object.entries(providerState.sources)) {
      if (currentSources.has(sourceId) || !previous.available) continue;
      const providerSourceId = sourceIdentity(adapter.name, sourceId);
      if (deps.recordUnavailable !== undefined) {
        const recorded = deps.recordUnavailable({
          idempotencyKey: unavailableEventKey(adapter.name, sourceId, previous.revision),
          providerSourceId,
          reason: "no_longer_discovered",
          revision: previous.revision,
          occurredAt: seenAt,
        });
        if (!recorded.ok) return recorded;
      }
      providerState.sources[sourceId] = { ...previous, available: false, lastSeenAt: seenAt };
      const written = writeState(vaultRoot, key.value, persisted.value, deps);
      if (!written.ok) return written;
      outcome.unavailableSourceIds.push(providerSourceId);
    }

    for (const remote of discovered.value) {
      const providerSourceId = sourceIdentity(adapter.name, remote.id);
      let fetched: Result<NormalizedRemoteSource, Error>;
      try {
        fetched = await adapter.fetch(remote, providerState);
      } catch {
        outcome.failedSourceIds.push(providerSourceId);
        continue;
      }
      if (!fetched.ok || !validRemoteSource(fetched.ok ? fetched.value : remote)) {
        outcome.failedSourceIds.push(providerSourceId);
        continue;
      }
      if (fetched.value.id !== remote.id || fetched.value.revision !== remote.revision) {
        outcome.failedSourceIds.push(providerSourceId);
        continue;
      }

      const previous = providerState.sources[remote.id];
      const next = sourceState(fetched.value, previous, seenAt);
      providerState.sources[remote.id] = next;
      const contentHash = sha256Hex(fetched.value.text);
      if (previous?.contentHash === contentHash) {
        const written = writeState(vaultRoot, key.value, persisted.value, deps);
        if (!written.ok) return written;
        outcome.unchangedSourceIds.push(providerSourceId);
        continue;
      }

      const beforeDistill = writeState(vaultRoot, key.value, persisted.value, deps);
      if (!beforeDistill.ok) return beforeDistill;
      let distilled: Result<DistillationRun, Error>;
      try {
        distilled = await deps.distill({
          providerSourceId,
          revision: fetched.value.revision,
          text: fetched.value.text,
        });
      } catch {
        outcome.failedSourceIds.push(providerSourceId);
        continue;
      }
      if (!distilled.ok) {
        outcome.failedSourceIds.push(providerSourceId);
        continue;
      }
      providerState.sources[remote.id] = {
        ...next,
        contentHash,
        lastDistillRunId: distilled.value.runId,
      };
      const written = writeState(vaultRoot, key.value, persisted.value, deps);
      if (!written.ok) return written;
      outcome.distilledSourceIds.push(providerSourceId);
    }
    return ok(outcome);
  } finally {
    activeReconciliations.delete(lockKey);
  }
}

export async function ensureProviderWebhook(
  vaultRoot: string,
  adapter: ProviderAdapter,
  input: EnsureWebhookInput,
  deps: EngineDeps,
): Promise<Result<WebhookChannel, Error>> {
  if (adapter.ensureWebhook === undefined) {
    return err(new Error(`integration provider ${adapter.name} cannot ensure webhooks`));
  }
  const configured = providerConfig(deps.config, adapter.name);
  if (!configured.ok) return configured;
  const key = resolveIntegrationStateKey(deps.config.encryptionKeyEnv, deps.environment);
  if (!key.ok) return key;
  const persisted = readIntegrationState(vaultRoot, key.value);
  if (!persisted.ok) return persisted;
  let providerState = persisted.value.providers[adapter.name];
  if (providerState === undefined) {
    return err(new Error(`integration provider ${adapter.name} is not authorized`));
  }
  const refreshed = await refreshExpiredTokens(
    vaultRoot,
    adapter,
    key.value,
    persisted.value,
    providerState,
    deps,
  );
  if (!refreshed.ok) return refreshed;
  providerState = refreshed.value;

  let ensured: Result<WebhookChannel, Error>;
  try {
    ensured = await adapter.ensureWebhook(providerState, input);
  } catch {
    return err(new Error(`integration provider ${adapter.name} webhook setup failed`));
  }
  if (!ensured.ok)
    return err(new Error(`integration provider ${adapter.name} webhook setup failed`));
  if (!validWebhookChannel(ensured.value)) {
    return err(
      new Error(`integration provider ${adapter.name} webhook setup returned invalid channel`),
    );
  }
  providerState.webhook = ensured.value;
  const written = writeState(vaultRoot, key.value, persisted.value, deps);
  if (!written.ok) return written;
  return ok(ensured.value);
}

export async function verifyProviderWebhook(
  vaultRoot: string,
  adapter: ProviderAdapter,
  input: WebhookRequest,
  deps: EngineDeps,
): Promise<Result<VerifiedWebhook, Error>> {
  if (adapter.verifyWebhook === undefined) {
    return err(new Error(`integration provider ${adapter.name} cannot verify webhooks`));
  }
  const configured = providerConfig(deps.config, adapter.name);
  if (!configured.ok) return configured;
  const key = resolveIntegrationStateKey(deps.config.encryptionKeyEnv, deps.environment);
  if (!key.ok) return key;
  const persisted = readIntegrationState(vaultRoot, key.value);
  if (!persisted.ok) return persisted;
  const providerState = persisted.value.providers[adapter.name];
  if (providerState === undefined) {
    return err(new Error(`integration provider ${adapter.name} is not authorized`));
  }
  if (providerState.webhook === undefined) {
    const expected = providerState.webhookSetupToken;
    if (
      expected === undefined ||
      input.setupToken === undefined ||
      !equalSecret(input.setupToken, expected)
    ) {
      return err(new Error(`integration provider ${adapter.name} webhook setup is not armed`));
    }
  } else if (providerState.webhook.verificationRequired === true) {
    return err(
      new Error(`integration provider ${adapter.name} webhook verification is not confirmed`),
    );
  }

  let verified: Result<VerifiedWebhook, Error>;
  try {
    verified = await adapter.verifyWebhook(input, providerState);
  } catch {
    return err(new Error(`integration provider ${adapter.name} webhook verification failed`));
  }
  if (!verified.ok)
    return err(new Error(`integration provider ${adapter.name} webhook verification failed`));
  if (!validVerifiedWebhook(verified.value)) {
    return err(
      new Error(
        `integration provider ${adapter.name} webhook verification returned invalid result`,
      ),
    );
  }
  if (verified.value.kind === "verification") {
    if (providerState.webhook !== undefined) {
      return err(
        new Error(`integration provider ${adapter.name} webhook verification is already captured`),
      );
    }
    if (verified.value.channel.verificationRequired !== true) {
      return err(
        new Error(`integration provider ${adapter.name} returned an unsafe verification channel`),
      );
    }
    delete providerState.webhookSetupToken;
    providerState.webhook = verified.value.channel;
    const written = writeState(vaultRoot, key.value, persisted.value, deps);
    if (!written.ok) return written;
  }
  return ok(verified.value);
}

export function startPeriodicIntegrationSync(
  vaultRoot: string,
  adapters: ProviderAdapter[],
  deps: EngineDeps,
  intervalMinutes = deps.config.pollingIntervalMinutes,
): () => void {
  const intervalMilliseconds = intervalMinutes * 60_000;
  const timer = setInterval(() => {
    for (const adapter of adapters) {
      void reconcileProvider(vaultRoot, adapter, deps);
    }
  }, intervalMilliseconds);
  return () => clearInterval(timer);
}
