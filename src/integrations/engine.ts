// Provider-neutral reconciliation. Provider adapters own OAuth HTTP, discovery,
// and normalization; this module owns encrypted metadata and the change gate.

import { randomBytes } from "node:crypto";
import { err, ok, type Result } from "../frontmatter/types.js";
import { sha256Hex } from "../utils/hash.js";
import { TERMINAL_REFRESH_STATUSES, timingSafeSecretEqual } from "./http-json.js";
import {
  readIntegrationState,
  resolveIntegrationStateKey,
  withIntegrationStateLock,
  writeIntegrationState,
} from "./state.js";
import {
  type IntegrationConfig,
  type IntegrationProviderConfig,
  isSourceFailureReason,
  type ProviderAccount,
  type ProviderName,
  type ProviderState,
  type SourceFailureReason,
  type SourceState,
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
  /** Which remote account exchangeCode authenticated as. */
  account?: ProviderAccount;
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
  /** One channel can fan out to N provider-side subscriptions. */
  subscriptions?: Array<{ id: string; resource: string; expiresAt: string }>;
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
  /** Webhook validation token arrives as a query param for some providers. */
  query?: Record<string, string>;
}

export type RefreshHint =
  | { kind: "reconcile" }
  | { kind: "sources"; sourceIds: string[]; rediscover: boolean }
  | { kind: "lifecycle"; action: "reauthorize" | "recreate" | "reconcile" };

export type VerifiedWebhook =
  | { kind: "verification"; channel: WebhookChannel }
  | { kind: "event"; eventId: string; hint: RefreshHint }
  | { kind: "lifecycle"; eventId: string; action: "reauthorize" | "recreate" | "reconcile" };

export interface RemoteSource {
  id: string;
  revision: string;
}

export interface NormalizedRemoteSource extends RemoteSource {
  text: string;
}

/** The enrolling request context passed to an adapter's enrollment resolver. */
export interface EnrollmentContext {
  user: string;
  role: string;
  collection: string;
  includeSpeakerNotes: boolean;
}

/** A validated, pre-persistence enrollment produced by an adapter's resolver. */
export interface EnrollmentDraft {
  items: Array<{
    driveId: string;
    remoteId: string;
    kind: "item" | "container";
    label: string;
  }>;
  collection: string;
  includeSpeakerNotes: boolean;
}

/** The cost/preview estimate for an enrollment draft (design §12). */
export interface EnrollmentEstimate {
  eligible: number;
  skipped: Array<{ name: string; reason: string }>;
  bytes: number;
  byType: Record<string, number>;
  estimatedCalls: { low: number; expected: number; high: number };
  estimatedUsd?: { expected: number };
  collection: string;
  readers: string[];
  ratifiers: string[];
  warnings: string[];
}

/** Provider connection status surfaced to a status route (design §13). */
export type ProviderConnectionStatus =
  | { kind: "disconnected" }
  | { kind: "connected"; account: ProviderAccount }
  | { kind: "reconnect_required"; reason: string };

/** Provider webhook status surfaced to a status route (design §13). */
export type ProviderWebhookStatus =
  | { kind: "off" }
  | { kind: "active"; eventCount: number }
  | { kind: "degraded"; reason: string };

/** Per-enrollment state summary surfaced to a status route (design §13). */
export interface EnrollmentStatusSummary {
  id: string;
  label: string;
  sourceCount: number;
  failedSourceCount: number;
}

/** Per-source state summary surfaced to a status route (design §13). */
export interface SourceStatusSummary {
  id: string;
  available: boolean;
  lastSeenAt: string;
  lastFailure?: { at: string; reason: SourceFailureReason };
}

