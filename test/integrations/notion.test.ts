import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createNotionAdapter, type NotionHttpTransport } from "../../src/integrations/notion.js";
import type { ProviderState } from "../../src/integrations/types.js";

function state(webhook?: ProviderState["webhook"]): ProviderState {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    ...(webhook === undefined ? {} : { webhook }),
    sources: {},
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function transport(responses: Record<string, Response[]>): NotionHttpTransport {
  return async (url) => {
    const response = Object.entries(responses)
      .find(([prefix]) => url.startsWith(prefix))?.[1]
      .shift();
    if (response === undefined) throw new Error(`unexpected request: ${url}`);
    return response;
  };
}

describe("Notion adapter", () => {
  it("discovers every accessible page across paginated search results", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const adapter = createNotionAdapter({
      redirectUri: "https://vault.example/integrations/notion/callback",
      transport: async (url, init) => {
        requests.push({ url, init });
        return requests.length === 1
          ? json({
              object: "list",
              type: "page_or_database",
              has_more: true,
              next_cursor: "search-2",
              results: [
                {
                  object: "database",
                  id: "database-1",
                  last_edited_time: "2026-08-23T12:00:00.000Z",
                  in_trash: false,
                },
                {
                  object: "page",
                  id: "page-2",
                  last_edited_time: "2026-08-24T12:02:00.000Z",
                  in_trash: false,
                },
              ],
            })
          : json({
              object: "list",
              type: "page_or_database",
              has_more: false,
              next_cursor: null,
              results: [
                {
                  object: "page",
                  id: "page-1",
                  last_edited_time: "2026-08-24T12:01:00.000Z",
                  in_trash: false,
                },
                {
                  object: "page",
                  id: "trashed-page",
                  last_edited_time: "2026-08-24T12:03:00.000Z",
                  in_trash: true,
                },
              ],
            });
      },
    });

    const result = await adapter.discover(state());

    expect(result).toEqual({
      ok: true,
      value: [
        { id: "page-1", revision: "2026-08-24T12:01:00.000Z" },
        { id: "page-2", revision: "2026-08-24T12:02:00.000Z" },
      ],
    });
    expect(requests.map(({ init }) => JSON.parse(String(init.body)))).toEqual([
      { page_size: 100 },
      { page_size: 100, start_cursor: "search-2" },
    ]);
  });

  it("renders a page title and recursively paginated nested blocks into deterministic text", async () => {
    const adapter = createNotionAdapter({
      redirectUri: "https://vault.example/integrations/notion/callback",
      transport: transport({
        "https://api.notion.com/v1/pages/page-1": [
          json({
            object: "page",
            id: "page-1",
            last_edited_time: "2026-08-24T12:01:00.000Z",
            properties: {
              Name: {
                id: "title",
                type: "title",
                title: [{ type: "text", plain_text: "Project plan" }],
              },
            },
          }),
        ],
        "https://api.notion.com/v1/blocks/page-1/children": [
          json({
            object: "list",
            type: "block",
            has_more: true,
            next_cursor: "blocks-2",
            results: [
              {
                object: "block",
                id: "intro",
                type: "paragraph",
                has_children: false,
                paragraph: { rich_text: [{ type: "text", plain_text: "" }] },
              },
            ],
          }),
          json({
            object: "list",
            type: "block",
            has_more: false,
            next_cursor: null,
            results: [
              {
                object: "block",
                id: "ship",
                type: "bulleted_list_item",
                has_children: true,
                bulleted_list_item: {
                  rich_text: [{ type: "text", plain_text: "Ship connector" }],
                },
              },
            ],
          }),
        ],
        "https://api.notion.com/v1/blocks/ship/children": [
          json({
            object: "list",
            type: "block",
            has_more: false,
            next_cursor: null,
            results: [
              {
                object: "block",
                id: "tests",
                type: "bulleted_list_item",
                has_children: false,
                bulleted_list_item: {
                  rich_text: [{ type: "text", plain_text: "Add tests" }],
                },
              },
            ],
          }),
        ],
      }),
    });

    const result = await adapter.fetch(
      { id: "page-1", revision: "2026-08-24T12:01:00.000Z" },
      state(),
    );

    expect(result).toEqual({
      ok: true,
      value: {
        id: "page-1",
        revision: "2026-08-24T12:01:00.000Z",
        text: "Project plan\n\n- Ship connector\n  - Add tests",
      },
    });
  });

  it("uses public OAuth and exchanges a code with HTTP Basic authentication", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const adapter = createNotionAdapter({
      redirectUri: "https://vault.example/integrations/notion/callback",
      now: () => new Date("2026-08-24T12:00:00.000Z"),
      transport: async (url, init) => {
        requests.push({ url, init });
        return json({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
          bot_id: "bot-1",
          workspace_id: "workspace-1",
          workspace_name: "Workspace",
          workspace_icon: null,
          duplicated_template_id: null,
          owner: { type: "user", user: { object: "user", id: "user-1" } },
        });
      },
    });

    const authorization = new URL(
      adapter.authorizationUrl({
        provider: "notion",
        clientId: "notion-client-id",
        state: "state-token",
        codeChallenge: "unused-pkce-challenge",
        codeChallengeMethod: "S256",
      }),
    );
    const exchanged = await adapter.exchangeCode({
      code: "authorization-code",
      clientId: "notion-client-id",
      clientSecret: "notion-client-secret",
      callbackNonce: "unused-by-notion",
      pkceVerifier: "unused-by-notion",
    });

    expect(authorization.origin + authorization.pathname).toBe(
      "https://api.notion.com/v1/oauth/authorize",
    );
    expect(Object.fromEntries(authorization.searchParams)).toEqual({
      client_id: "notion-client-id",
      owner: "user",
      redirect_uri: "https://vault.example/integrations/notion/callback",
      response_type: "code",
      state: "state-token",
    });
    expect(exchanged).toEqual({
      ok: true,
      value: {
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        accessTokenExpiresAt: "2026-08-24T13:00:00.000Z",
      },
    });
    expect(requests).toEqual([
      {
        url: "https://api.notion.com/v1/oauth/token",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Basic ${Buffer.from("notion-client-id:notion-client-secret").toString(
              "base64",
            )}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code: "authorization-code",
            redirect_uri: "https://vault.example/integrations/notion/callback",
          }),
        },
      },
    ]);
  });

  it("rotates both Notion tokens through the refresh-token grant", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const adapter = createNotionAdapter({
      redirectUri: "https://vault.example/integrations/notion/callback",
      now: () => new Date("2026-08-24T12:00:00.000Z"),
      transport: async (url, init) => {
        requests.push({ url, init });
        return json({
          access_token: "rotated-access-token",
          refresh_token: "rotated-refresh-token",
          expires_in: 7200,
        });
      },
    });

    const refreshed = await adapter.refreshTokens?.({
      clientId: "notion-client-id",
      clientSecret: "notion-client-secret",
      refreshToken: "prior-refresh-token",
    });

    expect(refreshed).toEqual({
      ok: true,
      value: {
        accessToken: "rotated-access-token",
        refreshToken: "rotated-refresh-token",
        accessTokenExpiresAt: "2026-08-24T14:00:00.000Z",
      },
    });
    expect(requests[0]).toEqual({
      url: "https://api.notion.com/v1/oauth/token",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Basic ${Buffer.from("notion-client-id:notion-client-secret").toString(
            "base64",
          )}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: "prior-refresh-token",
        }),
      },
    });
  });

  it("keeps an existing manually configured webhook channel", async () => {
    const adapter = createNotionAdapter({
      redirectUri: "https://vault.example/integrations/notion/callback",
      transport: async () => {
        throw new Error("Notion has no webhook-subscription API");
      },
    });
    const webhook = { id: "subscription-1", secret: "verification-token" };

    const result = await adapter.ensureWebhook?.(state(webhook), {
      callbackUrl: "https://vault.example/integrations/notion/webhook",
      now: new Date("2026-08-24T12:00:00.000Z"),
      renewBefore: new Date("2026-08-25T12:00:00.000Z"),
    });

    expect(result).toEqual({ ok: true, value: webhook });
  });

  it("fails webhook setup safely until the manual Notion verification token is persisted", async () => {
    const adapter = createNotionAdapter({
      redirectUri: "https://vault.example/integrations/notion/callback",
      transport: async () => {
        throw new Error("Notion has no webhook-subscription API");
      },
    });

    const result = await adapter.ensureWebhook?.(state(), {
      callbackUrl: "https://vault.example/integrations/notion/webhook",
      now: new Date("2026-08-24T12:00:00.000Z"),
      renewBefore: new Date("2026-08-25T12:00:00.000Z"),
    });

    expect(result).toEqual({
      ok: false,
      error: new Error("Notion webhook subscription requires manual verification"),
    });
  });

  it("captures the initial unsigned Notion verification token as an encrypted channel", async () => {
    const adapter = createNotionAdapter({
      redirectUri: "https://vault.example/integrations/notion/callback",
      transport: async () => {
        throw new Error("unexpected HTTP request");
      },
    });
    const body = Buffer.from(JSON.stringify({ verification_token: "verification-token" }));

    const result = await adapter.verifyWebhook?.({ headers: {}, body }, state());

    expect(result).toEqual({
      ok: true,
      value: {
        kind: "verification",
        channel: {
          id: "notion-manual",
          secret: "verification-token",
          verificationRequired: true,
        },
      },
    });
  });

  it("verifies the exact raw webhook body and returns page or rediscovery hints", async () => {
    const adapter = createNotionAdapter({
      redirectUri: "https://vault.example/integrations/notion/callback",
      transport: async () => {
        throw new Error("unexpected HTTP request");
      },
    });
    const providerState = state({ id: "subscription-1", secret: "verification-token" });
    const pageBody = Buffer.from(
      JSON.stringify({
        id: "event-page-1",
        type: "page.content_updated",
        entity: { id: "page-1", type: "page" },
      }),
    );
    const databaseBody = Buffer.from(
      JSON.stringify({
        id: "event-database-1",
        type: "data_source.content_updated",
        entity: { id: "database-1", type: "data_source" },
      }),
    );
    const signature = (body: Buffer) =>
      `sha256=${createHmac("sha256", "verification-token").update(body).digest("hex")}`;

    const page = await adapter.verifyWebhook?.(
      { headers: { "x-notion-signature": signature(pageBody) }, body: pageBody },
      providerState,
    );
    const database = await adapter.verifyWebhook?.(
      { headers: { "X-Notion-Signature": signature(databaseBody) }, body: databaseBody },
      providerState,
    );

    expect(page).toEqual({
      ok: true,
      value: {
        kind: "event",
        eventId: "event-page-1",
        hint: { kind: "sources", sourceIds: ["page-1"], rediscover: false },
      },
    });
    expect(database).toEqual({
      ok: true,
      value: {
        kind: "event",
        eventId: "event-database-1",
        hint: { kind: "reconcile" },
      },
    });
  });

  it("rejects a webhook whose signature does not match its raw body", async () => {
    const adapter = createNotionAdapter({
      redirectUri: "https://vault.example/integrations/notion/callback",
      transport: async () => {
        throw new Error("unexpected HTTP request");
      },
    });

    const result = await adapter.verifyWebhook?.(
      {
        headers: { "x-notion-signature": `sha256=${"0".repeat(64)}` },
        body: Buffer.from('{"id":"event-1"}'),
      },
      state({ id: "subscription-1", secret: "verification-token" }),
    );

    expect(result).toEqual({ ok: false, error: new Error("Notion webhook signature is invalid") });
  });
});
