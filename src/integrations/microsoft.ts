// Microsoft 365 (Graph/Entra) integration adapter. It owns only Microsoft
// OAuth/Graph HTTP; the provider-neutral engine owns persistence,
// reconciliation, and distillation.
//
// SCAFFOLDING NOTICE: `ensureWebhook` and `verifyWebhook` are still throwing
// not-implemented stubs. U13 implemented
// authorizationUrl/exchangeCode/refreshTokens. U14 implements `discover`
// (Graph delta over the cursor contract). U15 (this unit) implements `fetch`
// (download + extractor routing + legacy pdf conversion). U16/U17/U18 land
// ensureWebhook/verifyWebhook/enrollment resolution/describeStatus. Do not
// add real webhook Graph logic here until those units land.

import { DEFAULT_EXTRACT_LIMITS, type ExtractKind, extractText } from "../extract/index.js";
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
import type {
  EnrollmentRecord,
  MicrosoftProviderConfig,
  ProviderState,
  SourceFailureReason,
} from "./types.js";

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

// A per-root cursor entry is either a bare deltaLink string (the folder-
// scoped "primary" container path, and every item-group root: Graph itself
// scopes these results, so no extra membership state needs to survive a
// cycle) or `{link, folders}` (the container "fallback" path only: the
// drive-root delta returns the WHOLE drive, so which folder ids are known to
// be inside the enrolled subtree must be persisted and carried into the next
// cycle's ancestry seed — see the U14 Critical-bug fix note on
// classifyContainerFallback below). A legacy/garbage entry is treated as a
// bare link with no persisted folders, which is always safe to parse.
interface MicrosoftCursorRootEntry {
  link: string;
  folders?: string[];
}

type MicrosoftCursorRootValue = string | MicrosoftCursorRootEntry;

