// Google Docs integration adapter. It owns only Google OAuth and HTTP; the
// provider-neutral engine owns persistence, reconciliation, and distillation.

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { err, ok, type Result } from "../frontmatter/types.js";
import type {
  AuthorizationRequest,
  CodeExchange,
  EnsureWebhookInput,
  ProviderAdapter,
  ProviderTokens,
  RefreshTokenRequest,
  RemoteSource,
  VerifiedWebhook,
  WebhookChannel,
  WebhookRequest,
} from "./engine.js";
import type { ProviderState } from "./types.js";

const GOOGLE_DOCUMENT_MIME = "application/vnd.google-apps.document";
const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_URL = "https://www.googleapis.com/drive/v3";
const GOOGLE_DOCS_URL = "https://docs.googleapis.com/v1";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
].join(" ");
const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

interface GoogleFile {
  id?: unknown;
  mimeType?: unknown;
  version?: unknown;
  trashed?: unknown;
}

interface GoogleFilesResponse {
  files?: unknown;
  incompleteSearch?: unknown;
  nextPageToken?: unknown;
}

interface GoogleChangesResponse {
  changes?: unknown;
  nextPageToken?: unknown;
  newStartPageToken?: unknown;
}

interface GoogleChange {
  fileId?: unknown;
  removed?: unknown;
  file?: unknown;
}

interface GoogleStartPageTokenResponse {
  startPageToken?: unknown;
}

interface GoogleTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

interface GoogleChannelResponse {
  id?: unknown;
  expiration?: unknown;
}

interface GoogleTextRun {
  content?: unknown;
}

interface GoogleParagraphElement {
  textRun?: GoogleTextRun;
}

interface GoogleParagraph {
  elements?: GoogleParagraphElement[];
}

interface GoogleTableCell {
  content?: GoogleStructuralElement[];
}

interface GoogleTableRow {
  tableCells?: GoogleTableCell[];
}

interface GoogleTable {
  tableRows?: GoogleTableRow[];
}

interface GoogleStructuralElement {
  paragraph?: GoogleParagraph;
  table?: GoogleTable;
  tableOfContents?: { content?: GoogleStructuralElement[] };
}

interface GoogleTab {
  childTabs?: GoogleTab[];
  documentTab?: { body?: { content?: GoogleStructuralElement[] } };
}

interface GoogleDocument {
  body?: { content?: GoogleStructuralElement[] };
  tabs?: GoogleTab[];
}

export type GoogleHttpTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface GoogleDocsAdapterOptions {
  redirectUri: string;
  transport?: GoogleHttpTransport;
  now?: () => Date;
  requestTimeoutMilliseconds?: number;
  maxResponseBytes?: number;
}

interface RequestLimits {
  timeoutMilliseconds: number;
  maxResponseBytes: number;
}

function authorizationHeaders(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
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

function nativeGoogleDoc(file: unknown): RemoteSource | undefined {
  if (typeof file !== "object" || file === null) return undefined;
  const candidate = file as GoogleFile;
  const id = stringValue(candidate.id);
  const version = stringValue(candidate.version);
  if (
    id === undefined ||
    version === undefined ||
    candidate.mimeType !== GOOGLE_DOCUMENT_MIME ||
    candidate.trashed === true
  ) {
    return undefined;
  }
  return { id, revision: version };
}

function pageToken(value: unknown): string | undefined {
  return stringValue(value);
}

function paragraphText(paragraph: GoogleParagraph): string {
  const text = (paragraph.elements ?? [])
    .map((element) => element.textRun?.content)
    .filter((content): content is string => typeof content === "string")
    .join("")
    .replace(/\r\n?/g, "\n");
  if (text.length === 0) return "";
  return text.endsWith("\n") ? text : `${text}\n`;
}

function structuralText(element: GoogleStructuralElement): string {
  if (element.paragraph !== undefined) return paragraphText(element.paragraph);
  if (element.table !== undefined) {
    return (element.table.tableRows ?? [])
      .flatMap((row) => row.tableCells ?? [])
      .flatMap((cell) => cell.content ?? [])
      .map(structuralText)
      .join("");
  }
  if (element.tableOfContents !== undefined) {
    return (element.tableOfContents.content ?? []).map(structuralText).join("");
  }
  return "";
}

function tabText(tab: GoogleTab): string {
  const body = (tab.documentTab?.body?.content ?? []).map(structuralText).join("");
  return body + (tab.childTabs ?? []).map(tabText).join("");
}

function normalizeGoogleDocument(document: GoogleDocument): string {
  const text =
    document.tabs !== undefined && document.tabs.length > 0
      ? document.tabs.map(tabText).join("")
      : (document.body?.content ?? []).map(structuralText).join("");
  return text.replace(/\n+$/, "");
}

function tokenExpiration(expiresIn: unknown, now: () => Date): string | undefined {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return undefined;
  }
  return new Date(now().getTime() + expiresIn * 1000).toISOString();
}

