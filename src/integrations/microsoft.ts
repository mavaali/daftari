// Microsoft 365 (Graph/Entra) integration adapter. It owns only Microsoft
// OAuth/Graph HTTP; the provider-neutral engine owns persistence,
// reconciliation, and distillation.
//
// SCAFFOLDING NOTICE: `ensureWebhook`, `verifyWebhook`, and `fetch` are still
// throwing not-implemented stubs. U13 implemented
// authorizationUrl/exchangeCode/refreshTokens. U14 (this unit) implements
// `discover` (Graph delta over the cursor contract). U16/U17/U18 land
// ensureWebhook/verifyWebhook/enrollment resolution/describeStatus. U15 lands
// fetch. Do not add real fetch/webhook Graph logic here until those units
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
import {
  boundedJson,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
  type HttpTransport,
  providerResponse,
  type RequestLimits,
  stringValue,
  TERMINAL_REFRESH_STATUSES,
  tokenExpiration,
} from "./http-json.js";
import type { EnrollmentRecord, MicrosoftProviderConfig, ProviderState } from "./types.js";

const MICROSOFT = "Microsoft";

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

export type MicrosoftHttpTransport = HttpTransport;

export interface MicrosoftAdapterOptions {
  redirectUri: string;
  config: MicrosoftProviderConfig;
  transport?: MicrosoftHttpTransport;
  now?: () => Date;
  // Design §11: bound every Graph/Entra HTTP call by size and time, same
  // defaults (30s / 8MiB) as Google. Overridable for tests only.
  requestTimeoutMilliseconds?: number;
  maxResponseBytes?: number;
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

function tokenEndpoint(config: MicrosoftProviderConfig): string {
  return `${MICROSOFT_AUTHORITY_HOST}/${config.tenantId}/oauth2/v2.0/token`;
}

function resolveScope(config: MicrosoftProviderConfig): string {
  const resourceScope =
    config.scopeProfile === "onedrive" ? MICROSOFT_ONEDRIVE_SCOPE : MICROSOFT_SHAREPOINT_SCOPE;
  return `${resourceScope} ${MICROSOFT_BASE_SCOPES}`;
}

// Bounded + timed-out request (design §11), returning the HTTP status
// alongside the parsed body regardless of 2xx/4xx/5xx — unlike the
// convenience jsonResponse in http-json.ts, callers here (refreshTokens
// especially) need the status/body of a non-2xx response to build a precise
// terminal signal. A transport failure or a timeout/size-cap trip returns a
// plain err() with no status attached, so it can never be misread as
// terminal (see TERMINAL_REFRESH_STATUSES usage in refreshTokens).
async function requestJson(
  transport: MicrosoftHttpTransport,
  url: string,
  init: RequestInit,
  limits: RequestLimits,
): Promise<Result<MicrosoftJsonResponse, Error>> {
  const fetched = await providerResponse(MICROSOFT, transport, url, init, limits);
  if (!fetched.ok) return fetched;
  const response = fetched.value;
  const parsed = await boundedJson(MICROSOFT, response, limits);
  if (!parsed.ok) return parsed;
  return ok({ status: response.status, body: parsed.value });
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
  limits: RequestLimits,
): Promise<Result<string, Error>> {
  const fromIdToken = decodeIdTokenTenantId(idToken);
  if (fromIdToken !== undefined) return ok(fromIdToken);
  const organization = await requestJson(
    transport,
    `${MICROSOFT_GRAPH_HOST}/organization`,
    { headers: { authorization: `Bearer ${accessToken}` } },
    limits,
  );
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
  limits: RequestLimits,
  input: CodeExchange,
): Promise<Result<ProviderTokens, Error>> {
  const token = await requestJson(
    transport,
    tokenEndpoint(config),
    {
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
    },
    limits,
  );
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

  const tenantId = await resolveTenantId(transport, tokenBody.id_token, accessToken, limits);
  if (!tenantId.ok) return tenantId;

  const me = await requestJson(
    transport,
    `${MICROSOFT_GRAPH_HOST}/me?$select=id,displayName,userPrincipalName`,
    { headers: { authorization: `Bearer ${accessToken}` } },
    limits,
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
  limits: RequestLimits,
  input: RefreshTokenRequest,
): Promise<Result<ProviderTokens, Error>> {
  const token = await requestJson(
    transport,
    tokenEndpoint(config),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
        scope: resolveScope(config),
      }).toString(),
    },
    limits,
  );
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

