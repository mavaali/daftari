// Microsoft 365 (Graph/Entra) integration adapter. It owns only Microsoft
// OAuth/Graph HTTP; the provider-neutral engine owns persistence,
// reconciliation, and distillation.
//
// SCAFFOLDING NOTICE: `ensureWebhook`, `verifyWebhook`, and `fetch` are still
// throwing not-implemented stubs; `discover` is a safe no-op. U13 (this unit)
// implements authorizationUrl/exchangeCode/refreshTokens. U15-U17 land
// discover/fetch/ensureWebhook/verifyWebhook, U18 describeStatus/enrollment.
// Do not add real discovery/fetch/webhook Graph logic here until those units
// land.

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

// Microsoft identity platform v2.0 authorize/token endpoints.
const MICROSOFT_AUTHORITY_HOST = "https://login.microsoftonline.com";
const MICROSOFT_GRAPH_HOST = "https://graph.microsoft.com/v1.0";

// Server/Graph delegated scopes per scopeProfile (design: onedrive ->
// Files.Read, sharepoint -> Files.Read.All). The browser-MSAL SharePoint
// picker scopes (AllSites.Read/MyFiles.Read) are a different, client-side
// authorization surface and never belong on this server authorize URL.
const MICROSOFT_ONEDRIVE_SCOPE = "Files.Read";
const MICROSOFT_SHAREPOINT_SCOPE = "Files.Read.All";
// openid so the token response carries an id_token (used to read the tenant
// `tid` claim without a second round trip in the common case).
const MICROSOFT_BASE_SCOPES = "offline_access User.Read openid";

// A refresh failure whose HTTP status lands in this set is a definite
// terminal signal (bad grant / consent revoked / tenant-side block) per
// engine.ts's isTerminalRefreshError, which checks `.status` before falling
// back to message sniffing. Attaching status here lets the classifier work
// without depending on message wording.
const TERMINAL_REFRESH_STATUSES = new Set([400, 401, 403]);

export type MicrosoftHttpTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface MicrosoftAdapterOptions {
  redirectUri: string;
  config: MicrosoftProviderConfig;
  transport?: MicrosoftHttpTransport;
  now?: () => Date;
}

interface MicrosoftTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  error?: unknown;
}

interface MicrosoftMeResponse {
  id?: unknown;
  displayName?: unknown;
  userPrincipalName?: unknown;
}

interface MicrosoftOrganizationResponse {
  value?: unknown;
}

interface MicrosoftJsonResponse {
  status: number;
  body: unknown;
}

function requestUrl(path: string, parameters: Record<string, string | undefined>): string {
  const url = new URL(path);
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function tokenExpiration(expiresIn: unknown, now: () => Date): string | undefined {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return undefined;
  }
  return new Date(now().getTime() + expiresIn * 1000).toISOString();
}

function tokenEndpoint(config: MicrosoftProviderConfig): string {
  return `${MICROSOFT_AUTHORITY_HOST}/${config.tenantId}/oauth2/v2.0/token`;
}

function resolveScope(config: MicrosoftProviderConfig): string {
  const resourceScope =
    config.scopeProfile === "onedrive" ? MICROSOFT_ONEDRIVE_SCOPE : MICROSOFT_SHAREPOINT_SCOPE;
  return `${resourceScope} ${MICROSOFT_BASE_SCOPES}`;
}

async function requestJson(
  transport: MicrosoftHttpTransport,
  url: string,
  init: RequestInit,
): Promise<Result<MicrosoftJsonResponse, Error>> {
  let response: Response;
  try {
    response = await transport(url, init);
  } catch {
    // Never reached an HTTP response, so it can never be positively
    // identified as terminal — no `.status` is attached, matching the
    // engine's "transient on network failure" contract.
    return err(new Error("Microsoft request failed"));
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return err(new Error("Microsoft returned an invalid JSON response"));
  }
  return ok({ status: response.status, body });
}

// Decodes (never verifies) the id_token's middle JWT segment to read the
// tenant `tid` claim. The value is only ever displayed/stored as metadata,
// never used as an authorization decision — signature verification is out of
// scope by design (see design §4.5).
function decodeIdTokenTenantId(idToken: unknown): string | undefined {
  const token = stringValue(idToken);
  if (token === undefined) return undefined;
  const segments = token.split(".");
  if (segments.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as {
      tid?: unknown;
    };
    return stringValue(payload.tid);
  } catch {
    return undefined;
  }
}

async function resolveTenantId(
  transport: MicrosoftHttpTransport,
  idToken: unknown,
  accessToken: string,
): Promise<Result<string, Error>> {
  const fromIdToken = decodeIdTokenTenantId(idToken);
  if (fromIdToken !== undefined) return ok(fromIdToken);
  const organization = await requestJson(transport, `${MICROSOFT_GRAPH_HOST}/organization`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!organization.ok) return organization;
  if (organization.value.status < 200 || organization.value.status >= 300) {
    return err(
      new Error(
        `Microsoft Graph organization lookup failed with status ${organization.value.status}`,
      ),
    );
  }
  const body = organization.value.body as MicrosoftOrganizationResponse;
  const first = Array.isArray(body.value) ? (body.value[0] as unknown) : undefined;
  const id =
    typeof first === "object" && first !== null
      ? stringValue((first as { id?: unknown }).id)
      : undefined;
  return id === undefined
    ? err(new Error("Microsoft Graph organization response is missing a tenant id"))
    : ok(id);
}