function providerTokens(
  response: GoogleTokenResponse,
  now: () => Date,
  retainedRefreshToken?: string,
): Result<ProviderTokens, Error> {
  const accessToken = stringValue(response.access_token);
  const refreshToken = stringValue(response.refresh_token) ?? retainedRefreshToken;
  if (accessToken === undefined || refreshToken === undefined || refreshToken.length === 0) {
    return err(new Error("Google OAuth token response is incomplete"));
  }
  const accessTokenExpiresAt = tokenExpiration(response.expires_in, now);
  return ok({
    accessToken,
    refreshToken,
    ...(accessTokenExpiresAt === undefined ? {} : { accessTokenExpiresAt }),
  });
}

async function boundedJson(
  response: Response,
  limits: RequestLimits,
): Promise<Result<unknown, Error>> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > limits.maxResponseBytes) {
    return err(new Error("Google response body is too large"));
  }
  if (response.body === null) return err(new Error("Google returned an invalid JSON response"));
  const reader = response.body.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async (): Promise<Result<unknown, Error>> => {
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > limits.maxResponseBytes) {
          await reader.cancel();
          return err(new Error("Google response body is too large"));
        }
        chunks.push(next.value);
      }
      const body = Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        length,
      ).toString("utf8");
      try {
        return ok(JSON.parse(body));
      } catch {
        return err(new Error("Google returned an invalid JSON response"));
      }
    };
    return await Promise.race([
      read(),
      new Promise<Result<unknown, Error>>((resolve) => {
        timeout = setTimeout(() => {
          void reader.cancel();
          resolve(err(new Error("Google request failed")));
        }, limits.timeoutMilliseconds);
      }),
    ]);
  } catch {
    return err(new Error("Google request failed"));
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function providerResponse(
  transport: GoogleHttpTransport,
  url: string,
  init: RequestInit,
  limits: RequestLimits,
): Promise<Result<Response, Error>> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("deadline"));
      }, limits.timeoutMilliseconds);
    });
    const response = await Promise.race([
      transport(url, { ...init, signal: controller.signal }),
      deadline,
    ]);
    return ok(response);
  } catch {
    return err(new Error("Google request failed"));
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function jsonResponse(
  transport: GoogleHttpTransport,
  url: string,
  init: RequestInit,
  limits: RequestLimits,
): Promise<Result<unknown, Error>> {
  const fetched = await providerResponse(transport, url, init, limits);
  if (!fetched.ok) return fetched;
  const response = fetched.value;
  if (!response.ok) return err(new Error(`Google request failed with status ${response.status}`));
  return boundedJson(response, limits);
}

async function listFiles(
  transport: GoogleHttpTransport,
  state: ProviderState,
  limits: RequestLimits,
): Promise<Result<RemoteSource[], Error>> {
  const sources = new Map<string, RemoteSource>();
  let nextPageToken: string | undefined;
  do {
    const response = await jsonResponse(
      transport,
      requestUrl(`${GOOGLE_DRIVE_URL}/files`, {
        corpora: "allDrives",
        fields: "nextPageToken,incompleteSearch,files(id,mimeType,version,trashed)",
        includeItemsFromAllDrives: "true",
        pageSize: "1000",
        pageToken: nextPageToken,
        q: `mimeType = '${GOOGLE_DOCUMENT_MIME}' and trashed = false`,
        supportsAllDrives: "true",
      }),
      { headers: authorizationHeaders(state.accessToken) },
      limits,
    );
    if (!response.ok) return response;
    const page = response.value as GoogleFilesResponse;
    if (page.files !== undefined && !Array.isArray(page.files)) {
      return err(new Error("Google Drive files response is invalid"));
    }
    if (page.incompleteSearch !== undefined && typeof page.incompleteSearch !== "boolean") {
      return err(new Error("Google Drive files response is invalid"));
    }
    if (page.incompleteSearch) return err(new Error("Google Drive file search is incomplete"));
    for (const file of page.files ?? []) {
      const source = nativeGoogleDoc(file);
      if (source !== undefined) sources.set(source.id, source);
    }
    nextPageToken = pageToken(page.nextPageToken);
  } while (nextPageToken !== undefined);
  return ok([...sources.values()].sort((left, right) => left.id.localeCompare(right.id)));
}

async function startPageToken(
  transport: GoogleHttpTransport,
  state: ProviderState,
  limits: RequestLimits,
): Promise<Result<string, Error>> {
  const response = await jsonResponse(
    transport,
    requestUrl(`${GOOGLE_DRIVE_URL}/changes/startPageToken`, { supportsAllDrives: "true" }),
    { headers: authorizationHeaders(state.accessToken) },
    limits,
  );
  if (!response.ok) return response;
  const cursor = pageToken((response.value as GoogleStartPageTokenResponse).startPageToken);
  return cursor === undefined
    ? err(new Error("Google Drive start page token is missing"))
    : ok(cursor);
}

function rememberedSources(state: ProviderState): Map<string, RemoteSource> {
  const sources = new Map<string, RemoteSource>();
  for (const source of Object.values(state.sources)) {
    if (
      source.available &&
      typeof source.id === "string" &&
      source.id.length > 0 &&
      typeof source.revision === "string" &&
      source.revision.length > 0
    ) {
      sources.set(source.id, { id: source.id, revision: source.revision });
    }
  }
  return sources;
}

function rememberNewSources(state: ProviderState, sources: RemoteSource[], now: () => Date): void {
  const lastSeenAt = now().toISOString();
  for (const source of sources) {
    if (state.sources[source.id] !== undefined) continue;
    state.sources[source.id] = {
      id: source.id,
      revision: source.revision,
      contentHash: "",
      available: true,
      lastSeenAt,
    };
  }
}

function changeFileId(change: GoogleChange): string | undefined {
  return stringValue(change.fileId);
}

function applyChange(sources: Map<string, RemoteSource>, change: unknown): void {
  if (typeof change !== "object" || change === null) return;
  const entry = change as GoogleChange;
  const fileId = changeFileId(entry);
  if (entry.removed === true || entry.file === undefined) {
    if (fileId !== undefined) sources.delete(fileId);
    return;
  }
  const source = nativeGoogleDoc(entry.file);
  if (source !== undefined) {
    sources.set(source.id, source);
  } else if (fileId !== undefined) {
    sources.delete(fileId);
  }
}

interface ChangedSources {
  cursor: string;
  sources: RemoteSource[];
}

async function changedSources(
  transport: GoogleHttpTransport,
  state: ProviderState,
  limits: RequestLimits,
): Promise<Result<ChangedSources | undefined, Error>> {
  const sources = rememberedSources(state);
  let nextPageToken: string | undefined = state.cursor;
  let nextCursor: string | undefined;
  do {
    const fetched = await providerResponse(
      transport,
      requestUrl(`${GOOGLE_DRIVE_URL}/changes`, {
        fields:
          "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,mimeType,version,trashed))",
        includeItemsFromAllDrives: "true",
        pageToken: nextPageToken,
        supportsAllDrives: "true",
      }),
      { headers: authorizationHeaders(state.accessToken) },
      limits,
    );
    if (!fetched.ok) return fetched;
    const response = fetched.value;
    if (response.status === 410) {
      return ok(undefined);
    }
    if (!response.ok) return err(new Error(`Google request failed with status ${response.status}`));
    const parsed = await boundedJson(response, limits);
    if (!parsed.ok) return parsed;
    const page = parsed.value as GoogleChangesResponse;
    if (page.changes !== undefined && !Array.isArray(page.changes)) {
      return err(new Error("Google Drive changes response is invalid"));
    }
    for (const change of page.changes ?? []) applyChange(sources, change);
    nextPageToken = pageToken(page.nextPageToken);
    const terminalCursor = pageToken(page.newStartPageToken);
    if (terminalCursor !== undefined) nextCursor = terminalCursor;
  } while (nextPageToken !== undefined);
  if (nextCursor === undefined) return err(new Error("Google Drive change cursor is missing"));
  return ok({
    cursor: nextCursor,
    sources: [...sources.values()].sort((left, right) => left.id.localeCompare(right.id)),
  });
}

async function fullDiscovery(
  transport: GoogleHttpTransport,
  state: ProviderState,
  limits: RequestLimits,
): Promise<Result<RemoteSource[], Error>> {
  const cursor = await startPageToken(transport, state, limits);
  if (!cursor.ok) return cursor;
  const sources = await listFiles(transport, state, limits);
  if (!sources.ok) return sources;
  state.cursor = cursor.value;
  return sources;
}

function authorizationUrl(input: AuthorizationRequest, redirectUri: string): string {
  return requestUrl(GOOGLE_AUTHORIZATION_URL, {
    access_type: "offline",
    client_id: input.clientId,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod,
    include_granted_scopes: "true",
    prompt: "consent",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    state: input.state,
  });
}

async function exchangeCode(
  transport: GoogleHttpTransport,
  redirectUri: string,
  now: () => Date,
  input: CodeExchange,
  limits: RequestLimits,
): Promise<Result<ProviderTokens, Error>> {
  const response = await jsonResponse(
    transport,
    GOOGLE_TOKEN_URL,
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
      }).toString(),
    },
    limits,
  );
  if (!response.ok) return response;
  return providerTokens(response.value as GoogleTokenResponse, now);
}