// ---------------------------------------------------------------------------
// Discovery (U14): Microsoft Graph `delta` over the engine's opaque-cursor
// contract.
//
// Cursor threading mirrors google.ts EXACTLY: `discover` mutates
// `state.cursor` in place (only once every root has succeeded) and returns
// the discovered RemoteSource[] as its Result value. reconcileProvider
// (engine.ts ~636-673) snapshots `previousCursor` before calling discover,
// lets discover mutate `providerState.cursor` freely, then immediately rolls
// it back to `previousCursor` ("provisional") until every scoped source has
// been fetched/distilled without failure — only then does it re-apply the
// mutated value. If discover() itself returns err (e.g. one root's request
// was rate-limited past the retry budget), reconcileProvider returns before
// ever reading `providerState.cursor` again, and — because this whole
// invocation runs inside withIntegrationStateLock without a matching
// writeState — nothing is persisted. So this function's own contract is:
// mutate `state.cursor` only after EVERY root has fully succeeded; return
// err() untouched otherwise. That "all-or-nothing" cursor mutation is a
// belt-and-braces mirror of the engine's own commit-on-success rule, not a
// substitute for it.
//
// The cursor is `{"v":1,"roots":{"<cursorKey>":"<@odata.deltaLink>"}}` — an
// opaque string to the engine, parsed defensively (garbage/missing -> no
// roots, i.e. every root initializes fresh).

const MICROSOFT_DELTA_SELECT = "id,name,eTag,cTag,size,file,folder,deleted,parentReference,malware";
const MICROSOFT_DELTA_PREFER = "deltaExcludeParent";
const MICROSOFT_MAX_DELTA_PAGES = 1_000;
// Graph honors Retry-After on 429s; bounded to a single retry and only when
// the wait is short enough that a reconcile cycle can absorb it inline (an
// unbounded/looping retry would starve the cycle — see http-json.ts's "don't
// add unbounded retries" note, which this mirrors at the delta layer since
// the shared helper has no built-in 429 semantics).
const MICROSOFT_MAX_RETRY_AFTER_SECONDS = 30;

interface MicrosoftCursorRoots {
  [cursorKey: string]: string;
}

function parseMicrosoftCursor(raw: string | undefined): MicrosoftCursorRoots {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const roots = (parsed as { roots?: unknown }).roots;
  if (typeof roots !== "object" || roots === null) return {};
  const result: MicrosoftCursorRoots = {};
  for (const [cursorKey, deltaLink] of Object.entries(roots)) {
    const value = stringValue(deltaLink);
    if (value !== undefined) result[cursorKey] = value;
  }
  return result;
}

function serializeMicrosoftCursor(roots: MicrosoftCursorRoots): string {
  return JSON.stringify({ v: 1, roots });
}

// A root groups one or more enrollments under a single delta walk/cursor
// entry (design §7.1): one container enrollment == one root (cursorKey
// "enrollment:<id>"); all item enrollments sharing a drive == one root
// (cursorKey "drive:<driveId>"), so a large library is never fully
// enumerated just to pick up a handful of individually-enrolled files.
interface MicrosoftDeltaRoot {
  cursorKey: string;
  kind: "container" | "item";
  driveId: string;
  /** Container only: the enrolled folder's item id (the delta subtree root). */
  folderId?: string;
  /** Item-group only: the enrolled item ids — the membership filter. */
  memberIds?: Set<string>;
}

function deriveMicrosoftDeltaRoots(
  enrollments: Record<string, EnrollmentRecord> | undefined,
): MicrosoftDeltaRoot[] {
  const roots = new Map<string, MicrosoftDeltaRoot>();
  for (const record of Object.values(enrollments ?? {})) {
    if (record.kind === "container") {
      roots.set(record.cursorKey, {
        cursorKey: record.cursorKey,
        kind: "container",
        driveId: record.driveId,
        folderId: record.remoteId,
      });
      continue;
    }
    const existing = roots.get(record.cursorKey);
    if (existing !== undefined && existing.kind === "item" && existing.memberIds !== undefined) {
      existing.memberIds.add(record.remoteId);
      continue;
    }
    roots.set(record.cursorKey, {
      cursorKey: record.cursorKey,
      kind: "item",
      driveId: record.driveId,
      memberIds: new Set([record.remoteId]),
    });
  }
  return [...roots.values()];
}

