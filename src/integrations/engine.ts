// Provider-neutral reconciliation. Provider adapters own OAuth HTTP, discovery,
// and normalization; this module owns encrypted metadata and the change gate.

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
}

export interface ReconcileOutcome {
  distilledSourceIds: string[];
  unchangedSourceIds: string[];
  failedSourceIds: string[];
  unavailableSourceIds: string[];
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

function timestamp(deps: EngineDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString();
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
): Result<void, Error> {
  return writeIntegrationState(vaultRoot, state, key);
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
    const providerState = persisted.value.providers[adapter.name];
    if (providerState === undefined) {
      return err(new Error(`integration provider ${adapter.name} is not authorized`));
    }

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
      providerState.sources[sourceId] = { ...previous, available: false, lastSeenAt: seenAt };
      const written = writeState(vaultRoot, key.value, persisted.value);
      if (!written.ok) return written;
      const providerSourceId = sourceIdentity(adapter.name, sourceId);
      if (deps.recordUnavailable !== undefined) {
        const recorded = deps.recordUnavailable({
          providerSourceId,
          reason: "no_longer_discovered",
          revision: previous.revision,
          occurredAt: seenAt,
        });
        if (!recorded.ok) return recorded;
      }
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
        const written = writeState(vaultRoot, key.value, persisted.value);
        if (!written.ok) return written;
        outcome.unchangedSourceIds.push(providerSourceId);
        continue;
      }

      const beforeDistill = writeState(vaultRoot, key.value, persisted.value);
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
      const written = writeState(vaultRoot, key.value, persisted.value);
      if (!written.ok) return written;
      outcome.distilledSourceIds.push(providerSourceId);
    }
    return ok(outcome);
  } finally {
    activeReconciliations.delete(lockKey);
  }
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