async function refreshTokens(
  transport: GoogleHttpTransport,
  now: () => Date,
  input: RefreshTokenRequest,
  limits: RequestLimits,
): Promise<Result<ProviderTokens, Error>> {
  const response = await jsonResponse(
    transport,
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
      }).toString(),
    },
    limits,
  );
  if (!response.ok) return response;
  return providerTokens(response.value as GoogleTokenResponse, now, input.refreshToken);
}

function currentWebhook(state: ProviderState, renewBefore: Date): WebhookChannel | undefined {
  const webhook = state.webhook;
  if (webhook?.expiresAt === undefined) return undefined;
  const expiresAt = Date.parse(webhook.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > renewBefore.getTime() ? webhook : undefined;
}

function validHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function channelExpiration(value: unknown): Result<string | undefined, Error> {
  if (value === undefined) return ok(undefined);
  const raw = stringValue(value);
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return err(new Error("Google webhook expiration is invalid"));
  }
  const expiration = new Date(Number(raw));
  return Number.isNaN(expiration.getTime())
    ? err(new Error("Google webhook expiration is invalid"))
    : ok(expiration.toISOString());
}

async function ensureWebhook(
  transport: GoogleHttpTransport,
  state: ProviderState,
  input: EnsureWebhookInput,
  limits: RequestLimits,
): Promise<Result<WebhookChannel, Error>> {
  if (!validHttpsUrl(input.callbackUrl)) {
    return err(new Error("Google webhook callback URL must use HTTPS"));
  }
  if (state.cursor === undefined) {
    return err(new Error("Google webhook requires a Drive change cursor"));
  }
  const current = currentWebhook(state, input.renewBefore);
  if (current !== undefined) return ok(current);

  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const response = await jsonResponse(
    transport,
    requestUrl(`${GOOGLE_DRIVE_URL}/changes/watch`, {
      includeItemsFromAllDrives: "true",
      pageToken: state.cursor,
      supportsAllDrives: "true",
    }),
    {
      method: "POST",
      headers: {
        ...authorizationHeaders(state.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ id, type: "web_hook", address: input.callbackUrl, token: secret }),
    },
    limits,
  );
  if (!response.ok) return response;
  const channel = response.value as GoogleChannelResponse;
  if (stringValue(channel.id) !== id) {
    return err(new Error("Google webhook response has an invalid channel ID"));
  }
  const expiresAt = channelExpiration(channel.expiration);
  if (!expiresAt.ok) return expiresAt;
  return ok({
    id,
    secret,
    ...(expiresAt.value === undefined ? {} : { expiresAt: expiresAt.value }),
  });
}