// The per-root "remembered" set that incremental delta pages get merged onto
// (Graph delta returns only CHANGED items after the first page, so anything
// untouched since the last cursor must carry forward from prior state).
// ProviderState.sources has no per-root tag, so this reconstructs root
// membership from the id namespace itself (`<driveId>:<itemId>`) plus, for
// item-group roots, the current enrollment's member ids. KNOWN LIMITATION
// (flagged for self-review, bead filed as a follow-up): if two roots share
// the same driveId (e.g. two separate container enrollments inside one
// SharePoint drive), this prefix filter can't disambiguate which root a
// remembered item belongs to. This is NOT merely redundant work — it is an
// availability-state correctness bug: an item DELETED from root A's subtree
// (and correctly dropped by root A's own walk) can be silently RESURRECTED
// into the merged present set because root B's remembered-set filter still
// matches it by driveId prefix and re-seeds it, unchanged, into root B's
// walk. That defeats R37's not-returned -> unavailable contract for that
// item. The fix is not "widen EnrollmentRecord" — EnrollmentRecord already
// carries driveId/cursorKey/id, i.e. everything needed to know which root an
// item truly belongs to. The missing wiring is downstream, in the
// provider-neutral engine: RemoteSource/NormalizedRemoteSource carry only
// {id, revision} with no root/cursorKey tag, and engine.ts's sourceState()
// never populates SourceState.enrollmentId for any provider, so
// state.sources has nowhere to record which root produced an entry. Fixing
// this properly means threading a root/enrollment tag through the engine's
// RemoteSource contract for every adapter, not just Microsoft — out of this
// unit's scope; a follow-up bead tracks it. No required test scenario for
// U14 exercises this cross-root case.
function rememberedRootSources(
  state: ProviderState,
  root: MicrosoftDeltaRoot,
): Map<string, RemoteSource> {
  const prefix = `${root.driveId}:`;
  const sources = new Map<string, RemoteSource>();
  for (const source of Object.values(state.sources)) {
    if (!source.available || !source.id.startsWith(prefix)) continue;
    if (typeof source.revision !== "string" || source.revision.length === 0) continue;
    if (root.kind === "item") {
      const itemIdPart = source.id.slice(prefix.length);
      if (!root.memberIds?.has(itemIdPart)) continue;
    }
    sources.set(source.id, { id: source.id, revision: source.revision });
  }
  return sources;
}

function microsoftDeltaSelectParameters(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { $select: MICROSOFT_DELTA_SELECT, ...extra };
}

function containerInitUrl(driveId: string, folderId: string): string {
  return requestUrl(
    `${MICROSOFT_GRAPH_HOST}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(folderId)}/delta`,
    microsoftDeltaSelectParameters(),
  );
}

// Probe-deferred fallback (design note): a folder-scoped delta 400s on some
// SharePoint libraries; probe 2 will confirm whether the folder-scoped or
// drive-root path is primary in practice. Until then, this is reached only
// when a fresh (non-resumed) container init 400s.
function containerFallbackUrl(driveId: string): string {
  return requestUrl(
    `${MICROSOFT_GRAPH_HOST}/drives/${encodeURIComponent(driveId)}/root/delta`,
    microsoftDeltaSelectParameters(),
  );
}

function itemGroupInitUrl(driveId: string): string {
  return requestUrl(
    `${MICROSOFT_GRAPH_HOST}/drives/${encodeURIComponent(driveId)}/root/delta`,
    microsoftDeltaSelectParameters({ token: "latest" }),
  );
}

interface MicrosoftDeltaItem {
  id?: unknown;
  eTag?: unknown;
  deleted?: unknown;
  file?: unknown;
  folder?: unknown;
  parentReference?: unknown;
}

