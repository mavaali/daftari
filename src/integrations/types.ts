// Shared, provider-neutral integration state. Source text never appears in
// these types: connector state records only credentials and change metadata.

export type ProviderName = "google" | "notion" | "m365";

export interface IntegrationProviderConfig {
  clientIdEnv: string;
  clientSecretEnv: string;
}

export interface IntegrationConfig {
  encryptionKeyEnv: string;
  pollingIntervalMinutes: number;
  google?: IntegrationProviderConfig;
  notion?: IntegrationProviderConfig;
  m365?: IntegrationProviderConfig;
}

// An operator's selected-source grant. Enrollment — not the provider token —
// is the privilege boundary for selected-source providers: discover() expands
// exactly this set and nothing else is ever fetched.
export interface EnrollmentRecord {
  /** Provider-scoped source reference, e.g. "drive:<driveId>:<itemId>". */
  ref: string;
  kind: "file" | "folder";
  /** Display metadata for the operator UI only — never used for dispatch. */
  label: string;
  targetCollection: string;
  enrolledAt: string;
  /** Authenticated principal who made the enrollment. */
  enrolledBy: string;
}

export interface SourceState {
  id: string;
  revision: string;
  contentHash: string;
  available: boolean;
  lastSeenAt: string;
  lastDistillRunId?: string;
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
