// Notion integration adapter. It owns Notion OAuth, API HTTP, block
// normalization, and signed webhook interpretation. The provider-neutral
// engine owns persistence, reconciliation, and distillation.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { err, ok, type Result } from "../frontmatter/types.js";
import type {
  AuthorizationRequest,
  CodeExchange,
  ProviderAdapter,
  ProviderTokens,
  RefreshHint,
  RefreshTokenRequest,
  RemoteSource,
  VerifiedWebhook,
  WebhookRequest,
} from "./engine.js";
import type { ProviderState } from "./types.js";

const NOTION_AUTHORIZATION_URL = "https://api.notion.com/v1/oauth/authorize";
const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_TOKEN_URL = `${NOTION_API_URL}/oauth/token`;
const NOTION_VERSION = "2026-03-11";

interface NotionTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

interface NotionSearchResponse {
  results?: unknown;
  has_more?: unknown;
  next_cursor?: unknown;
}

interface NotionPage {
  object?: unknown;
  id?: unknown;
  last_edited_time?: unknown;
  in_trash?: unknown;
  archived?: unknown;
  properties?: unknown;
}

interface NotionBlockChildrenResponse {
  results?: unknown;
  has_more?: unknown;
  next_cursor?: unknown;
}

interface NotionBlock {
  id?: unknown;
  type?: unknown;
  has_children?: unknown;
  [key: string]: unknown;
}

interface NotionEvent {
  id?: unknown;
  type?: unknown;
  entity?: unknown;
}

interface NotionEntity {
  id?: unknown;
  type?: unknown;
}

interface RichText {
  plain_text?: unknown;
}

export type NotionHttpTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface NotionAdapterOptions {
  redirectUri: string;
  transport?: NotionHttpTransport;
  now?: () => Date;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function notionHeaders(accessToken: string): Record<string, string> {
  return {
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "notion-version": NOTION_VERSION,
  };
}

function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

function tokenExpiration(expiresIn: unknown, now: () => Date): string | undefined {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return undefined;
  }
  return new Date(now().getTime() + expiresIn * 1000).toISOString();
}

async function jsonResponse(
  transport: NotionHttpTransport,
  url: string,
  init: RequestInit,
): Promise<Result<unknown, Error>> {
  let response: Response;
  try {
    response = await transport(url, init);
  } catch {
    return err(new Error("Notion request failed"));
  }
  if (!response.ok) return err(new Error(`Notion request failed with status ${response.status}`));
  try {
    return ok(await response.json());
  } catch {
    return err(new Error("Notion returned an invalid JSON response"));
  }
}

function authorizationUrl(input: AuthorizationRequest, redirectUri: string): string {
  const url = new URL(NOTION_AUTHORIZATION_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("owner", "user");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  return url.toString();
}

function tokenRequestHeaders(clientId: string, clientSecret: string): Record<string, string> {
  return {
    accept: "application/json",
    authorization: basicAuthorization(clientId, clientSecret),
    "content-type": "application/json",
    "notion-version": NOTION_VERSION,
  };
}

function providerTokens(value: unknown, now: () => Date): Result<ProviderTokens, Error> {
  if (typeof value !== "object" || value === null) {
    return err(new Error("Notion OAuth token response is incomplete"));
  }
  const response = value as NotionTokenResponse;
  const accessToken = stringValue(response.access_token);
  const refreshToken = stringValue(response.refresh_token);
  if (accessToken === undefined || refreshToken === undefined) {
    return err(new Error("Notion OAuth token response is incomplete"));
  }
  const accessTokenExpiresAt = tokenExpiration(response.expires_in, now);
  return ok({
    accessToken,
    refreshToken,
    ...(accessTokenExpiresAt === undefined ? {} : { accessTokenExpiresAt }),
  });
}

async function exchangeCode(
  transport: NotionHttpTransport,
  redirectUri: string,
  now: () => Date,
  input: CodeExchange,
): Promise<Result<ProviderTokens, Error>> {
  const response = await jsonResponse(transport, NOTION_TOKEN_URL, {
    method: "POST",
    headers: tokenRequestHeaders(input.clientId, input.clientSecret),
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: redirectUri,
    }),
  });
  return response.ok ? providerTokens(response.value, now) : response;
}

async function refreshTokens(
  transport: NotionHttpTransport,
  now: () => Date,
  input: RefreshTokenRequest,
): Promise<Result<ProviderTokens, Error>> {
  const response = await jsonResponse(transport, NOTION_TOKEN_URL, {
    method: "POST",
    headers: tokenRequestHeaders(input.clientId, input.clientSecret),
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    }),
  });
  return response.ok ? providerTokens(response.value, now) : response;
}

