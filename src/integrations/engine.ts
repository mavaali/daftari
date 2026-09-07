// Provider-neutral reconciliation. Provider adapters own OAuth HTTP, discovery,
// and normalization; this module owns encrypted metadata and the change gate.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { canWrite } from "../access/rbac.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import type { RoleConfig } from "../utils/config.js";
import { sha256Hex } from "../utils/hash.js";
import { TERMINAL_REFRESH_STATUSES, timingSafeSecretEqual } from "./http-json.js";
import {
  readIntegrationState,
  resolveIntegrationStateKey,
  withIntegrationStateLock,
  writeIntegrationState,
} from "./state.js";
import {
  type EnrollmentRecord,
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
  /**
   * Query parameters from the webhook request URL. Used to correlate a
   * synchronous create-time validation handshake (Graph, #507) with the
   * pending channel it is answering (see `pending_token` in
   * `ensureProviderWebhook`/`verifyProviderWebhook`), and passed through
   * opaquely so a provider's `verifyWebhook` can read its own
   * protocol-specific parameters (e.g. Graph's `validationToken`).
   */
  query?: Record<string, string>;
}

export type RefreshHint =
  | { kind: "reconcile" }
  | { kind: "sources"; sourceIds: string[]; rediscover: boolean }
  | { kind: "lifecycle"; action: "reauthorize" | "recreate" | "reconcile" };

export type VerifiedWebhook =
  | {
      kind: "verification";
      channel: WebhookChannel;
      /**
       * Raw body to echo back verbatim instead of the default JSON
       * acknowledgement — Graph's create-time validation handshake (#507)
       * requires the exact `validationToken` value echoed as `text/plain`.
       */
      respondBody?: string;
      respondContentType?: string;
    }
  | { kind: "event"; eventId: string; hint: RefreshHint }
  | { kind: "lifecycle"; eventId: string; action: "reauthorize" | "recreate" | "reconcile" };

/** Untrusted, operator-picked enrollment input before server-side validation. */
export type EnrollmentCandidate = Omit<EnrollmentRecord, "enrolledAt" | "enrolledBy">;

export interface RemoteSource {
  id: string;
  revision: string;
  /**
   * Ref of the EnrollmentRecord that owns this source (#506). Defaults to
   * `id` when absent — correct for a directly-enrolled file, whose own ref
   * IS its id. A folder-enrolled provider whose discovered descendant ids
   * differ from their owning folder's ref must set this explicitly; the
   * engine never infers folder membership itself (adapterData is opaque).
   */
  enrolledRef?: string;
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
    webUrl?: string;
    /**
     * Cached metadata size (bytes) for an "item" kind, captured by the
     * resolver's own metadata re-fetch — lets estimateEnrollment skip a
     * redundant Graph round-trip for the common resolve-then-estimate
     * preview flow. Optional: a caller that POSTs a bare draft straight to
     * an /estimate route without this cached data still works via a
     * stateless fallback (a fresh metadata fetch).
     */
    size?: number;
    /**
     * Cached, already-expanded eligible children for a "container" kind
     * (the folder-scoped delta walk the resolver already performed to
     * enforce the per-container bound) — same rationale as `size` above.
     * Optional for the same stateless-fallback reason.
     */
    children?: Array<{ id: string; name: string; size: number }>;
  }>;
  collection: string;
  includeSpeakerNotes: boolean;
  /** The roles that may read `collection` at resolve time (design §9.2 audience disclosure). */
  readersAtEnrollment: string[];
  /**
   * Picker references rejected by name — unreadable, unsupported, or
   * malformed (R12). This reason vocabulary (`not_readable`,
   * `invalid_reference`, `unsupported_type`, `malware`, ...) is a
   * PREVIEW-only space, distinct from `SourceFailureReason` — never pass one
   * of these strings to `isSourceFailureReason`.
   */
  skipped: Array<{ name: string; reason: string }>;
}