/** The provider-neutral status shape a status route renders (design §13). */
export interface ProviderStatus {
  connection: ProviderConnectionStatus;
  webhook: ProviderWebhookStatus;
  enrollments: EnrollmentStatusSummary[];
  sources: SourceStatusSummary[];
  lastCycle?: {
    at: string;
    distilled: number;
    unchanged: number;
    failed: number;
    unavailable: number;
  };
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  /** Manual providers use the armed verification flow instead of subscription APIs. */
  readonly webhookSetup?: "automatic" | "manual";
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
  // Provider-neutral optional surface (U5). Microsoft implements these
  // starting U12+; Google/Notion never provide them, so a route that needs
  // one 404s for those providers (see the capability-missing pattern in
  // routes.ts).
  /** Echoes a provider's webhook validation-challenge token, if this request is one. */
  answerWebhookChallenge?(input: WebhookRequest): string | undefined;
  /** Verifies a lifecycle (as opposed to a change) notification. */
  verifyLifecycleWebhook?(
    input: WebhookRequest,
    state: ProviderState,
  ): Promise<Result<VerifiedWebhook, Error>>;
  resolveEnrollment?(
    selection: unknown,
    state: ProviderState,
    ctx: EnrollmentContext,
  ): Promise<Result<EnrollmentDraft, Error>>;
  estimateEnrollment?(
    draft: EnrollmentDraft,
    state: ProviderState,
  ): Promise<Result<EnrollmentEstimate, Error>>;
  describeStatus?(state: ProviderState): ProviderStatus;
}

export interface DistillationInput {
  providerSourceId: string;
  revision: string;
  text: string;
  /**
   * Optional distill collection override (U3), forwarded unchanged to
   * DistillUpsertInput.collection. Unset ⇒ the default `distill` collection
   * — provider-neutral pass-through only; no Microsoft-specific logic here.
   * Existing providers (Google/Notion) simply never set it.
   */
  collection?: string;
}

export interface DistillationRun {
  runId: string;
}

export interface UnavailableSourceEvent {
  idempotencyKey: string;
  providerSourceId: string;
  reason: "no_longer_discovered" | "unenrolled";
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
  reconcileLimits?: Partial<ReconcileLimits>;
}