function parseMicrosoftCursor(raw: string | undefined): Record<string, MicrosoftCursorRootValue> {
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
  const result: Record<string, MicrosoftCursorRootValue> = {};
  for (const [cursorKey, value] of Object.entries(roots)) {
    if (typeof value === "string" && value.length > 0) {
      result[cursorKey] = value;
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const link = stringValue((value as { link?: unknown }).link);
    if (link === undefined) continue;
    const rawFolders = (value as { folders?: unknown }).folders;
    const folders = Array.isArray(rawFolders)
      ? rawFolders.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    result[cursorKey] = { link, folders };
  }
  return result;
}

function serializeMicrosoftCursor(roots: Record<string, MicrosoftCursorRootValue>): string {
  return JSON.stringify({ v: 1, roots });
}

function cursorEntryLink(entry: MicrosoftCursorRootValue | undefined): string | undefined {
  if (entry === undefined) return undefined;
  return typeof entry === "string" ? entry : entry.link;
}

function cursorEntryFolders(entry: MicrosoftCursorRootValue | undefined): string[] {
  if (entry === undefined || typeof entry === "string") return [];
  return entry.folders ?? [];
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
// when a fresh (non-resumed) container init 400s, or when a root already
// known (via its persisted cursor entry shape) to be in fallback mode
// resyncs.
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
// No ancestry/parent reasoning applies here (membership is a flat id
// lookup), so this is unaffected by the U14 Critical-bug fix below.
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

// PRIMARY container path (folder-scoped delta, `/drives/{d}/items/{f}/delta`):
// Graph itself scopes every returned item to that folder's subtree, so NO
// parent/ancestry filtering is applied here — trust Graph's own scoping.
//
// PROBE-2-DEPENDENT ASSUMPTION: "folder-scoped delta is subtree-scoped" is
// currently unverified against a real tenant — the same open question as
// whether/when it 400s (see containerFallbackUrl's "probe-deferred" note
// below; both are the same probe). If it turns out folder-scoped delta on
// some SharePoint library is NOT subtree-scoped, this path would UNDER-filter
// (include out-of-subtree items instead of excluding them) — a real residual
// risk, but a strictly lower-severity failure mode than the Critical bug this
// unit fixed: an under-filter means a few extra items get distilled that
// shouldn't be, not a legitimately-enrolled item silently disappearing. Track
// and confirm/correct when probe 2 runs against a live tenant.
//
// U14 Critical-bug fix note: an earlier version of this adapter re-derived
// ancestry from scratch every discover() call (`new Set([folderId])`) and
// applied an "outside subtree -> remove" check even on this primary path.
// That is provably wrong on a RESUMED incremental cycle: Graph delta sends
// only CHANGED items, so an edited file two-or-more levels under the
// enrolled folder can arrive in a page where its (unchanged) parent
// subfolder record is absent. With only `{folderId}` seeded, the file's
// `parentReference.id` never resolves into the ancestor set, so it was
// wrongly classified "outside subtree" and silently dropped — a real, silent
// data-loss bug on ordinary nested-folder edits. Leaning on Graph's own
// folder-scoped delta guarantee for this path removes the need to
// reconstruct ancestry at all. See classifyContainerFallback below for the
// one path (drive-root fallback) where ancestry genuinely has to be tracked,
// and how it's made safe across cycles.
function classifyContainerPrimary(
  raw: unknown,
  driveId: string,
  folderId: string,
): MicrosoftDeltaClassification | undefined {
  const id = deltaItemId(raw);
  if (id === undefined || id === folderId) return undefined; // root folder itself is not a source
  const item = raw as MicrosoftDeltaItem;
  const sourceId = `${driveId}:${id}`;
  if (item.deleted !== undefined) return { id: sourceId, action: "remove" };
  if (item.folder !== undefined) return undefined; // folders are never sources
  const eTag = stringValue(item.eTag);
  if (item.file === undefined || eTag === undefined) return { id: sourceId, action: "remove" };
  return { id: sourceId, action: "upsert", revision: eTag };
}

// FALLBACK container path only (drive-root delta, used when the primary
// folder-scoped delta 400s): the drive-root delta returns the WHOLE drive,
// so ancestry filtering by parentReference.id IS genuinely required here to
// restrict results to the enrolled subtree (delta omits parentReference.path
// entirely). Made safe against both bugs the Critical-bug review flagged:
//
//  1. Cross-cycle: the folder-id set discovered so far is PERSISTED in the
//     cursor (see MicrosoftCursorRootEntry.folders) and seeded back in on
//     every resumed walk, so an unchanged ancestor folder not resent this
//     cycle doesn't erase what was already learned.
//  2. Intra-walk ordering: `foldContainerAncestry` runs a two-pass fixpoint
//     over ALL items collected across every page of this walk BEFORE any
//     file is classified, so a nested file arriving before its subfolder
//     record (same page or a later one) still resolves correctly.
//
// Conservative-on-ambiguity rule: a file whose parent can't be resolved into
// the (fully folded) ancestor set is never REMOVED if it was already
// tracked — only an explicit `deleted` facet removes a previously-known
// item. An unresolved parent only prevents ADDING a not-yet-tracked item
// (the drive-root delta covers unrelated parts of the drive too, so an
// unresolved new item is presumed foreign, not ours). This trades a
// possible late remove (an item that truly moved out lingers until an
// explicit signal or a full resync) for never silently losing a legitimately
// in-scope item — the correct tradeoff per the Critical-bug review.
//
// KNOWN, DELIBERATE DEVIATION from R21/R37 (fallback path ONLY): R21 calls
// for removing an item whose parent has moved out of the enrolled subtree;
// R37 calls for that to resolve to available:false. In THIS path only, a
// genuinely moved-out item does NOT do either — it lingers in the present
// set (available:true, stale revision) until either an explicit `deleted`
// facet arrives or the root's next full resync (410) re-derives membership
// from scratch. That is a conscious trade, not an oversight: the
// alternative (treat an unresolved/ambiguous parent as "moved out") is
// exactly the mechanism that caused the Critical silent-data-loss bug this
// unit fixed, just relocated from every nested file to the narrower
// moved-out case. The primary folder-scoped path is NOT affected by this
// deviation — there, a moved-out file simply stops being returned by
// Graph's own subtree-scoped delta, so the engine's ordinary
// not-returned -> unavailable rule (R37) still fires correctly. A filed
// bead tracks revisiting this fallback-path gap once probe 2 confirms
// folder-scoped delta's real-world 400 rate; if folder-scoped delta turns
// out to be reliable enough, the fallback path (and this deviation) may
// rarely if ever be exercised in practice.
function applyContainerFallbackItem(
  raw: unknown,
  driveId: string,
  folderId: string,
  ancestorIds: ReadonlySet<string>,
  sources: Map<string, RemoteSource>,
): void {
  const id = deltaItemId(raw);
  if (id === undefined || id === folderId) return; // root folder itself is not a source
  const item = raw as MicrosoftDeltaItem;
  const sourceId = `${driveId}:${id}`;
  if (item.deleted !== undefined) {
    sources.delete(sourceId);
    return;
  }
  if (item.folder !== undefined) return; // folders: ancestry only, handled by foldContainerAncestry
  const parentId = deltaParentId(item);
  const inSubtree = parentId !== undefined && ancestorIds.has(parentId);
  const eTag = stringValue(item.eTag);
  if (inSubtree && item.file !== undefined && eTag !== undefined) {
    sources.set(sourceId, { id: sourceId, revision: eTag });
    return;
  }
  if (inSubtree) {
    // Confirmed in-subtree but not a usable file record (missing eTag, or a
    // non-file facet replacing a former file) — a definite signal, safe to
    // drop.
    sources.delete(sourceId);
    return;
  }
  // Parent unresolved (or resolved outside the known ancestor set): never
  // speculatively add an unconfirmed item, but never drop a previously-known
  // one either. See the conservative-on-ambiguity note above.
}

// Two-pass ancestry fold (part of the drive-root fallback path only): grows
// `ancestorIds` from `{folderId} ∪ persistedFolders` by repeatedly scanning
// every folder record collected across the WHOLE walk (all pages) until no
// further growth occurs. Running this to a fixpoint over the complete item
// set — rather than once, streaming, per page — is what makes a nested
// file's classification independent of whether its subfolder's record
// happens to arrive before or after it.
function foldContainerAncestry(
  items: readonly unknown[],
  folderId: string,
  persistedFolders: readonly string[],
): Set<string> {
  const ancestorIds = new Set<string>([folderId, ...persistedFolders]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const raw of items) {
      if (typeof raw !== "object" || raw === null) continue;
      const item = raw as MicrosoftDeltaItem;
      if (item.folder === undefined || item.deleted !== undefined) continue;
      const id = stringValue(item.id);
      if (id === undefined || ancestorIds.has(id)) continue;
      const parentId = deltaParentId(item);
      if (parentId !== undefined && ancestorIds.has(parentId)) {
        ancestorIds.add(id);
        grew = true;
      }
    }
  }
  return ancestorIds;
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

interface MicrosoftDeltaPagesResult {
  deltaLink: string;
  /** Raw items across every page, in stream order (unclassified). */
  items: unknown[];
}

// Follows @odata.nextLink pages from `initialUrl` to a terminal
// @odata.deltaLink, bounded by MICROSOFT_MAX_DELTA_PAGES with a repeated-link
// guard (mirrors google.ts's Drive-changes pagination exactly). Deliberately
// does NOT classify items itself — it just collects them in stream order —
// so a caller needing ancestry (the container fallback path) can fold
// ancestry over the COMPLETE item set before classifying anything, and a
// caller that doesn't (item-group roots, container primary) can classify in
// one pass. Last-occurrence-wins and delete-reappears-as-present both fall
// out naturally from classifying this list in its original (page) order into
// a Map.
async function walkMicrosoftDeltaPages(
  transport: MicrosoftHttpTransport,
  accessToken: string,
  limits: RequestLimits,
  sleep: (milliseconds: number) => Promise<void>,
  initialUrl: string,
): Promise<Result<MicrosoftDeltaPagesResult, Error>> {
  const items: unknown[] = [];
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
    for (const raw of body.value ?? []) items.push(raw);
    const deltaLink = stringValue(body["@odata.deltaLink"]);
    if (deltaLink !== undefined) return ok({ deltaLink, items });
    const nextLink = stringValue(body["@odata.nextLink"]);
    if (nextLink === undefined) {
      return err(new Error("Microsoft Graph delta response is missing a nextLink or deltaLink"));
    }
    url = nextLink;
  }
}

interface MicrosoftContainerWalkResult {
  mode: "primary" | "fallback";
  deltaLink: string;
  /** Fallback mode only: the subtree folder ids discovered/carried this walk. */
  folders?: string[];
  sources: Map<string, RemoteSource>;
}

async function walkContainerRoot(
  transport: MicrosoftHttpTransport,
  accessToken: string,
  limits: RequestLimits,
  sleep: (milliseconds: number) => Promise<void>,
  root: MicrosoftDeltaRoot,
  storedEntry: MicrosoftCursorRootValue | undefined,
  remembered: Map<string, RemoteSource>,
): Promise<Result<MicrosoftContainerWalkResult, Error>> {
  const folderId = root.folderId as string;

  const runPrimary = async (
    url: string,
    seed: Map<string, RemoteSource>,
  ): Promise<Result<MicrosoftContainerWalkResult, Error>> => {
    const pages = await walkMicrosoftDeltaPages(transport, accessToken, limits, sleep, url);
    if (!pages.ok) return pages;
    const sources = new Map(seed);
    for (const raw of pages.value.items) {
      const classified = classifyContainerPrimary(raw, root.driveId, folderId);
      if (classified === undefined) continue;
      if (classified.action === "remove") sources.delete(classified.id);
      else sources.set(classified.id, { id: classified.id, revision: classified.revision });
    }
    return ok({ mode: "primary", deltaLink: pages.value.deltaLink, sources });
  };

  const runFallback = async (
    url: string,
    seed: Map<string, RemoteSource>,
    persistedFolders: string[],
  ): Promise<Result<MicrosoftContainerWalkResult, Error>> => {
    const pages = await walkMicrosoftDeltaPages(transport, accessToken, limits, sleep, url);
    if (!pages.ok) return pages;
    const ancestorIds = foldContainerAncestry(pages.value.items, folderId, persistedFolders);
    const sources = new Map(seed);
    for (const raw of pages.value.items) {
      applyContainerFallbackItem(raw, root.driveId, folderId, ancestorIds, sources);
    }
    return ok({
      mode: "fallback",
      deltaLink: pages.value.deltaLink,
      folders: [...ancestorIds],
      sources,
    });
  };

  // A fresh (non-resumed) walk always tries the primary folder-scoped delta
  // first, falling back to the drive-root delta only if that 400s.
  const freshWalk = (): Promise<Result<MicrosoftContainerWalkResult, Error>> =>
    runPrimary(containerInitUrl(root.driveId, folderId), new Map()).then((primary) =>
      !primary.ok && isBadRequestError(primary.error)
        ? runFallback(containerFallbackUrl(root.driveId), new Map(), [folderId])
        : primary,
    );

  const resumedLink = cursorEntryLink(storedEntry);
  // The persisted cursor entry's own shape says which mode a resumed walk is
  // in — a bare string means primary (no ancestry needed), an object with a
  // `folders` array means fallback (see MicrosoftCursorRootEntry above) —
  // so a resumed walk never needs to re-probe with a 400 to rediscover this.
  const resumedMode: "primary" | "fallback" | undefined =
    resumedLink === undefined
      ? undefined
      : typeof storedEntry === "string"
        ? "primary"
        : "fallback";

  let result: Result<MicrosoftContainerWalkResult, Error>;
  if (resumedLink === undefined) {
    result = await freshWalk();
  } else if (resumedMode === "fallback") {
    result = await runFallback(resumedLink, remembered, cursorEntryFolders(storedEntry));
  } else {
    result = await runPrimary(resumedLink, remembered);
  }

  // 410 resync: drop this root's stored link/folders and re-enumerate from
  // scratch, bounded to a single re-init attempt so a persistently-invalid
  // delta session can't loop forever. A root already known to be in
  // fallback mode re-inits straight into the fallback endpoint (it already
  // positively knows the primary endpoint 400s for this drive); everything
  // else re-runs the fresh-walk probe.
  if (!result.ok && isResyncError(result.error)) {
    result =
      resumedMode === "fallback"
        ? await runFallback(containerFallbackUrl(root.driveId), new Map(), [folderId])
        : await freshWalk();
  }

  return result;
}

async function walkItemGroupRoot(
  transport: MicrosoftHttpTransport,
  accessToken: string,
  limits: RequestLimits,
  sleep: (milliseconds: number) => Promise<void>,
  root: MicrosoftDeltaRoot,
  storedLink: string | undefined,
  remembered: Map<string, RemoteSource>,
): Promise<Result<{ deltaLink: string; sources: Map<string, RemoteSource> }, Error>> {
  const memberIds = root.memberIds as Set<string>;

  const run = async (
    url: string,
    seed: Map<string, RemoteSource>,
  ): Promise<Result<{ deltaLink: string; sources: Map<string, RemoteSource> }, Error>> => {
    const pages = await walkMicrosoftDeltaPages(transport, accessToken, limits, sleep, url);
    if (!pages.ok) return pages;
    const sources = new Map(seed);
    for (const raw of pages.value.items) {
      const classified = classifyItemGroupDeltaItem(raw, root.driveId, memberIds);
      if (classified === undefined) continue;
      if (classified.action === "remove") sources.delete(classified.id);
      else sources.set(classified.id, { id: classified.id, revision: classified.revision });
    }
    return ok({ deltaLink: pages.value.deltaLink, sources });
  };

  let result =
    storedLink !== undefined
      ? await run(storedLink, remembered)
      : await run(itemGroupInitUrl(root.driveId), new Map());

  // 410 resync: re-enumerate this root only, bounded to a single re-init.
  if (!result.ok && isResyncError(result.error)) {
    result = await run(itemGroupInitUrl(root.driveId), new Map());
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
  const newRoots: Record<string, MicrosoftCursorRootValue> = {};
  const allSources = new Map<string, RemoteSource>();

  for (const root of roots) {
    const remembered = rememberedRootSources(state, root);
    if (root.kind === "container") {
      const walked = await walkContainerRoot(
        transport,
        state.accessToken,
        limits,
        sleep,
        root,
        storedRoots[root.cursorKey],
        remembered,
      );
      if (!walked.ok) return walked;
      newRoots[root.cursorKey] =
        walked.value.mode === "fallback"
          ? { link: walked.value.deltaLink, folders: walked.value.folders ?? [] }
          : walked.value.deltaLink;
      for (const [id, source] of walked.value.sources) allSources.set(id, source);
    } else {
      const walked = await walkItemGroupRoot(
        transport,
        state.accessToken,
        limits,
        sleep,
        root,
        cursorEntryLink(storedRoots[root.cursorKey]),
        remembered,
      );
      if (!walked.ok) return walked;
      newRoots[root.cursorKey] = walked.value.deltaLink;
      for (const [id, source] of walked.value.sources) allSources.set(id, source);
    }
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

// ---------------------------------------------------------------------------
// Fetch (U15): download + extractor routing + legacy pdf conversion.
//
// `source.id` is always `"<driveId>:<itemId>"` (the identity discover()
// produces — see discoverMicrosoftSources above). This section owns turning
// that id back into a Graph download, routing the downloaded bytes to
// src/extract by file extension, and returning the provider-neutral
// {id, revision, text} triple the engine persists.

// 25 MiB (design §11) — the SAME cap is checked twice: against the metadata
// `size` field BEFORE any download is attempted (the primary guard), and
// again while streaming the content response (belt-and-braces against a
// metadata/body size mismatch).
const MICROSOFT_MAX_CONTENT_BYTES = 25 * 1024 * 1024;

// R30: a prior failure with one of these reasons is a durable, re-download-
// proof verdict on THIS revision of the file — malware/size/type are
// properties of the bytes/metadata that a byte-identical re-download cannot
// change. A prior "fetch"/"distill"/"timeout"/etc. failure is NOT in this
// set: those can be transient (a network blip, a slow extractor that might
// succeed on retry), so those always re-attempt.
const MICROSOFT_SHORT_CIRCUIT_REASONS = new Set<SourceFailureReason>([
  "empty",
  "encrypted",
  "unsupported_type",
  "too_large",
]);

function taggedFetchError(reason: SourceFailureReason, message?: string): Error {
  return Object.assign(new Error(message ?? `Microsoft fetch failed: ${reason}`), { reason });
}

function splitSourceId(id: string): { driveId: string; itemId: string } | undefined {
  const index = id.indexOf(":");
  if (index <= 0 || index === id.length - 1) return undefined;
  return { driveId: id.slice(0, index), itemId: id.slice(index + 1) };
}

function fileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index).toLowerCase();
}

type MicrosoftFileClassification = "docx" | "pptx" | "pdf" | "legacy" | "unsupported";

// §3.1 extension->path table. `.doc`/`.ppt` route through the legacy
// Graph `?format=pdf` conversion (R28) instead of a native extractor.
function classifyExtension(name: string): MicrosoftFileClassification {
  const extension = fileExtension(name);
  if (extension === ".docx") return "docx";
  if (extension === ".pptx") return "pptx";
  if (extension === ".pdf") return "pdf";
  if (extension === ".doc" || extension === ".ppt") return "legacy";
  return "unsupported";
}

function itemMetadataUrl(driveId: string, itemId: string): string {
  return requestUrl(
    `${MICROSOFT_GRAPH_HOST}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`,
    { $select: "id,name,size,file,malware" },
  );
}

function itemContentUrl(driveId: string, itemId: string, legacyPdfConversion: boolean): string {
  return requestUrl(
    `${MICROSOFT_GRAPH_HOST}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`,
    legacyPdfConversion ? { format: "pdf" } : {},
  );
}

interface MicrosoftItemMetadata {
  id?: unknown;
  name?: unknown;
  size?: unknown;
  file?: unknown;
  malware?: unknown;
}

// Shared retry-on-429 wrapper for the fetch path's Graph calls (metadata GET
// and the initial content GET) — mirrors requestDeltaPageWithRetry's "honor
// Retry-After exactly once, only when short enough to absorb inline" policy,
// generalized to a plain Response instead of a parsed delta page (fetch also
// needs the raw Response here: to read a redirect Location header, and to
// stream the content body under a size cap, neither of which boundedJson's
// JSON-only contract supports).
async function requestWithRetry(
  transport: MicrosoftHttpTransport,
  url: string,
  init: RequestInit,
  limits: RequestLimits,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<Result<Response, Error>> {
  const first = await providerResponse(MICROSOFT, transport, url, init, limits);
  if (!first.ok) return first;
  if (first.value.status !== 429) return first;
  const retryAfterHeader = first.value.headers.get("retry-after");
  const retryAfterSeconds =
    retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader)
      ? Number(retryAfterHeader)
      : undefined;
  if (retryAfterSeconds === undefined || retryAfterSeconds > MICROSOFT_MAX_RETRY_AFTER_SECONDS) {
    return err(new Error("Microsoft Graph request was rate limited"));
  }
  await sleep(retryAfterSeconds * 1000);
  const retried = await providerResponse(MICROSOFT, transport, url, init, limits);
  if (!retried.ok) return retried;
  if (retried.value.status === 429) {
    return err(new Error("Microsoft Graph request was rate limited"));
  }
  return retried;
}

// Reads a content Response body as raw bytes, bounded by
// MICROSOFT_MAX_CONTENT_BYTES while streaming (not just trusting a declared
// Content-Length) — mirrors boundedJson's streaming-cap shape but returns
// bytes instead of parsed JSON, and reports a `too_large` SourceFailureReason
// (not a generic Error) so a caller doesn't have to re-derive the reason.
async function boundedContentBytes(
  response: Response,
  limits: RequestLimits,
): Promise<Result<Uint8Array, Error>> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MICROSOFT_MAX_CONTENT_BYTES) {
    return err(taggedFetchError("too_large", "Microsoft Graph content response is too large"));
  }
  if (response.body === null) {
    return err(new Error("Microsoft Graph content response is invalid"));
  }
  const reader = response.body.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async (): Promise<Result<Uint8Array, Error>> => {
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > MICROSOFT_MAX_CONTENT_BYTES) {
          await reader.cancel();
          return err(
            taggedFetchError("too_large", "Microsoft Graph content response is too large"),
          );
        }
        chunks.push(next.value);
      }
      return ok(
        new Uint8Array(
          Buffer.concat(
            chunks.map((chunk) => Buffer.from(chunk)),
            length,
          ),
        ),
      );
    };
    return await Promise.race([
      read(),
      new Promise<Result<Uint8Array, Error>>((resolve) => {
        timeout = setTimeout(() => {
          void reader.cancel();
          resolve(err(new Error("Microsoft Graph content request failed")));
        }, limits.timeoutMilliseconds);
      }),
    ]);
  } catch {
    return err(new Error("Microsoft Graph content request failed"));
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

// Resolves the per-enrollment includeSpeakerNotes flag (pptx-only; ignored
// for docx/pdf) for a given source. SourceState.enrollmentId is checked
// first (the forward-looking channel — see the U14 "KNOWN LIMITATION"
// comment on rememberedRootSources: no adapter populates it today, so this
// branch is currently always a miss in practice, kept for when that's
// wired). Failing that, an item-kind enrollment is matched exactly by
// driveId+remoteId (always unambiguous — an item enrollment names one
// specific file). A container-kind enrollment has no per-file membership
// recorded anywhere reachable from here, so it's matched only when exactly
// one container enrollment shares this drive (an unambiguous best-effort
// case); with more than one candidate, or none, this falls back to the
// provider-level config default.
function resolveIncludeSpeakerNotes(
  sourceId: string,
  driveId: string,
  itemId: string,
  state: ProviderState,
  config: MicrosoftProviderConfig,
): boolean {
  const enrollmentId = state.sources[sourceId]?.enrollmentId;
  if (enrollmentId !== undefined) {
    const record = state.enrollments?.[enrollmentId];
    if (record !== undefined) return record.includeSpeakerNotes;
  }
  const enrollments = Object.values(state.enrollments ?? {});
  const itemMatch = enrollments.find(
    (record) => record.kind === "item" && record.driveId === driveId && record.remoteId === itemId,
  );
  if (itemMatch !== undefined) return itemMatch.includeSpeakerNotes;
  const containerMatches = enrollments.filter(
    (record) => record.kind === "container" && record.driveId === driveId,
  );
  if (containerMatches.length === 1) return containerMatches[0].includeSpeakerNotes;
  return config.includeSpeakerNotes;
}

// Extends the engine's NormalizedRemoteSource with an adapter-local
// `extractor` tag for the legacy `.doc`/`.ppt` -> `?format=pdf` conversion
// path (R28), so this unit's own tests (and any future caller reading
// fetch()'s return value directly) can tell a lossy PDF-converted source
// from a native extraction. KNOWN LIMITATION: NormalizedRemoteSource and
// SourceState (src/integrations/engine.ts / types.ts) carry no field for
// this — reconcileProvider only ever reads {id, revision, text} off what
// fetch() returns and never persists an extractor tag, so this label does
// NOT currently survive into ProviderState.sources or reach a status route.
// A follow-up would need to thread an extractor/conversion tag through both
// contracts (a cross-adapter change, out of this unit's scope) before
// U18's status surface could display it.
interface MicrosoftNormalizedSource extends NormalizedRemoteSource {
  extractor?: "pdf-conversion";
}

async function fetchSource(
  transport: MicrosoftHttpTransport,
  limits: RequestLimits,
  sleep: (milliseconds: number) => Promise<void>,
  config: MicrosoftProviderConfig,
  source: RemoteSource,
  state: ProviderState,
): Promise<Result<NormalizedRemoteSource, Error>> {
  const ids = splitSourceId(source.id);
  if (ids === undefined) {
    return err(taggedFetchError("fetch", "Microsoft source id is malformed"));
  }
  const { driveId, itemId } = ids;

  // Step 1 (R30): short-circuit a durable prior failure on this exact,
  // unchanged revision without downloading anything.
  const previous = state.sources[source.id];
  if (
    previous?.lastFailure !== undefined &&
    MICROSOFT_SHORT_CIRCUIT_REASONS.has(previous.lastFailure.reason) &&
    previous.revision === source.revision
  ) {
    return err(taggedFetchError(previous.lastFailure.reason));
  }

  const accessToken = state.accessToken;

  // Step 2: metadata precheck (R29) — malware/size/type must be checked
  // BEFORE any content download is attempted.
  const metadataResponse = await requestWithRetry(
    transport,
    itemMetadataUrl(driveId, itemId),
    { headers: { authorization: `Bearer ${accessToken}` } },
    limits,
    sleep,
  );
  if (!metadataResponse.ok) return metadataResponse;
  if (metadataResponse.value.status === 403 || metadataResponse.value.status === 404) {
    return err(taggedFetchError("permission_revoked"));
  }
  if (metadataResponse.value.status < 200 || metadataResponse.value.status >= 300) {
    return err(
      new Error(
        `Microsoft Graph item metadata request failed with status ${metadataResponse.value.status}`,
      ),
    );
  }
  const metadataBody = await boundedJson(MICROSOFT, metadataResponse.value, limits);
  if (!metadataBody.ok) return metadataBody;
  const metadata = metadataBody.value as MicrosoftItemMetadata;

  if (metadata.malware !== undefined) {
    return err(taggedFetchError("malware"));
  }
  const size = typeof metadata.size === "number" ? metadata.size : undefined;
  if (size !== undefined && size > MICROSOFT_MAX_CONTENT_BYTES) {
    return err(taggedFetchError("too_large"));
  }
  const name = stringValue(metadata.name) ?? "";
  const classification = classifyExtension(name);
  if (classification === "unsupported") {
    return err(taggedFetchError("unsupported_type"));
  }
  const isLegacy = classification === "legacy";
  const kind: ExtractKind = isLegacy ? "pdf" : (classification as ExtractKind);

  // Step 3 (R21, SECURITY): download the content. Graph 302s to a
  // short-lived pre-authenticated (SAS) URL; that redirect MUST be followed
  // WITHOUT the Authorization header — sending the Graph bearer token to the
  // SAS host would leak it. `redirect: "manual"` stops the transport from
  // auto-following, so the Location header can be read and re-requested with
  // an explicitly bare init (no authorization header at all).
  const initialContent = await requestWithRetry(
    transport,
    itemContentUrl(driveId, itemId, isLegacy),
    { headers: { authorization: `Bearer ${accessToken}` }, redirect: "manual" },
    limits,
    sleep,
  );
  if (!initialContent.ok) return initialContent;
  let contentResponse = initialContent.value;
  if (contentResponse.status >= 300 && contentResponse.status < 400) {
    const location = contentResponse.headers.get("location");
    if (location === null || location.length === 0) {
      return err(new Error("Microsoft Graph content redirect is missing a Location header"));
    }
    // No Authorization header on this request — see the SECURITY note above.
    const redirected = await providerResponse(MICROSOFT, transport, location, {}, limits);
    if (!redirected.ok) return redirected;
    contentResponse = redirected.value;
  }
  if (contentResponse.status === 403 || contentResponse.status === 404) {
    return err(taggedFetchError("permission_revoked"));
  }
  if (contentResponse.status < 200 || contentResponse.status >= 300) {
    return err(
      new Error(`Microsoft Graph content request failed with status ${contentResponse.status}`),
    );
  }

  const bytes = await boundedContentBytes(contentResponse, limits);
  if (!bytes.ok) return bytes;

  // Step 4/5: extract. Legacy `.doc`/`.ppt` bytes are already PDF (Graph did
  // the conversion for us) and run through the same pdf extractor as a
  // native .pdf — lossy (no speaker notes), which is expected (R28).
  const includeSpeakerNotes = resolveIncludeSpeakerNotes(source.id, driveId, itemId, state, config);
  const extracted = await extractText(
    bytes.value,
    kind,
    DEFAULT_EXTRACT_LIMITS,
    undefined,
    includeSpeakerNotes,
  );
  if (!extracted.ok) {
    return err(taggedFetchError(extracted.error.reason, extracted.error.message));
  }

  // Step 6: echo the discovered revision (R21) so the engine's
  // fetched.value.revision === remote.revision equality check passes.
  const normalized: MicrosoftNormalizedSource = {
    id: source.id,
    revision: source.revision,
    text: extracted.value.text,
    ...(isLegacy ? { extractor: "pdf-conversion" } : {}),
  };
  return ok(normalized);
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
    fetch: (source, state) => fetchSource(transport, limits, defaultSleep, config, source, state),
  };
}
