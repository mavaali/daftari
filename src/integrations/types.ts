// Shared, provider-neutral integration state. Source text never appears in
// these types: connector state records only credentials and change metadata.

export const PROVIDER_NAMES = ["google", "notion", "microsoft"] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export function isProviderName(value: unknown): value is ProviderName {
  return (PROVIDER_NAMES as readonly unknown[]).includes(value);
}

export interface IntegrationProviderConfig {
  clientIdEnv: string;
  clientSecretEnv: string;
}

export interface IntegrationConfig {
  encryptionKeyEnv: string;
  pollingIntervalMinutes: number;
  google?: IntegrationProviderConfig;
  notion?: IntegrationProviderConfig;
  microsoft?: IntegrationProviderConfig;
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

export interface SourceState {
  id: string;
  revision: string;
  contentHash: string;
  available: boolean;
  lastSeenAt: string;
  lastDistillRunId?: string;
  /** Groups this source under a human-selected enrollment. */
  enrollmentId?: string;
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

/** A human-selected item or container enrolled for ingestion. */
export interface EnrollmentRecord {
  id: string;
  kind: "item" | "container";
  driveId: string;
  remoteId: string;
  siteId?: string;
  listId?: string;
  label: string;
  webUrl?: string;
  collection: string;
  includeSpeakerNotes: boolean;
  enrolledBy: string;
  enrolledAt: string;
  audienceAckAt: string;
  readersAtEnrollment: string[];
  cursorKey: string;
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
  sources: Record<string, SourceState>;
  /** The human-selected subset of remote items/containers enrolled for ingestion. */
  enrollments?: Record<string, EnrollmentRecord>;
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