export interface ReconcileLimits {
  maxSources: number;
  maxSourceTextBytes: number;
  maxCycleTextBytes: number;
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
const activeWebhookVerifications = new Set<string>();
const DEFAULT_RECONCILE_LIMITS: ReconcileLimits = {
  maxSources: 10_000,
  maxSourceTextBytes: 8 * 1024 * 1024,
  maxCycleTextBytes: 64 * 1024 * 1024,
};

function reconcileLimits(deps: Pick<EngineDeps, "reconcileLimits">): ReconcileLimits {
  return { ...DEFAULT_RECONCILE_LIMITS, ...deps.reconcileLimits };
}

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

// Prefers a specific reason an adapter/extract error already carries (duck-typed,
// since ProviderAdapter.fetch returns a plain Error) over the generic stage name.
function failureReason(error: unknown, fallback: SourceFailureReason): SourceFailureReason {
  if (typeof error === "object" && error !== null) {
    const candidate = (error as { reason?: unknown }).reason;
    if (isSourceFailureReason(candidate)) return candidate;
  }
  return fallback;
}

function markSourceFailure(
  previous: SourceState | undefined,
  remoteId: string,
  revision: string,
  reason: SourceFailureReason,
  at: string,
): SourceState {
  return {
    ...(previous ?? {
      id: remoteId,
      revision,
      contentHash: "",
      available: true,
      lastSeenAt: at,
    }),
    // A source that fails every cycle is still attempted every cycle — advance
    // lastSeenAt/revision to reflect that attempt, so a status/staleness
    // surface reading this state doesn't read a month-old "last seen" for a
    // source that's actually failing daily. Retry logic already keys off the
    // freshly-discovered remote.revision passed in here, not off this stored
    // field, so this only fixes the stored reflection — no behavior change.
    revision,
    lastSeenAt: at,
    lastFailure: { at, reason },
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

// Positive-identification only: default to transient (no reconnect_required)
// unless a refresh failure is affirmatively an auth/consent rejection. A
// network-transport throw or a 5xx response is the textbook transient case —
// this function is never even consulted for the former (see the catch branch
// in refreshExpiredTokens) and returns false for the latter. Two ways a
// failure can be positively terminal:
//   1. A structured signal on the error — `.terminal === true`, or a
//      `.status` in {400, 401, 403}. This is the contract a future adapter
//      (e.g. Microsoft/U13) should emit for a precise signal instead of
//      relying on message sniffing.
//   2. A fallback for today's Google/Notion adapters, whose jsonResponse only
//      embeds the HTTP status in the Error message: a message naming a
//      400/401/403 status, or a known terminal OAuth error code
//      (invalid_grant, interaction_required, AADSTS70008 — Entra ID's
//      "consent required" code, the Microsoft analog of interaction_required).
// A missed terminal case degrades to "prior state retained, refresh retried
// next cycle" — a lesser evil than a false "please reconnect" prompt.
// TERMINAL_REFRESH_STATUSES lives in http-json.ts so an adapter (e.g.
// Microsoft) can import the same set it's classified against.
const TERMINAL_REFRESH_MESSAGE_PATTERN = /invalid_grant|interaction_required|AADSTS70008/i;

function isTerminalRefreshError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const signal = error as { terminal?: unknown; status?: unknown };
    if (signal.terminal === true) return true;
    if (typeof signal.status === "number" && TERMINAL_REFRESH_STATUSES.has(signal.status)) {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : "";
  if (TERMINAL_REFRESH_MESSAGE_PATTERN.test(message)) return true;
  const statusMatch = /\bstatus (\d{3})\b/.exec(message);
  return statusMatch !== null && TERMINAL_REFRESH_STATUSES.has(Number(statusMatch[1]));
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

  // Marks state only; it does not change which error refreshExpiredTokens
  // itself returns. Only called for a positively-identified terminal failure
  // — see isTerminalRefreshError.
  const markReconnectRequired = (reason: string): Result<ProviderState, Error> => {
    state.authorization = { status: "reconnect_required", at: timestamp(deps), reason };
    const written = writeState(vaultRoot, key, persisted, deps);
    if (!written.ok) return written;
    return err(new Error(`integration provider ${adapter.name} token refresh failed`));
  };

  let refreshed: Result<ProviderTokens, Error>;
  try {
    refreshed = await adapter.refreshTokens({
      clientId: clientId.value,
      clientSecret: clientSecret.value,
      refreshToken: state.refreshToken,
    });
  } catch {
    // A network-transport failure never reaches an HTTP response, so it can
    // never be positively identified as terminal — always transient: retain
    // state, retry next cycle.
    return err(new Error(`integration provider ${adapter.name} token refresh failed`));
  }
  if (!refreshed.ok) {
    if (isTerminalRefreshError(refreshed.error)) {
      return markReconnectRequired(refreshed.error.message);
    }
    // Transient (e.g. a 5xx from the token endpoint): prior state retained,
    // same as before this task — no reconnect prompt for a momentary blip.
    return err(new Error(`integration provider ${adapter.name} token refresh failed`));
  }
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
    authorization: { status: "ok", at: timestamp(deps) },
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
      typeof channel.verificationRequired === "boolean") &&
    (channel.subscriptions === undefined ||
      (Array.isArray(channel.subscriptions) &&
        channel.subscriptions.every(
          (subscription) =>
            typeof subscription.id === "string" &&
            subscription.id.length > 0 &&
            typeof subscription.resource === "string" &&
            subscription.resource.length > 0 &&
            typeof subscription.expiresAt === "string",
        )))
  );
}

function validRefreshHint(hint: RefreshHint): boolean {
  if (hint.kind === "reconcile") return true;
  if (hint.kind === "lifecycle") {
    return (
      hint.action === "reauthorize" || hint.action === "recreate" || hint.action === "reconcile"
    );
  }
  return (
    hint.kind === "sources" &&
    Array.isArray(hint.sourceIds) &&
    hint.sourceIds.every((sourceId) => typeof sourceId === "string" && sourceId.length > 0) &&
    typeof hint.rediscover === "boolean"
  );
}

function validVerifiedWebhook(value: VerifiedWebhook): boolean {
  if (value.kind === "verification") return validWebhookChannel(value.channel);
  if (value.kind === "event") {
    return (
      typeof value.eventId === "string" && value.eventId.length > 0 && validRefreshHint(value.hint)
    );
  }
  return (
    value.kind === "lifecycle" &&
    typeof value.eventId === "string" &&
    value.eventId.length > 0 &&
    (value.action === "reauthorize" || value.action === "recreate" || value.action === "reconcile")
  );
}

async function invokeWebhookVerification(
  adapter: ProviderAdapter,
  input: WebhookRequest,
  providerState: ProviderState,
): Promise<Result<VerifiedWebhook, Error>> {
  if (adapter.verifyWebhook === undefined) {
    return err(new Error(`integration provider ${adapter.name} cannot verify webhooks`));
  }
  let verified: Result<VerifiedWebhook, Error>;
  try {
    verified = await adapter.verifyWebhook(input, providerState);
  } catch {
    return err(new Error(`integration provider ${adapter.name} webhook verification failed`));
  }
  if (!verified.ok) {
    return err(new Error(`integration provider ${adapter.name} webhook verification failed`));
  }
  if (!validVerifiedWebhook(verified.value)) {
    return err(
      new Error(
        `integration provider ${adapter.name} webhook verification returned invalid result`,
      ),
    );
  }
  return verified;
}

export async function armProviderWebhookSetup(
  vaultRoot: string,
  provider: ProviderName,
  deps: Pick<EngineDeps, "config" | "environment" | "writeIntegrationState">,
  createToken: () => string = () => randomBytes(32).toString("base64url"),
): Promise<Result<{ setupToken: string }, Error>> {
  return withIntegrationStateLock(vaultRoot, () => {
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
  });
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

export async function confirmProviderWebhookVerification(
  vaultRoot: string,
  provider: ProviderName,
  deps: Pick<EngineDeps, "config" | "environment" | "writeIntegrationState">,
): Promise<Result<void, Error>> {
  return withIntegrationStateLock(vaultRoot, () => {
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
  });
}

export async function reconcileProvider(
  vaultRoot: string,
  adapter: ProviderAdapter,
  deps: EngineDeps,
  hint: RefreshHint = { kind: "reconcile" },
): Promise<Result<ReconcileOutcome, Error>> {
  const lockKey = reconciliationKey(vaultRoot, adapter.name);
  if (activeReconciliations.has(lockKey)) {
    return err(new Error(`integration provider ${adapter.name} is already reconciling`));
  }
  activeReconciliations.add(lockKey);

  try {
    return await withIntegrationStateLock(vaultRoot, async () => {
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

      const limits = reconcileLimits(deps);
      // A "lifecycle" hint reaching reconcileProvider directly (e.g. queued
      // but not intercepted before this drain) falls back to the same full
      // discovery a "reconcile" hint gets — conservative and lossless, since
      // this function has no lifecycle-action dispatch of its own (that's a
      // later unit's job; see the route-side queueing in routes.ts).
      const shouldDiscover = hint.kind !== "sources" || hint.rediscover;
      const previousCursor = providerState.cursor;
      let discovered: Result<RemoteSource[], Error>;
      if (hint.kind === "sources" && !hint.rediscover) {
        discovered = ok(
          [...new Set(hint.sourceIds)].map((sourceId) => ({
            id: sourceId,
            revision: providerState.sources[sourceId]?.revision ?? "targeted-refresh",
          })),
        );
      } else {
        try {
          discovered = await adapter.discover(providerState);
        } catch {
          return err(new Error(`integration provider ${adapter.name} discovery failed`));
        }
        if (!discovered.ok)
          return err(new Error(`integration provider ${adapter.name} discovery failed`));
      }
      if (!discovered.ok) {
        return err(new Error(`integration provider ${adapter.name} discovery failed`));
      }
      const discoveredCursor = providerState.cursor;
      // Discovery adapters may advance a remote change cursor. Keep that
      // cursor provisional until every source in this page has been handled;
      // all intermediate state writes must retain the replayable cursor.
      providerState.cursor = previousCursor;
      if (!discovered.value.every(validRemoteSource)) {
        return err(new Error(`integration provider ${adapter.name} returned an invalid source`));
      }
      if (discovered.value.length > limits.maxSources) {
        return err(new Error(`integration provider ${adapter.name} returned too many sources`));
      }

      const allDiscoveredSources = new Map(discovered.value.map((source) => [source.id, source]));
      if (allDiscoveredSources.size !== discovered.value.length) {
        return err(new Error(`integration provider ${adapter.name} returned duplicate source IDs`));
      }
      const sourceScope = hint.kind === "sources" ? new Set(hint.sourceIds) : undefined;
      const currentSources =
        sourceScope === undefined
          ? allDiscoveredSources
          : new Map([...allDiscoveredSources].filter(([sourceId]) => sourceScope.has(sourceId)));
      const outcome: ReconcileOutcome = {
        distilledSourceIds: [],
        unchangedSourceIds: [],
        failedSourceIds: [],
        unavailableSourceIds: [],
      };
      const seenAt = timestamp(deps);

      for (const [sourceId, previous] of Object.entries(providerState.sources)) {
        const inAvailabilityScope =
          sourceScope === undefined ||
          (hint.kind === "sources" && hint.rediscover && sourceScope.has(sourceId));
        if (!inAvailabilityScope || currentSources.has(sourceId) || !previous.available) continue;
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

      let cycleTextBytes = 0;
      const scopedSources = [...currentSources.values()];
      for (const [index, remote] of scopedSources.entries()) {
        const providerSourceId = sourceIdentity(adapter.name, remote.id);
        const previous = providerState.sources[remote.id];
        const targetedWithoutDiscovery = hint.kind === "sources" && !hint.rediscover;
        if (
          !targetedWithoutDiscovery &&
          previous?.available === true &&
          previous.revision === remote.revision &&
          previous.contentHash.length > 0
        ) {
          providerState.sources[remote.id] = {
            ...previous,
            lastSeenAt: seenAt,
            lastFailure: undefined,
          };
          const written = writeState(vaultRoot, key.value, persisted.value, deps);
          if (!written.ok) return written;
          outcome.unchangedSourceIds.push(providerSourceId);
          continue;
        }
        let fetched: Result<NormalizedRemoteSource, Error>;
        try {
          fetched = await adapter.fetch(remote, providerState);
        } catch (error) {
          providerState.sources[remote.id] = markSourceFailure(
            previous,
            remote.id,
            remote.revision,
            failureReason(error, "fetch"),
            seenAt,
          );
          outcome.failedSourceIds.push(providerSourceId);
          continue;
        }
        if (
          !fetched.ok ||
          !validRemoteSource(fetched.ok ? fetched.value : remote) ||
          typeof fetched.value.text !== "string"
        ) {
          providerState.sources[remote.id] = markSourceFailure(
            previous,
            remote.id,
            remote.revision,
            fetched.ok ? "fetch" : failureReason(fetched.error, "fetch"),
            seenAt,
          );
          outcome.failedSourceIds.push(providerSourceId);
          continue;
        }
        if (
          fetched.value.id !== remote.id ||
          (!targetedWithoutDiscovery && fetched.value.revision !== remote.revision)
        ) {
          providerState.sources[remote.id] = markSourceFailure(
            previous,
            remote.id,
            remote.revision,
            "fetch",
            seenAt,
          );
          outcome.failedSourceIds.push(providerSourceId);
          continue;
        }

        const textBytes = Buffer.byteLength(fetched.value.text, "utf8");
        if (
          textBytes > limits.maxSourceTextBytes ||
          cycleTextBytes + textBytes > limits.maxCycleTextBytes
        ) {
          providerState.sources[remote.id] = markSourceFailure(
            previous,
            remote.id,
            remote.revision,
            "limit",
            seenAt,
          );
          outcome.failedSourceIds.push(providerSourceId);
          if (cycleTextBytes + textBytes > limits.maxCycleTextBytes) {
            for (const remaining of scopedSources.slice(index + 1)) {
              providerState.sources[remaining.id] = markSourceFailure(
                providerState.sources[remaining.id],
                remaining.id,
                remaining.revision,
                "limit",
                seenAt,
              );
              outcome.failedSourceIds.push(sourceIdentity(adapter.name, remaining.id));
            }
            break;
          }
          continue;
        }
        cycleTextBytes += textBytes;
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
        } catch (error) {
          providerState.sources[remote.id] = {
            ...next,
            lastFailure: { at: seenAt, reason: failureReason(error, "distill") },
          };
          outcome.failedSourceIds.push(providerSourceId);
          continue;
        }
        if (!distilled.ok) {
          providerState.sources[remote.id] = {
            ...next,
            lastFailure: { at: seenAt, reason: failureReason(distilled.error, "distill") },
          };
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

      if (shouldDiscover && outcome.failedSourceIds.length === 0) {
        providerState.cursor = discoveredCursor;
      }
      const finalStateWritten = writeState(vaultRoot, key.value, persisted.value, deps);
      if (!finalStateWritten.ok) return finalStateWritten;
      return ok(outcome);
    });
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
  return withIntegrationStateLock(vaultRoot, async () => {
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
  });
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
  const snapshot = readIntegrationState(vaultRoot, key.value);
  if (!snapshot.ok) return snapshot;
  const snapshotProvider = snapshot.value.providers[adapter.name];
  if (snapshotProvider === undefined) {
    return err(new Error(`integration provider ${adapter.name} is not authorized`));
  }

  // Configured signed events only consume an atomic encrypted-state snapshot.
  // They neither wait for reconciliation's read/await/write transaction nor
  // exclude another independently valid event verification.
  if (snapshotProvider.webhook !== undefined) {
    if (snapshotProvider.webhook.verificationRequired === true) {
      return err(
        new Error(`integration provider ${adapter.name} webhook verification is not confirmed`),
      );
    }
    const verified = await invokeWebhookVerification(adapter, input, snapshotProvider);
    if (!verified.ok) return verified;
    if (verified.value.kind !== "event") {
      return err(
        new Error(`integration provider ${adapter.name} webhook verification is already captured`),
      );
    }
    return verified;
  }

  // Unsigned manual capture consumes the armed nonce and writes a secret, so
  // it remains a serialized single-writer transaction.
  const lockKey = reconciliationKey(vaultRoot, adapter.name);
  if (activeWebhookVerifications.has(lockKey)) {
    return err(new Error(`integration provider ${adapter.name} webhook verification is busy`));
  }
  activeWebhookVerifications.add(lockKey);
  try {
    return await withIntegrationStateLock(vaultRoot, async () => {
      const persisted = readIntegrationState(vaultRoot, key.value);
      if (!persisted.ok) return persisted;
      const providerState = persisted.value.providers[adapter.name];
      if (providerState === undefined) {
        return err(new Error(`integration provider ${adapter.name} is not authorized`));
      }
      if (providerState.webhook !== undefined) {
        return err(
          new Error(
            `integration provider ${adapter.name} webhook verification is already captured`,
          ),
        );
      }
      const expected = providerState.webhookSetupToken;
      if (
        expected === undefined ||
        input.setupToken === undefined ||
        !timingSafeSecretEqual(input.setupToken, expected)
      ) {
        return err(new Error(`integration provider ${adapter.name} webhook setup is not armed`));
      }

      const verified = await invokeWebhookVerification(adapter, input, providerState);
      if (!verified.ok) return verified;
      if (verified.value.kind !== "verification") {
        return err(
          new Error(`integration provider ${adapter.name} webhook setup did not verify a channel`),
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
      return ok(verified.value);
    });
  } finally {
    activeWebhookVerifications.delete(lockKey);
  }
}

export async function verifyProviderLifecycleWebhook(
  vaultRoot: string,
  adapter: ProviderAdapter,
  input: WebhookRequest,
  deps: EngineDeps,
): Promise<Result<Extract<VerifiedWebhook, { kind: "lifecycle" }>, Error>> {
  if (adapter.verifyLifecycleWebhook === undefined) {
    return err(new Error(`integration provider ${adapter.name} cannot verify lifecycle webhooks`));
  }
  const configured = providerConfig(deps.config, adapter.name);
  if (!configured.ok) return configured;
  const key = resolveIntegrationStateKey(deps.config.encryptionKeyEnv, deps.environment);
  if (!key.ok) return key;
  const snapshot = readIntegrationState(vaultRoot, key.value);
  if (!snapshot.ok) return snapshot;
  const snapshotProvider = snapshot.value.providers[adapter.name];
  if (snapshotProvider === undefined) {
    return err(new Error(`integration provider ${adapter.name} is not authorized`));
  }

  let verified: Result<VerifiedWebhook, Error>;
  try {
    verified = await adapter.verifyLifecycleWebhook(input, snapshotProvider);
  } catch {
    return err(new Error(`integration provider ${adapter.name} lifecycle verification failed`));
  }
  if (!verified.ok) {
    return err(new Error(`integration provider ${adapter.name} lifecycle verification failed`));
  }
  const value = verified.value;
  if (!validVerifiedWebhook(value) || value.kind !== "lifecycle") {
    return err(
      new Error(
        `integration provider ${adapter.name} lifecycle verification returned invalid result`,
      ),
    );
  }
  return ok(value);
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