function terminalRefreshError(status: number, body: unknown): Error {
  const errorCode =
    typeof body === "object" && body !== null
      ? stringValue((body as { error?: unknown }).error)
      : undefined;
  const error = new Error(
    `Microsoft OAuth token refresh failed with status ${status}${
      errorCode === undefined ? "" : `: ${errorCode}`
    }`,
  ) as Error & { status?: number; terminal?: boolean };
  error.status = status;
  if (TERMINAL_REFRESH_STATUSES.has(status)) error.terminal = true;
  return error;
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
    prompt: "select_account",
    redirect_uri: redirectUri,
    response_mode: "query",
    response_type: "code",
    scope: resolveScope(config),
    state: input.state,
  });
}

async function exchangeCode(
  transport: MicrosoftHttpTransport,
  redirectUri: string,
  now: () => Date,
  config: MicrosoftProviderConfig,
  input: CodeExchange,
): Promise<Result<ProviderTokens, Error>> {
  const token = await requestJson(transport, tokenEndpoint(config), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      code_verifier: input.pkceVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      scope: resolveScope(config),
    }).toString(),
  });
  if (!token.ok) return token;
  if (token.value.status < 200 || token.value.status >= 300) {
    return err(new Error(`Microsoft OAuth code exchange failed with status ${token.value.status}`));
  }
  const tokenBody = token.value.body as MicrosoftTokenResponse;
  const accessToken = stringValue(tokenBody.access_token);
  const refreshToken = stringValue(tokenBody.refresh_token);
  if (accessToken === undefined || refreshToken === undefined) {
    return err(new Error("Microsoft OAuth token response is incomplete"));
  }
  const accessTokenExpiresAt = tokenExpiration(tokenBody.expires_in, now);

  const tenantId = await resolveTenantId(transport, tokenBody.id_token, accessToken);
  if (!tenantId.ok) return tenantId;

  const me = await requestJson(
    transport,
    `${MICROSOFT_GRAPH_HOST}/me?$select=id,displayName,userPrincipalName`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!me.ok) return me;
  if (me.value.status < 200 || me.value.status >= 300) {
    return err(new Error(`Microsoft Graph /me lookup failed with status ${me.value.status}`));
  }
  const meBody = me.value.body as MicrosoftMeResponse;
  const id = stringValue(meBody.id);
  if (id === undefined) return err(new Error("Microsoft Graph /me response is incomplete"));
  const displayName = stringValue(meBody.displayName);
  const upn = stringValue(meBody.userPrincipalName);

  return ok({
    accessToken,
    refreshToken,
    ...(accessTokenExpiresAt === undefined ? {} : { accessTokenExpiresAt }),
    account: {
      id,
      tenantId: tenantId.value,
      ...(displayName === undefined ? {} : { displayName }),
      ...(upn === undefined ? {} : { upn }),
    },
  });
}

async function refreshTokens(
  transport: MicrosoftHttpTransport,
  now: () => Date,
  config: MicrosoftProviderConfig,
  input: RefreshTokenRequest,
): Promise<Result<ProviderTokens, Error>> {
  const token = await requestJson(transport, tokenEndpoint(config), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      scope: resolveScope(config),
    }).toString(),
  });
  if (!token.ok) return token;
  if (token.value.status < 200 || token.value.status >= 300) {
    return err(terminalRefreshError(token.value.status, token.value.body));
  }
  const tokenBody = token.value.body as MicrosoftTokenResponse;
  const accessToken = stringValue(tokenBody.access_token);
  if (accessToken === undefined) {
    return err(new Error("Microsoft OAuth token refresh response is incomplete"));
  }
  // Microsoft rotates refresh tokens on every use; fall back to the prior
  // refresh token only if the response omits a new one.
  const refreshToken = stringValue(tokenBody.refresh_token) ?? input.refreshToken;
  const accessTokenExpiresAt = tokenExpiration(tokenBody.expires_in, now);
  return ok({
    accessToken,
    refreshToken,
    ...(accessTokenExpiresAt === undefined ? {} : { accessTokenExpiresAt }),
  });
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
  const transport = options.transport ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  return {
    name: "microsoft",
    webhookSetup: "automatic",
    authorizationUrl: (input) => authorizationUrl(input, redirectUri, config),
    exchangeCode: (input) => exchangeCode(transport, redirectUri, now, config, input),
    refreshTokens: (input) => refreshTokens(transport, now, config, input),
    ensureWebhook,
    verifyWebhook,
    discover,
    fetch: fetchSource,
  };
}