interface MicrosoftDeltaPageBody {
  value?: unknown;
  "@odata.nextLink"?: unknown;
  "@odata.deltaLink"?: unknown;
}

type MicrosoftDeltaClassification =
  | { id: string; action: "remove" }
  | { id: string; action: "upsert"; revision: string };

function deltaItemId(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  return stringValue((raw as MicrosoftDeltaItem).id);
}

function deltaParentId(item: MicrosoftDeltaItem): string | undefined {
  if (typeof item.parentReference !== "object" || item.parentReference === null) return undefined;
  return stringValue((item.parentReference as { id?: unknown }).id);
}

// Item-group roots only ever track the specifically-enrolled item ids — the
// drive-root delta walks the WHOLE drive, so everything else must be
// filtered out (§8: a large library is never fully enumerated into sources).
function classifyItemGroupDeltaItem(
  raw: unknown,
  driveId: string,
  memberIds: Set<string>,
): MicrosoftDeltaClassification | undefined {
  const id = deltaItemId(raw);
  if (id === undefined || !memberIds.has(id)) return undefined;
  const item = raw as MicrosoftDeltaItem;
  const sourceId = `${driveId}:${id}`;
  if (item.deleted !== undefined || item.file === undefined) {
    return { id: sourceId, action: "remove" };
  }
  const eTag = stringValue(item.eTag);
  if (eTag === undefined) return { id: sourceId, action: "remove" };
  return { id: sourceId, action: "upsert", revision: eTag };
}

// Container roots track ancestry by id (delta omits parentReference.path),
// mutating `ancestorIds` as folders inside the subtree are discovered. This
// runs the same whether the walk started from the folder-scoped delta or the
// drive-root fallback: the folder-scoped endpoint already scopes results to
// the subtree, but nested-folder moves can still surface items whose parent
// isn't the direct root, so ancestry tracking is applied uniformly rather
// than only in the fallback path.
function classifyContainerDeltaItem(
  raw: unknown,
  driveId: string,
  folderId: string,
  ancestorIds: Set<string>,
): MicrosoftDeltaClassification | undefined {
  const id = deltaItemId(raw);
  if (id === undefined) return undefined;
  if (id === folderId) return undefined; // the enrolled root folder itself is not a source
  const item = raw as MicrosoftDeltaItem;
  const parentId = deltaParentId(item);
  const inSubtree = parentId !== undefined && ancestorIds.has(parentId);
  const sourceId = `${driveId}:${id}`;
  if (item.deleted !== undefined) {
    ancestorIds.delete(id);
    return { id: sourceId, action: "remove" };
  }
  if (item.folder !== undefined) {
    if (inSubtree) ancestorIds.add(id);
    else ancestorIds.delete(id);
    return undefined; // folders are tracked for ancestry only, never returned as sources
  }
  if (!inSubtree) return { id: sourceId, action: "remove" };
  const eTag = stringValue(item.eTag);
  if (item.file === undefined || eTag === undefined) return { id: sourceId, action: "remove" };
  return { id: sourceId, action: "upsert", revision: eTag };
}

function taggedDeltaError(message: string, tags: { resync?: true; badRequest?: true }): Error {
  return Object.assign(new Error(message), tags);
}

function isResyncError(error: Error): boolean {
  return (error as { resync?: boolean }).resync === true;
}

function isBadRequestError(error: Error): boolean {
  return (error as { badRequest?: boolean }).badRequest === true;
}

interface MicrosoftDeltaPageResult {
  status: number;
  retryAfterSeconds?: number;
  body?: unknown;
}

