// Shared, provider-neutral integration state. Source text never appears in
// these types: connector state records only credentials and change metadata.

export const PROVIDER_NAMES = ["google", "notion", "m365"] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export function isProviderName(value: unknown): value is ProviderName {
  return (PROVIDER_NAMES as readonly unknown[]).includes(value);
}

export interface IntegrationProviderConfig {
  clientIdEnv: string;
  clientSecretEnv: string;
}

// The `integrations.m365` block (U11) carries extra keys beyond the shared
// client_id_env/client_secret_env pair that Google/Notion use. The
// parsed/normalized shape always carries concrete `scopeProfile` and
// `includeSpeakerNotes` values — the config loader (src/utils/config.ts)
// applies their defaults, so downstream code never has to.
export interface MicrosoftProviderConfig extends IntegrationProviderConfig {
  /** Entra tenant GUID or verified domain; used to build the authority URL. */
  tenantId: string;
  /** Default "sharepoint" when omitted from config. */
  scopeProfile: "onedrive" | "sharepoint";
  /** The allowlist of enrollment target collections. */
  collections: string[];
  /** Default true when omitted from config. */
  includeSpeakerNotes: boolean;
  pickerHost?: string;
}

export interface IntegrationConfig {
  encryptionKeyEnv: string;
  pollingIntervalMinutes: number;
  google?: IntegrationProviderConfig;
  notion?: IntegrationProviderConfig;
  m365?: MicrosoftProviderConfig;
}

export const SOURCE_FAILURE_REASONS = [
  "too_large",
  "encrypted",
  "malformed",
  "empty",
  "unsupported_type",
  "timeout",
  "malware",
  "permission_revoked",
  "converted_unavailable",
  "fetch",
  "distill",
  "limit",
] as const;

export type SourceFailureReason = (typeof SOURCE_FAILURE_REASONS)[number];

export function isSourceFailureReason(value: unknown): value is SourceFailureReason {
  return (SOURCE_FAILURE_REASONS as readonly unknown[]).includes(value);
}

// An operator's selected-source grant. Enrollment — not the provider token —
// is the privilege boundary for selected-source providers: discover() expands
// exactly this set and nothing else is ever fetched. The shared spine (`ref`,
// `kind`, `targetCollection`, `enrolledAt`, `enrolledBy`) is provider-neutral;
// the remaining fields are the m365/Graph operational + audience-disclosure
// details the adapter needs to expand and re-fetch this grant.
export interface EnrollmentRecord {
  /** Provider-scoped source reference; m365 = `${driveId}:${remoteId}`. */
  ref: string;
  kind: "file" | "folder";
  /** Display metadata for the operator UI only — never used for dispatch. */
  label: string;
  /** The collection distilled claims from this grant are staged into. */
  targetCollection: string;
  enrolledAt: string;
  /** Authenticated principal who made the enrollment. */
  enrolledBy: string;
  // --- m365/Graph operational fields (drive the delta-root expansion) ---
  driveId: string;
  remoteId: string;
  webUrl?: string;
  includeSpeakerNotes: boolean;
  /** Groups records into discovery delta roots; see deriveMicrosoftDeltaRoots. */
  cursorKey: string;
  // --- audience disclosure (R33/R34 audit; write-only snapshot) ---
  audienceAckAt: string;
  readersAtEnrollment: string[];
}

export interface SourceState {
  id: string;
  revision: string;
  contentHash: string;
  available: boolean;
  lastSeenAt: string;
  lastDistillRunId?: string;
  /** Last per-source failure encountered while extracting, fetching, or distilling. */
  lastFailure?: {
    at: string;
    reason: SourceFailureReason;
  };
}

/** Which remote account a connected provider is authenticated as. */
export interface ProviderAccount {
  id: string;
  tenantId: string;
  displayName?: string;
  upn?: string;
}

export interface ProviderState {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt?: string;
  cursor?: string;
  /** One-time nonce arming an otherwise unsigned manual webhook verification. */
  webhookSetupToken?: string;
  webhook?: {
    id: string;
    secret: string;
    expiresAt?: string;
    verificationRequired?: boolean;
    /** One webhook channel can fan out to N provider-side subscriptions. */
    subscriptions?: Array<{ id: string; resource: string; expiresAt: string }>;
  };
  /**
   * Phase-1 handle for an in-flight two-phase webhook ensure (#507): minted
   * and persisted before an automatic provider's subscription-create call,
   * so a synchronous mid-create validation (Graph) can be answered before
   * the final channel exists. Cleared once ensureProviderWebhook's phase-3
   * commits or the provider call fails; a stale entry from an interrupted
   * process is simply overwritten by the next ensure.
   */
  pendingWebhook?: {
    nonce: string;
    secret: string;
  };
  /** Selected-source providers only; absent = discover() enumerates everything. */
  enrollment?: EnrollmentRecord[];
  /**
   * Opaque adapter-owned change metadata (delta links, subscription ids).
   * Held provisionally with the change cursor: only committed once every
   * source in a discovery page has been handled.
   */
  adapterData?: Record<string, unknown>;
  sources: Record<string, SourceState>;
  /** Which remote account is connected. */
  account?: ProviderAccount;
  /** Reconnect state, when the provider requires re-authorization. */
  authorization?: {
    status: "ok" | "reconnect_required";
    at: string;
    reason?: string;
  };
}

// OAuth transactions are encrypted alongside provider credentials. A callback
// consumes its entry after use, so a replay has no durable state to match.
export interface OAuthState {
  provider: ProviderName;
  callbackNonce: string;
  pkceVerifier: string;
  expiresAt: string;
}

export interface IntegrationState {
  providers: Partial<Record<ProviderName, ProviderState>>;
  oauthStates: Record<string, OAuthState>;
}