function remotePage(value: unknown): RemoteSource | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const page = value as NotionPage;
  const id = stringValue(page.id);
  const revision = stringValue(page.last_edited_time);
  if (
    page.object !== "page" ||
    id === undefined ||
    revision === undefined ||
    page.in_trash === true ||
    page.archived === true
  ) {
    return undefined;
  }
  return { id, revision };
}

function validPage(results: unknown): results is unknown[] {
  return Array.isArray(results);
}

async function discoverPages(
  transport: NotionHttpTransport,
  state: ProviderState,
): Promise<Result<RemoteSource[], Error>> {
  const sources = new Map<string, RemoteSource>();
  let cursor: string | undefined;
  do {
    const response = await jsonResponse(transport, `${NOTION_API_URL}/search`, {
      method: "POST",
      headers: notionHeaders(state.accessToken),
      body: JSON.stringify({
        page_size: 100,
        ...(cursor === undefined ? {} : { start_cursor: cursor }),
      }),
    });
    if (!response.ok) return response;
    const page = response.value as NotionSearchResponse;
    if (!validPage(page.results)) return err(new Error("Notion search response is invalid"));
    for (const item of page.results) {
      const source = remotePage(item);
      if (source !== undefined) sources.set(source.id, source);
    }
    if (page.has_more === true) {
      cursor = stringValue(page.next_cursor);
      if (cursor === undefined) return err(new Error("Notion search cursor is missing"));
    } else {
      cursor = undefined;
    }
  } while (cursor !== undefined);
  return ok([...sources.values()].sort((left, right) => left.id.localeCompare(right.id)));
}

function richText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((part) =>
      typeof part === "object" && part !== null
        ? (stringValue((part as RichText).plain_text) ?? "")
        : "",
    )
    .join("")
    .replace(/\r\n?/g, "\n");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function pageTitle(page: NotionPage): string {
  const properties = objectValue(page.properties);
  if (properties === undefined) return "";
  for (const property of Object.values(properties)) {
    const value = objectValue(property);
    if (value?.type === "title") return richText(value.title);
  }
  return "";
}

function blockText(block: NotionBlock): string {
  const type = stringValue(block.type);
  if (type === undefined) return "";
  const value = objectValue(block[type]);
  if (type === "child_page" || type === "child_database") {
    return stringValue(value?.title) ?? "";
  }
  if (type === "equation") return stringValue(value?.expression) ?? "";
  if (type === "divider") return "---";
  return richText(value?.rich_text);
}

function renderedBlockLine(block: NotionBlock, depth: number): string | undefined {
  const type = stringValue(block.type);
  const text = blockText(block);
  if (text.length === 0 && type !== "divider") return undefined;
  const indent = "  ".repeat(depth);
  if (type === "bulleted_list_item") return `${indent}- ${text}`;
  if (type === "numbered_list_item") return `${indent}1. ${text}`;
  if (type === "to_do") {
    const value = objectValue(block.to_do);
    return `${indent}- [${value?.checked === true ? "x" : " "}] ${text}`;
  }
  if (type === "quote") return `${indent}> ${text}`;
  return `${indent}${text}`;
}

async function blockChildren(
  transport: NotionHttpTransport,
  state: ProviderState,
  blockId: string,
): Promise<Result<NotionBlock[], Error>> {
  const blocks: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL(`${NOTION_API_URL}/blocks/${encodeURIComponent(blockId)}/children`);
    url.searchParams.set("page_size", "100");
    if (cursor !== undefined) url.searchParams.set("start_cursor", cursor);
    const response = await jsonResponse(transport, url.toString(), {
      headers: notionHeaders(state.accessToken),
    });
    if (!response.ok) return response;
    const page = response.value as NotionBlockChildrenResponse;
    if (!Array.isArray(page.results)) {
      return err(new Error("Notion block children response is invalid"));
    }
    for (const value of page.results) {
      if (typeof value === "object" && value !== null) blocks.push(value as NotionBlock);
    }
    if (page.has_more === true) {
      cursor = stringValue(page.next_cursor);
      if (cursor === undefined) return err(new Error("Notion block cursor is missing"));
    } else {
      cursor = undefined;
    }
  } while (cursor !== undefined);
  return ok(blocks);
}

async function renderBlocks(
  transport: NotionHttpTransport,
  state: ProviderState,
  parentId: string,
  depth = 0,
): Promise<Result<string[], Error>> {
  const children = await blockChildren(transport, state, parentId);
  if (!children.ok) return children;
  const lines: string[] = [];
  for (const block of children.value) {
    const line = renderedBlockLine(block, depth);
    if (line !== undefined) lines.push(line);
    if (block.has_children === true) {
      const id = stringValue(block.id);
      if (id === undefined) return err(new Error("Notion child block ID is missing"));
      const nested = await renderBlocks(transport, state, id, depth + 1);
      if (!nested.ok) return nested;
      lines.push(...nested.value);
    }
  }
  return ok(lines);
}

