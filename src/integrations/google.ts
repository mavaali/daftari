// Google Docs integration adapter. It owns only Google OAuth and HTTP; the
// provider-neutral engine owns persistence, reconciliation, and distillation.

import { err, ok, type Result } from "../frontmatter/types.js";
import type {
  AuthorizationRequest,
  CodeExchange,
  ProviderAdapter,
  ProviderTokens,
  RemoteSource,
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

interface GoogleFile {
  id?: unknown;
  mimeType?: unknown;
  version?: unknown;
  trashed?: unknown;
}

interface GoogleFilesResponse {
  files?: unknown;
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

async function jsonResponse(
  transport: GoogleHttpTransport,
  url: string,
  init: RequestInit,
): Promise<Result<unknown, Error>> {
  let response: Response;
  try {
    response = await transport(url, init);
  } catch {
    return err(new Error("Google request failed"));
  }
  if (!response.ok) return err(new Error(`Google request failed with status ${response.status}`));
  try {
    return ok(await response.json());
  } catch {
    return err(new Error("Google returned an invalid JSON response"));
  }
}

async function listFiles(
  transport: GoogleHttpTransport,
  state: ProviderState,
): Promise<Result<RemoteSource[], Error>> {
  const sources = new Map<string, RemoteSource>();
  let nextPageToken: string | undefined;
  do {
    const response = await jsonResponse(
      transport,
      requestUrl(`${GOOGLE_DRIVE_URL}/files`, {
        corpora: "allDrives",
        fields: "nextPageToken,files(id,mimeType,version,trashed)",
        includeItemsFromAllDrives: "true",
        pageSize: "1000",
        pageToken: nextPageToken,
        q: `mimeType = '${GOOGLE_DOCUMENT_MIME}' and trashed = false`,
        supportsAllDrives: "true",
      }),
      { headers: authorizationHeaders(state.accessToken) },
    );
    if (!response.ok) return response;
    const page = response.value as GoogleFilesResponse;
    if (page.files !== undefined && !Array.isArray(page.files)) {
      return err(new Error("Google Drive files response is invalid"));
    }
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
): Promise<Result<string, Error>> {
  const response = await jsonResponse(
    transport,
    requestUrl(`${GOOGLE_DRIVE_URL}/changes/startPageToken`, { supportsAllDrives: "true" }),
    { headers: authorizationHeaders(state.accessToken) },
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

function rememberSources(state: ProviderState, sources: RemoteSource[], now: () => Date): void {
  const lastSeenAt = now().toISOString();
  for (const source of sources) {
    const previous = state.sources[source.id];
    state.sources[source.id] = {
      id: source.id,
      revision: source.revision,
      contentHash: previous?.contentHash ?? "",
      available: true,
      lastSeenAt,
      ...(previous?.lastDistillRunId === undefined
        ? {}
        : { lastDistillRunId: previous.lastDistillRunId }),
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
): Promise<Result<ChangedSources | undefined, Error>> {
  const sources = rememberedSources(state);
  let nextPageToken: string | undefined = state.cursor;
  let nextCursor: string | undefined;
  do {
    let response: Response;
    try {
      response = await transport(
        requestUrl(`${GOOGLE_DRIVE_URL}/changes`, {
          fields:
            "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,mimeType,version,trashed))",
          includeItemsFromAllDrives: "true",
          pageToken: nextPageToken,
          supportsAllDrives: "true",
        }),
        { headers: authorizationHeaders(state.accessToken) },
      );
    } catch {
      return err(new Error("Google request failed"));
    }
    if (response.status === 410) {
      return ok(undefined);
    }
    if (!response.ok) return err(new Error(`Google request failed with status ${response.status}`));
    let page: GoogleChangesResponse;
    try {
      page = (await response.json()) as GoogleChangesResponse;
    } catch {
      return err(new Error("Google returned an invalid JSON response"));
    }
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
): Promise<Result<RemoteSource[], Error>> {
  const cursor = await startPageToken(transport, state);
  if (!cursor.ok) return cursor;
  const sources = await listFiles(transport, state);
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
): Promise<Result<ProviderTokens, Error>> {
  const response = await jsonResponse(transport, GOOGLE_TOKEN_URL, {
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
  });
  if (!response.ok) return response;
  const tokens = response.value as GoogleTokenResponse;
  const accessToken = stringValue(tokens.access_token);
  const refreshToken = stringValue(tokens.refresh_token);
  if (accessToken === undefined || refreshToken === undefined) {
    return err(new Error("Google OAuth token response is incomplete"));
  }
  const accessTokenExpiresAt = tokenExpiration(tokens.expires_in, now);
  return ok({
    accessToken,
    refreshToken,
    ...(accessTokenExpiresAt === undefined ? {} : { accessTokenExpiresAt }),
  });
}

export function createGoogleDocsAdapter(options: GoogleDocsAdapterOptions): ProviderAdapter {
  const transport = options.transport ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  return {
    name: "google",
    authorizationUrl: (input) => authorizationUrl(input, options.redirectUri),
    exchangeCode: (input) => exchangeCode(transport, options.redirectUri, now, input),
    discover: async (state) => {
      let discovered: Result<RemoteSource[], Error>;
      if (state.cursor === undefined) {
        discovered = await fullDiscovery(transport, state);
      } else {
        const changes = await changedSources(transport, state);
        if (!changes.ok) return changes;
        if (changes.value === undefined) {
          discovered = await fullDiscovery(transport, state);
        } else {
          state.cursor = changes.value.cursor;
          discovered = ok(changes.value.sources);
        }
      }
      if (!discovered.ok) return discovered;
      rememberSources(state, discovered.value, now);
      return discovered;
    },
    fetch: async (source, state) => {
      const response = await jsonResponse(
        transport,
        requestUrl(`${GOOGLE_DOCS_URL}/documents/${encodeURIComponent(source.id)}`, {
          includeTabsContent: "true",
        }),
        { headers: authorizationHeaders(state.accessToken) },
      );
      if (!response.ok) return response;
      return ok({ ...source, text: normalizeGoogleDocument(response.value as GoogleDocument) });
    },
  };
}
