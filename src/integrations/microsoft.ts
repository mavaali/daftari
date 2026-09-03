// Microsoft 365 (Graph/Entra) integration adapter skeleton (U12). It owns
// only Microsoft OAuth/Graph HTTP; the provider-neutral engine owns
// persistence, reconciliation, and distillation.
//
// SCAFFOLDING NOTICE: this unit builds the capability-valid adapter shape and
// the injected-transport seam only. `refreshTokens`, `ensureWebhook`,
// `verifyWebhook`, and `fetch` are throwing not-implemented stubs; `discover`
// is a safe no-op; `exchangeCode` returns a not-implemented Result.
// U13 replaces authorizationUrl/exchangeCode, U14 refreshTokens, U15-U17
// discover/fetch/ensureWebhook/verifyWebhook, U18 describeStatus/enrollment.
// Do not add real Graph/Entra request logic here until those units land.

import { err, ok, type Result } from "../frontmatter/types.js";
import type {
  AuthorizationRequest,
  CodeExchange,
  EnsureWebhookInput,
  NormalizedRemoteSource,
  ProviderAdapter,
  ProviderTokens,
  RefreshTokenRequest,
  RemoteSource,
  VerifiedWebhook,
  WebhookChannel,
  WebhookRequest,
} from "./engine.js";
import type { MicrosoftProviderConfig, ProviderState } from "./types.js";

// Microsoft identity platform v2.0 authorize endpoint. U13 fills in the real
// scope set/response handling for exchangeCode; the authorize URL shape is
// stable enough to build here since it only needs config already resolved by
// U11 (tenantId) plus the standard PKCE/state fields every adapter emits.
const MICROSOFT_AUTHORITY_HOST = "https://login.microsoftonline.com";

export type MicrosoftHttpTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface MicrosoftAdapterOptions {
  redirectUri: string;
  config: MicrosoftProviderConfig;
  transport?: MicrosoftHttpTransport;
  now?: () => Date;
}

function requestUrl(path: string, parameters: Record<string, string | undefined>): string {
  const url = new URL(path);
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function authorizationUrl(
  input: AuthorizationRequest,
  redirectUri: string,
  config: MicrosoftProviderConfig,
): string {
  return requestUrl(`${MICROSOFT_AUTHORITY_HOST}/${config.tenantId}/oauth2/v2.0/authorize`, {
    client_id: input.clientId,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod,
    redirect_uri: redirectUri,
    response_mode: "query",
    response_type: "code",
    // U13 fills the real Graph scope list for the configured scopeProfile
    // (onedrive vs sharepoint); a placeholder covers only sign-in + profile
    // so the shape is a valid URL, never real enrollment access.
    scope: "openid offline_access",
    state: input.state,
  });
}

async function exchangeCode(_input: CodeExchange): Promise<Result<ProviderTokens, Error>> {
  return err(new Error("microsoft exchangeCode not yet implemented (U13)"));
}

async function refreshTokens(_input: RefreshTokenRequest): Promise<Result<ProviderTokens, Error>> {
  throw new Error("microsoft refreshTokens not yet implemented (U14)");
}

async function ensureWebhook(
  _state: ProviderState,
  _input: EnsureWebhookInput,
): Promise<Result<WebhookChannel, Error>> {
  throw new Error("microsoft ensureWebhook not yet implemented (U16)");
}

async function verifyWebhook(
  _input: WebhookRequest,
  _state: ProviderState,
): Promise<Result<VerifiedWebhook, Error>> {
  throw new Error("microsoft verifyWebhook not yet implemented (U16)");
}

// Safe no-op: an empty discovery page is a valid (if useless) result under
// the engine's reconcile contract — it never corrupts state, it just finds
// nothing until U15 lands. Real discovery must not throw here because
// reconcileProvider treats a throw from discover() the same as an err()
// result (both fail the cycle), so an empty ok([]) is the more honest
// "nothing to do yet" signal than a fabricated failure.
async function discover(_state: ProviderState): Promise<Result<RemoteSource[], Error>> {
  return ok([]);
}

// Throws rather than returning err(...) like exchangeCode does, because the
// two are unreachable at different points: exchangeCode is reachable today
// via a real "connect Microsoft" OAuth click, so it returns a Result the
// route layer can surface to the user as a normal failure. fetch is never
// reachable in U12 — discover() always returns an empty source list, so
// reconcileProvider has nothing to call fetch on. U15 should implement this
// for real, not "fix" it into an err() to match exchangeCode.
async function fetchSource(
  _source: RemoteSource,
  _state: ProviderState,
): Promise<Result<NormalizedRemoteSource, Error>> {
  throw new Error("microsoft fetch not yet implemented (U15)");
}

export function createMicrosoftAdapter(options: MicrosoftAdapterOptions): ProviderAdapter {
  const { config, redirectUri } = options;
  // Captured now so the option is wired end-to-end (production defaults to a
  // real fetch, tests inject a fixture transport) even though the U12
  // placeholders below don't call it yet — U13-U16 consume it without
  // needing another signature change.
  const _transport = options.transport ?? globalThis.fetch;
  const _now = options.now ?? (() => new Date());
  void _transport;
  void _now;
  return {
    name: "microsoft",
    webhookSetup: "automatic",
    authorizationUrl: (input) => authorizationUrl(input, redirectUri, config),
    exchangeCode,
    refreshTokens,
    ensureWebhook,
    verifyWebhook,
    discover,
    fetch: fetchSource,
  };
}