async function requestDeltaPage(
  transport: MicrosoftHttpTransport,
  url: string,
  accessToken: string,
  limits: RequestLimits,
): Promise<Result<MicrosoftDeltaPageResult, Error>> {
  const fetched = await providerResponse(
    MICROSOFT,
    transport,
    url,
    { headers: { authorization: `Bearer ${accessToken}`, prefer: MICROSOFT_DELTA_PREFER } },
    limits,
  );
  if (!fetched.ok) return fetched;
  const response = fetched.value;
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterSeconds =
    retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader)
      ? Number(retryAfterHeader)
      : undefined;
  if (response.status !== 200) {
    return ok({
      status: response.status,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  const parsed = await boundedJson(MICROSOFT, response, limits);
  if (!parsed.ok) return parsed;
  return ok({ status: response.status, body: parsed.value });
}

// Honors Retry-After exactly once, only when short enough to absorb inline;
// a second 429 (or a longer wait) is a hard failure so this can never retry
// unboundedly.
async function requestDeltaPageWithRetry(
  transport: MicrosoftHttpTransport,
  url: string,
  accessToken: string,
  limits: RequestLimits,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<Result<MicrosoftDeltaPageResult, Error>> {
  const first = await requestDeltaPage(transport, url, accessToken, limits);
  if (!first.ok) return first;
  if (first.value.status !== 429) return first;
  const retryAfterSeconds = first.value.retryAfterSeconds;
  if (retryAfterSeconds === undefined || retryAfterSeconds > MICROSOFT_MAX_RETRY_AFTER_SECONDS) {
    return err(new Error("Microsoft Graph delta request was rate limited"));
  }
  await sleep(retryAfterSeconds * 1000);
  const retried = await requestDeltaPage(transport, url, accessToken, limits);
  if (!retried.ok) return retried;
  if (retried.value.status === 429) {
    return err(new Error("Microsoft Graph delta request was rate limited"));
  }
  return retried;
}

interface MicrosoftDeltaWalkResult {
  deltaLink: string;
  sources: Map<string, RemoteSource>;
}

// Follows @odata.nextLink pages from `initialUrl` to a terminal
// @odata.deltaLink, bounded by MICROSOFT_MAX_DELTA_PAGES with a repeated-link
// guard (mirrors google.ts's Drive-changes pagination exactly). `classify`
// applies each page's items to a mutable copy of `seed` — last occurrence in
// the stream wins because later entries simply overwrite/delete the same map
// key.
async function walkMicrosoftDelta(
  transport: MicrosoftHttpTransport,
  accessToken: string,
  limits: RequestLimits,
  sleep: (milliseconds: number) => Promise<void>,
  initialUrl: string,
  classify: (item: unknown) => MicrosoftDeltaClassification | undefined,
  seed: Map<string, RemoteSource>,
): Promise<Result<MicrosoftDeltaWalkResult, Error>> {
  const sources = new Map(seed);
  const seenLinks = new Set<string>();
  let url = initialUrl;
  let pages = 0;
  for (;;) {
    pages += 1;
    if (pages > MICROSOFT_MAX_DELTA_PAGES) {
      return err(new Error("Microsoft Graph delta discovery exceeds the page limit"));
    }
    if (seenLinks.has(url)) {
      return err(new Error("Microsoft Graph delta discovery repeated a page link"));
    }
    seenLinks.add(url);

    const page = await requestDeltaPageWithRetry(transport, url, accessToken, limits, sleep);
    if (!page.ok) return page;
    if (page.value.status === 410) {
      return err(taggedDeltaError("Microsoft Graph delta requires a resync", { resync: true }));
    }
    if (page.value.status === 400) {
      return err(
        taggedDeltaError(`Microsoft Graph delta request failed with status 400`, {
          badRequest: true,
        }),
      );
    }
    if (page.value.status !== 200) {
      return err(
        new Error(`Microsoft Graph delta request failed with status ${page.value.status}`),
      );
    }
    const body = page.value.body as MicrosoftDeltaPageBody;
    if (body.value !== undefined && !Array.isArray(body.value)) {
      return err(new Error("Microsoft Graph delta response is invalid"));
    }
    for (const raw of body.value ?? []) {
      const classified = classify(raw);
      if (classified === undefined) continue;
      if (classified.action === "remove") sources.delete(classified.id);
      else sources.set(classified.id, { id: classified.id, revision: classified.revision });
    }
    const deltaLink = stringValue(body["@odata.deltaLink"]);
    if (deltaLink !== undefined) return ok({ deltaLink, sources });
    const nextLink = stringValue(body["@odata.nextLink"]);
    if (nextLink === undefined) {
      return err(new Error("Microsoft Graph delta response is missing a nextLink or deltaLink"));
    }
    url = nextLink;
  }
}

async function walkMicrosoftDeltaRoot(
  transport: MicrosoftHttpTransport,
  accessToken: string,
  limits: RequestLimits,
  sleep: (milliseconds: number) => Promise<void>,
  root: MicrosoftDeltaRoot,
  storedLink: string | undefined,
  remembered: Map<string, RemoteSource>,
): Promise<Result<MicrosoftDeltaWalkResult, Error>> {
  const attempt = (url: string, seed: Map<string, RemoteSource>) => {
    if (root.kind === "container") {
      const folderId = root.folderId as string;
      const ancestorIds = new Set<string>([folderId]);
      return walkMicrosoftDelta(
        transport,
        accessToken,
        limits,
        sleep,
        url,
        (raw) => classifyContainerDeltaItem(raw, root.driveId, folderId, ancestorIds),
        seed,
      );
    }
    const memberIds = root.memberIds as Set<string>;
    return walkMicrosoftDelta(
      transport,
      accessToken,
      limits,
      sleep,
      url,
      (raw) => classifyItemGroupDeltaItem(raw, root.driveId, memberIds),
      seed,
    );
  };

  const freshInitUrl = (): string =>
    root.kind === "container"
      ? containerInitUrl(root.driveId, root.folderId as string)
      : itemGroupInitUrl(root.driveId);

  const resumed = storedLink !== undefined;
  let usedFallback = false;
  let result = await attempt(
    resumed ? storedLink : freshInitUrl(),
    resumed ? remembered : new Map(),
  );

  // Container-only 400 fallback: only applies to a fresh (non-resumed) walk,
  // since a resumed deltaLink was already proven to work in a prior cycle.
  if (!result.ok && !resumed && root.kind === "container" && isBadRequestError(result.error)) {
    usedFallback = true;
    result = await attempt(containerFallbackUrl(root.driveId), new Map());
  }

  // 410 resync: drop this root's stored link and re-enumerate from scratch,
  // bounded to a single re-init attempt so a persistently-invalid delta
  // session can't loop forever.
  if (!result.ok && isResyncError(result.error)) {
    const reinitUrl = usedFallback ? containerFallbackUrl(root.driveId) : freshInitUrl();
    result = await attempt(reinitUrl, new Map());
  }

  return result;
}

async function discoverMicrosoftSources(
  transport: MicrosoftHttpTransport,
  limits: RequestLimits,
  sleep: (milliseconds: number) => Promise<void>,
  state: ProviderState,
): Promise<Result<RemoteSource[], Error>> {
  const roots = deriveMicrosoftDeltaRoots(state.enrollments);
  if (roots.length === 0) return ok([]);

  const storedRoots = parseMicrosoftCursor(state.cursor);
  const newRoots: MicrosoftCursorRoots = {};
  const allSources = new Map<string, RemoteSource>();

  for (const root of roots) {
    const remembered = rememberedRootSources(state, root);
    const walked = await walkMicrosoftDeltaRoot(
      transport,
      state.accessToken,
      limits,
      sleep,
      root,
      storedRoots[root.cursorKey],
      remembered,
    );
    if (!walked.ok) return walked;
    newRoots[root.cursorKey] = walked.value.deltaLink;
    for (const [id, source] of walked.value.sources) allSources.set(id, source);
  }

  // Mutate state.cursor only now that every root has fully succeeded — same
  // "all roots or none" cursor mutation the engine itself enforces on top of
  // this (see the big comment above this section).
  state.cursor = serializeMicrosoftCursor(newRoots);
  return ok([...allSources.values()]);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  const limits: RequestLimits = {
    timeoutMilliseconds: options.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  };
  return {
    name: "microsoft",
    webhookSetup: "automatic",
    authorizationUrl: (input) => authorizationUrl(input, redirectUri, config),
    exchangeCode: (input) => exchangeCode(transport, redirectUri, now, config, limits, input),
    refreshTokens: (input) => refreshTokens(transport, now, config, limits, input),
    ensureWebhook,
    verifyWebhook,
    discover: (state) => discoverMicrosoftSources(transport, limits, defaultSleep, state),
    fetch: fetchSource,
  };
}