/** The cost/preview estimate for an enrollment draft (design §12). */
export interface EnrollmentEstimate {
  eligible: number;
  /** Same PREVIEW-only reason vocabulary as EnrollmentDraft.skipped above — not SourceFailureReason. */
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
  | {
      kind: "active";
      eventCount: number;
      /** Earliest `expiresAt` across `ProviderState.webhook.subscriptions` (ISO string). */
      earliestExpiry?: string;
    }
  | { kind: "degraded"; reason: string };

/** The §13 per-source lifecycle state, derived from real SourceState fields. */
export const SOURCE_STATUS_STATES = [
  "pending",
  "current",
  "failed",
  "unavailable",
  "over_limit",
] as const;

export type SourceStatusState = (typeof SOURCE_STATUS_STATES)[number];

/** Per-enrollment state summary surfaced to a status route (design §13). */
export interface EnrollmentStatusSummary {
  id: string;
  label: string;
  collection: string;
  sourceCount: number;
  failedSourceCount: number;
  /** Per-state breakdown of this enrollment's sources (design §13). */
  counts: Record<SourceStatusState, number>;
}

/** Per-source state summary surfaced to a status route (design §13). */
export interface SourceStatusSummary {
  id: string;
  available: boolean;
  /**
   * Best-available proxy for "since" when `state` is `unavailable` —
   * SourceState carries no dedicated became-unavailable timestamp, so this
   * is the last time the source was actually seen, not a marked
   * unavailable-since instant.
   */
  lastSeenAt: string;
  lastFailure?: { at: string; reason: SourceFailureReason };
  state: SourceStatusState;
}

/** The provider-neutral status shape a status route renders (design §13). */
export interface ProviderStatus {
  connection: ProviderConnectionStatus;
  webhook: ProviderWebhookStatus;
  enrollments: EnrollmentStatusSummary[];
  sources: SourceStatusSummary[];
  /**
   * Constant V1 disclosure (R34): no provider adapter checks sensitivity
   * labels yet, so every describeStatus() implementation reports the same
   * fixed string rather than a per-source computed value.
   */
  sensitivityLabels: "not checked (V1)";
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
  // Optional fast-path check so ensureProviderWebhook can skip minting and
  // persisting a pendingWebhook (and the matching phase-3 write) when the
  // existing webhook is already fresh — the common case on every polling
  // cycle. Absent, or returning true, keeps the unconditional two-phase flow.
  needsWebhookRenewal?(state: ProviderState, input: EnsureWebhookInput): boolean;
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
  /** The owning EnrollmentRecord's targetCollection (#506); absent for google/notion. */
  targetCollection?: string;
}

export interface DistillationRun {
  runId: string;
}

// The review queue distinguishes an operator's un-enrollment from the remote
// side taking a source away; the engine's availability sweep only ever emits
// "no_longer_discovered", the other reasons come from adapters and routes.
export type UnavailableSourceReason =
  | "no_longer_discovered"
  | "access_denied"
  | "deleted"
  | "unenrolled";

export interface UnavailableSourceEvent {
  idempotencyKey: string;
  providerSourceId: string;
  reason: UnavailableSourceReason;
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
  /** Soft wall-time cap: stop starting new fetches, commit what is done. */
  maxCycleMs: number;
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
  maxCycleMs: Number.POSITIVE_INFINITY,
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

// Stage-time write gate for enrollment (#506) — the same rationale as
// vault_stage_action's own gate (docs/architecture.md "Stage-time write
// gate"): manage_integrations alone must not let an operator aim distilled
// proposals at a collection the serve process cannot write to. #509's
// enroll route calls this before persisting an EnrollmentRecord.
export function requireCollectionWriteAccess(
  role: RoleConfig | null,
  targetCollection: string,
): Result<void, Error> {
  if (!canWrite(role, targetCollection)) {
    return err(new Error(`the serve process cannot write to collection "${targetCollection}"`));
  }
  return ok(undefined);
}

// The EnrollmentRecord that owns a discovered source: an exact ref match for
// a directly-enrolled file, or the adapter-attested owner (RemoteSource
// .enrolledRef) for a folder descendant. Absent enrollment (google/notion)
// or no match ⇒ undefined, so targetCollection is never set for them.
function owningEnrollment(
  enrollment: EnrollmentRecord[] | undefined,
  remote: RemoteSource,
): EnrollmentRecord | undefined {
  if (enrollment === undefined) return undefined;
  const ownerRef = remote.enrolledRef ?? remote.id;
  return enrollment.find((record) => record.ref === ownerRef);
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

// Adapters may mutate adapterData in place during discovery (delta links,
// subscription bookkeeping), so a replayable snapshot must be a deep copy.
function snapshotAdapterData(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return value === undefined ? undefined : structuredClone(value);
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
  if (value.kind === "verification") {
    return (
      validWebhookChannel(value.channel) &&
      (value.respondBody === undefined || typeof value.respondBody === "string") &&
      (value.respondContentType === undefined || typeof value.respondContentType === "string")
    );
  }
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

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function mintPendingWebhook(): { nonce: string; secret: string } {
  return {
    nonce: randomBytes(16).toString("base64url"),
    secret: randomBytes(32).toString("base64url"),
  };
}

function withPendingToken(callbackUrl: string, nonce: string): Result<string, Error> {
  try {
    const url = new URL(callbackUrl);
    url.searchParams.set("pending_token", nonce);
    return ok(url.toString());
  } catch {
    return err(new Error("integration webhook callback URL is invalid"));
  }
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
      const cycleStart = currentTime(deps).getTime();
      // A "lifecycle" hint reaching reconcileProvider directly (e.g. queued
      // but not intercepted before this drain) falls back to the same full
      // discovery a "reconcile" hint gets — conservative and lossless, since
      // this function has no lifecycle-action dispatch of its own (that's a
      // later unit's job; see the route-side queueing in routes.ts).
      const shouldDiscover = hint.kind !== "sources" || hint.rediscover;
      const previousCursor = providerState.cursor;
      const previousAdapterData = snapshotAdapterData(providerState.adapterData);
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
      const discoveredAdapterData = providerState.adapterData;
      // Discovery adapters may advance a remote change cursor or their opaque
      // adapterData (per-drive delta links behave exactly like a cursor). Keep
      // both provisional until every source in this page has been handled;
      // all intermediate state writes must retain the replayable values.
      providerState.cursor = previousCursor;
      providerState.adapterData = previousAdapterData;
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
        if (currentTime(deps).getTime() - cycleStart > limits.maxCycleMs) {
          outcome.failedSourceIds.push(providerSourceId);
          for (const remaining of scopedSources.slice(index + 1)) {
            outcome.failedSourceIds.push(sourceIdentity(adapter.name, remaining.id));
          }
          break;
        }
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
        const contentHash = sha256Hex(fetched.value.text);
        if (previous?.contentHash === contentHash) {
          providerState.sources[remote.id] = next;
          const written = writeState(vaultRoot, key.value, persisted.value, deps);
          if (!written.ok) return written;
          outcome.unchangedSourceIds.push(providerSourceId);
          continue;
        }

        // A nonempty hash certifies successful processing of this revision.
        // Persist the observed revision as pending until distillation succeeds,
        // so failures (including process exit) retry just like a new source.
        providerState.sources[remote.id] = { ...next, contentHash: "" };
        const beforeDistill = writeState(vaultRoot, key.value, persisted.value, deps);
        if (!beforeDistill.ok) return beforeDistill;
        const owner = owningEnrollment(providerState.enrollment, remote);
        let distilled: Result<DistillationRun, Error>;
        try {
          distilled = await deps.distill({
            providerSourceId,
            revision: fetched.value.revision,
            text: fetched.value.text,
            ...(owner === undefined ? {} : { targetCollection: owner.targetCollection }),
          });
        } catch (error) {
          // Keep the revision pending (empty hash) so a later cycle retries it,
          // just like the pre-distill write above — a non-empty hash would let
          // the skip-guard treat this unprocessed revision as already done.
          providerState.sources[remote.id] = {
            ...next,
            contentHash: "",
            lastFailure: { at: seenAt, reason: failureReason(error, "distill") },
          };
          outcome.failedSourceIds.push(providerSourceId);
          continue;
        }
        if (!distilled.ok) {
          providerState.sources[remote.id] = {
            ...next,
            contentHash: "",
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
        providerState.adapterData = discoveredAdapterData;
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
  if (adapter.ensureWebhook === undefined) {
    return err(new Error(`integration provider ${adapter.name} cannot ensure webhooks`));
  }

  // Phase 1 (under the lock): refresh tokens if needed, then mint and
  // persist a pending channel. The lock is released before calling the
  // provider — Graph validates the notification URL synchronously *during*
  // subscription creation, and holding the lock across that call would
  // block every other state-locked operation (reconciliation, webhook
  // verification, OAuth) for as long as the provider's create call takes.
  // A stale pending channel from an interrupted prior attempt is simply
  // overwritten here.
  //
  // When the adapter can tell us the existing webhook is already fresh
  // (the steady-state case on every polling cycle), skip minting/persisting
  // a pendingWebhook entirely and short-circuit to a direct, single
  // ensureWebhook call — nothing changes, so there is nothing to write.
  const prepared = await withIntegrationStateLock(vaultRoot, async () => {
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

    if (adapter.needsWebhookRenewal?.(providerState, input) === false) {
      return ok({ key: key.value, providerState, pending: undefined });
    }

    const pending = mintPendingWebhook();
    providerState.pendingWebhook = pending;
    const written = writeState(vaultRoot, key.value, persisted.value, deps);
    if (!written.ok) return written;
    return ok({ key: key.value, providerState, pending });
  });
  if (!prepared.ok) return prepared;
  const { key, providerState, pending } = prepared.value;

  if (pending === undefined) {
    let ensured: Result<WebhookChannel, Error>;
    try {
      ensured = await adapter.ensureWebhook(providerState, input);
    } catch {
      ensured = err(new Error(`integration provider ${adapter.name} webhook setup failed`));
    }
    if (!ensured.ok) {
      return err(new Error(`integration provider ${adapter.name} webhook setup failed`));
    }
    if (!validWebhookChannel(ensured.value)) {
      return err(
        new Error(`integration provider ${adapter.name} webhook setup returned invalid channel`),
      );
    }
    return ok(ensured.value);
  }

  // Phase 2 (outside the lock): call the provider. A synchronous validation
  // request the provider makes mid-call is answered by verifyProviderWebhook
  // against `providerState.pendingWebhook`, set up in phase 1. A malformed
  // callback URL is treated the same as any other phase-2 failure — it
  // still needs phase 3 to clear the pendingWebhook minted above, not an
  // early return that would leave it orphaned in state.
  const callbackUrl = withPendingToken(input.callbackUrl, pending.nonce);
  let ensured: Result<WebhookChannel, Error>;
  if (!callbackUrl.ok) {
    ensured = callbackUrl;
  } else {
    try {
      ensured = await adapter.ensureWebhook(providerState, {
        ...input,
        callbackUrl: callbackUrl.value,
      });
    } catch {
      ensured = err(new Error(`integration provider ${adapter.name} webhook setup failed`));
    }
    if (!ensured.ok) {
      ensured = err(new Error(`integration provider ${adapter.name} webhook setup failed`));
    } else if (!validWebhookChannel(ensured.value)) {
      ensured = err(
        new Error(`integration provider ${adapter.name} webhook setup returned invalid channel`),
      );
    }
  }

  // Phase 3 (under the lock): record the outcome. State is re-read rather
  // than reusing the phase-1 snapshot, since reconciliation or another
  // request may have changed unrelated fields meanwhile. pendingWebhook is
  // only cleared if it is still the one this call minted — a newer,
  // concurrent ensure may have already superseded it.
  return withIntegrationStateLock(vaultRoot, () => {
    const persisted = readIntegrationState(vaultRoot, key);
    if (!persisted.ok) return persisted;
    const currentState = persisted.value.providers[adapter.name];
    if (currentState === undefined) {
      return err(new Error(`integration provider ${adapter.name} is not authorized`));
    }
    if (currentState.pendingWebhook?.nonce === pending.nonce) {
      delete currentState.pendingWebhook;
    }
    if (ensured.ok) currentState.webhook = ensured.value;
    const written = writeState(vaultRoot, key, persisted.value, deps);
    if (!written.ok) return written;
    return ensured;
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

  // Two-phase webhook creation (#507): an automatic provider (Graph) may
  // validate the notification URL synchronously during subscription
  // creation, before ensureProviderWebhook's phase 2 has returned and has
  // anything to commit. The pending token baked into the callback URL by
  // ensureProviderWebhook correlates this request to that specific
  // in-flight attempt, so a stale or mismatched token falls through to the
  // branches below instead of being treated as a validation.
  //
  // The registered callback URL keeps carrying that same pending token for
  // every future notification too, not just the validation handshake — the
  // provider notifies whatever URL it was given at subscription-creation
  // time, unscrubbed, for as long as the subscription lives. So a genuine
  // event can legitimately arrive here with a matching pending token, in
  // the narrow window between phase 2 returning and phase 3 clearing
  // pendingWebhook under the lock. This branch does not decide validation
  // vs. event itself — it forwards whatever the adapter's own protocol
  // parsing determines and writes nothing either way; treating a
  // `kind: "event"` result as an error here would silently drop that event
  // instead of letting it reach the queue.
  const pendingToken = input.query?.pending_token;
  if (
    pendingToken !== undefined &&
    snapshotProvider.pendingWebhook !== undefined &&
    equalSecret(snapshotProvider.pendingWebhook.nonce, pendingToken)
  ) {
    return invokeWebhookVerification(adapter, input, snapshotProvider);
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
