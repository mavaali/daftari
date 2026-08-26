// Shared, provider-neutral integration state. Source text never appears in
// these types: connector state records only credentials and change metadata.

export type ProviderName = "google" | "notion";

export interface IntegrationProviderConfig {
  clientIdEnv: string;
  clientSecretEnv: string;
}

export interface IntegrationConfig {
  encryptionKeyEnv: string;
  pollingIntervalMinutes: number;
  google?: IntegrationProviderConfig;
  notion?: IntegrationProviderConfig;
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
