// OAuth transaction lifecycle. The state token is encrypted at rest, binds the
// PKCE verifier to one provider, and is consumed before the code exchange.

import { createHash, randomBytes } from "node:crypto";
import { err, ok, type Result } from "../frontmatter/types.js";
import {
  type AuthorizationRequest,
  configuredCredential,
  type EngineDeps,
  type ProviderTokens,
  providerConfig,
} from "./engine.js";
import {
  readIntegrationState,
  resolveIntegrationStateKey,
  writeIntegrationState,
} from "./state.js";
import type { IntegrationConfig, ProviderName, ProviderState } from "./types.js";

const OAUTH_STATE_TTL_MILLISECONDS = 10 * 60 * 1000;

export interface AuthorizationStart {
  state: string;
  authorization: AuthorizationRequest;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function expiration(now: () => Date): string {
  return new Date(now().getTime() + OAUTH_STATE_TTL_MILLISECONDS).toISOString();
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function oauthNow(deps: Pick<EngineDeps, "now">): () => Date {
  return deps.now ?? (() => new Date());
}

export function beginAuthorization(
  vaultRoot: string,
  provider: ProviderName,
  config: IntegrationConfig,
  environment: NodeJS.ProcessEnv,
  now: () => Date = () => new Date(),
): Result<AuthorizationStart, Error> {
  const integrationProvider = providerConfig(config, provider);
  if (!integrationProvider.ok) return integrationProvider;
  const key = resolveIntegrationStateKey(config.encryptionKeyEnv, environment);
  if (!key.ok) return key;
  const clientId = configuredCredential(
    environment,
    integrationProvider.value.clientIdEnv,
    `${provider} OAuth client ID`,
  );
  if (!clientId.ok) return clientId;
  const integrationState = readIntegrationState(vaultRoot, key.value);
  if (!integrationState.ok) return integrationState;

  const state = base64Url(randomBytes(32));
  const pkceVerifier = base64Url(randomBytes(32));
  integrationState.value.oauthStates[state] = {
    provider,
    callbackNonce: base64Url(randomBytes(16)),
    pkceVerifier,
    expiresAt: expiration(now),
  };
  const written = writeIntegrationState(vaultRoot, integrationState.value, key.value);
  if (!written.ok) return written;
  return ok({
    state,
    authorization: {
      provider,
      clientId: clientId.value,
      state,
      codeChallenge: pkceChallenge(pkceVerifier),
      codeChallengeMethod: "S256",
    },
  });
}

function providerState(
  tokens: { accessToken: string; refreshToken: string; accessTokenExpiresAt?: string },
  previous?: ProviderState,
): ProviderState {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    sources: previous?.sources ?? {},
    ...(previous?.cursor === undefined ? {} : { cursor: previous.cursor }),
    ...(previous?.webhook === undefined ? {} : { webhook: previous.webhook }),
    ...(tokens.accessTokenExpiresAt === undefined
      ? {}
      : { accessTokenExpiresAt: tokens.accessTokenExpiresAt }),
  };
}

export async function completeAuthorization(
  vaultRoot: string,
  provider: ProviderName,
  state: string,
  code: string,
  deps: EngineDeps,
): Promise<Result<void, Error>> {
  if (
    typeof state !== "string" ||
    state.length === 0 ||
    typeof code !== "string" ||
    code.length === 0
  ) {
    return err(new Error("OAuth callback is missing state or code"));
  }
  const integrationProvider = providerConfig(deps.config, provider);
  if (!integrationProvider.ok) return integrationProvider;
  const key = resolveIntegrationStateKey(deps.config.encryptionKeyEnv, deps.environment);
  if (!key.ok) return key;
  const persisted = readIntegrationState(vaultRoot, key.value);
  if (!persisted.ok) return persisted;
  const transaction = persisted.value.oauthStates[state];
  if (transaction === undefined || transaction.provider !== provider) {
    return err(new Error("OAuth callback state is invalid or already used"));
  }

  delete persisted.value.oauthStates[state];
  const consumed = writeIntegrationState(vaultRoot, persisted.value, key.value);
  if (!consumed.ok) return consumed;
  if (Date.parse(transaction.expiresAt) <= oauthNow(deps)().getTime()) {
    return err(new Error("OAuth callback state has expired"));
  }

  const clientId = configuredCredential(
    deps.environment,
    integrationProvider.value.clientIdEnv,
    `${provider} OAuth client ID`,
  );
  if (!clientId.ok) return clientId;
  const clientSecret = configuredCredential(
    deps.environment,
    integrationProvider.value.clientSecretEnv,
    `${provider} OAuth client secret`,
  );
  if (!clientSecret.ok) return clientSecret;
  const adapter = deps.adapters[provider];
  if (adapter === undefined)
    return err(new Error(`integration provider ${provider} adapter is unavailable`));
  let exchanged: Result<ProviderTokens, Error>;
  try {
    exchanged = await adapter.exchangeCode({
      code,
      clientId: clientId.value,
      clientSecret: clientSecret.value,
      callbackNonce: transaction.callbackNonce,
      pkceVerifier: transaction.pkceVerifier,
    });
  } catch {
    return err(new Error(`OAuth code exchange failed for ${provider}`));
  }
  if (!exchanged.ok) return err(new Error(`OAuth code exchange failed for ${provider}`));
  if (exchanged.value.accessToken.length === 0 || exchanged.value.refreshToken.length === 0) {
    return err(new Error(`OAuth code exchange returned incomplete tokens for ${provider}`));
  }

  persisted.value.providers[provider] = providerState(
    exchanged.value,
    persisted.value.providers[provider],
  );
  return writeIntegrationState(vaultRoot, persisted.value, key.value);
}