function webhookHeader(headers: WebhookRequest["headers"], name: string): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function equalWebhookSecret(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function verifyWebhook(
  input: WebhookRequest,
  state: ProviderState,
): Promise<Result<VerifiedWebhook, Error>> {
  const webhook = state.webhook;
  const channelId = webhookHeader(input.headers, "x-goog-channel-id");
  const token = webhookHeader(input.headers, "x-goog-channel-token");
  const resourceState = webhookHeader(input.headers, "x-goog-resource-state");
  const messageNumber = webhookHeader(input.headers, "x-goog-message-number");
  if (
    webhook === undefined ||
    channelId !== webhook.id ||
    token === undefined ||
    !equalWebhookSecret(token, webhook.secret) ||
    messageNumber === undefined ||
    (resourceState !== "sync" && resourceState !== "change" && resourceState !== "changed")
  ) {
    return err(new Error("Google webhook is invalid"));
  }
  return ok({
    kind: "event",
    eventId: `${channelId}:${messageNumber}`,
    hint: { kind: "reconcile" },
  });
}

export function createGoogleDocsAdapter(options: GoogleDocsAdapterOptions): ProviderAdapter {
  const transport = options.transport ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const limits: RequestLimits = {
    timeoutMilliseconds: options.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  };
  return {
    name: "google",
    authorizationUrl: (input) => authorizationUrl(input, options.redirectUri),
    exchangeCode: (input) => exchangeCode(transport, options.redirectUri, now, input, limits),
    refreshTokens: (input) => refreshTokens(transport, now, input, limits),
    ensureWebhook: (state, input) => ensureWebhook(transport, state, input, limits),
    verifyWebhook,
    discover: async (state) => {
      let discovered: Result<RemoteSource[], Error>;
      if (state.cursor === undefined) {
        discovered = await fullDiscovery(transport, state, limits);
      } else {
        const changes = await changedSources(transport, state, limits);
        if (!changes.ok) return changes;
        if (changes.value === undefined) {
          discovered = await fullDiscovery(transport, state, limits);
        } else {
          state.cursor = changes.value.cursor;
          discovered = ok(changes.value.sources);
        }
      }
      if (discovered.ok) rememberNewSources(state, discovered.value, now);
      return discovered;
    },
    fetch: async (source, state) => {
      const response = await jsonResponse(
        transport,
        requestUrl(`${GOOGLE_DOCS_URL}/documents/${encodeURIComponent(source.id)}`, {
          includeTabsContent: "true",
        }),
        { headers: authorizationHeaders(state.accessToken) },
        limits,
      );
      if (!response.ok) return response;
      return ok({ ...source, text: normalizeGoogleDocument(response.value as GoogleDocument) });
    },
  };
}