async function fetchPage(
  transport: NotionHttpTransport,
  source: RemoteSource,
  state: ProviderState,
): Promise<Result<{ id: string; revision: string; text: string }, Error>> {
  const pageResponse = await jsonResponse(
    transport,
    `${NOTION_API_URL}/pages/${encodeURIComponent(source.id)}`,
    { headers: notionHeaders(state.accessToken) },
  );
  if (!pageResponse.ok) return pageResponse;
  if (typeof pageResponse.value !== "object" || pageResponse.value === null) {
    return err(new Error("Notion page response is invalid"));
  }
  const page = pageResponse.value as NotionPage;
  if (page.object !== "page" || stringValue(page.id) !== source.id) {
    return err(new Error("Notion page response is invalid"));
  }
  const blocks = await renderBlocks(transport, state, source.id);
  if (!blocks.ok) return blocks;
  const title = pageTitle(page);
  const content = blocks.value.join("\n").replace(/\n+$/, "");
  const text = title.length > 0 && content.length > 0 ? `${title}\n\n${content}` : title || content;
  return ok({
    id: source.id,
    revision: stringValue(page.last_edited_time) ?? source.revision,
    text,
  });
}

function headerValue(headers: WebhookRequest["headers"], expectedName: string): string | undefined {
  const match = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === expectedName.toLowerCase(),
  )?.[1];
  if (typeof match === "string") return match;
  if (Array.isArray(match) && match.length === 1) return match[0];
  return undefined;
}

function verifySignature(input: WebhookRequest, secret: string): boolean {
  const signature = headerValue(input.headers, "x-notion-signature");
  if (signature === undefined) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(input.body).digest("hex")}`;
  const suppliedBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

function equalSecret(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function parseWebhookBody(input: WebhookRequest): Result<Record<string, unknown>, Error> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(input.body).toString("utf8"));
  } catch {
    return err(new Error("Notion webhook body is invalid"));
  }
  if (typeof parsed !== "object" || parsed === null) {
    return err(new Error("Notion webhook body is invalid"));
  }
  return ok(parsed as Record<string, unknown>);
}

function eventHint(event: NotionEvent): RefreshHint {
  const entity = objectValue(event.entity) as NotionEntity | undefined;
  const entityId = stringValue(entity?.id);
  if (entity?.type === "page" && entityId !== undefined) {
    return { kind: "sources", sourceIds: [entityId], rediscover: false };
  }
  return { kind: "reconcile" };
}

function webhookHint(input: WebhookRequest, state: ProviderState): Result<VerifiedWebhook, Error> {
  const webhook = state.webhook;
  if (webhook === undefined) {
    if (
      input.setupToken === undefined ||
      state.webhookSetupToken === undefined ||
      !equalSecret(input.setupToken, state.webhookSetupToken)
    ) {
      return err(new Error("Notion webhook setup token is invalid"));
    }
    const body = parseWebhookBody(input);
    if (!body.ok) return body;
    const verificationToken = stringValue(body.value.verification_token);
    if (verificationToken === undefined) return err(new Error("Notion webhook is not verified"));
    return ok({
      kind: "verification",
      channel: {
        id: "notion-manual",
        secret: verificationToken,
        verificationRequired: true,
      },
    });
  }
  if (webhook.verificationRequired === true) {
    return err(new Error("Notion webhook verification is not confirmed"));
  }
  if (!verifySignature(input, webhook.secret)) {
    return err(new Error("Notion webhook signature is invalid"));
  }
  const body = parseWebhookBody(input);
  if (!body.ok) return body;
  const event = body.value as NotionEvent;
  const eventId = stringValue(event.id);
  if (eventId === undefined || stringValue(event.type) === undefined) {
    return err(new Error("Notion webhook event is invalid"));
  }
  return ok({ kind: "event", eventId, hint: eventHint(event) });
}

export function createNotionAdapter(options: NotionAdapterOptions): ProviderAdapter {
  const transport = options.transport ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  return {
    name: "notion",
    webhookSetup: "manual",
    authorizationUrl: (input) => authorizationUrl(input, options.redirectUri),
    exchangeCode: (input) => exchangeCode(transport, options.redirectUri, now, input),
    refreshTokens: (input) => refreshTokens(transport, now, input),
    ensureWebhook: async (state) =>
      state.webhook === undefined
        ? err(new Error("Notion webhook subscription requires manual verification"))
        : ok(state.webhook),
    verifyWebhook: (input, state) => Promise.resolve(webhookHint(input, state)),
    discover: (state) => discoverPages(transport, state),
    fetch: (source, state) => fetchPage(transport, source, state),
  };
}
