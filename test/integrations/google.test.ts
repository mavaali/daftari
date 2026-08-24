import { describe, expect, it } from "vitest";
import {
  createGoogleDocsAdapter,
  type GoogleHttpTransport,
} from "../../src/integrations/google.js";
import type { ProviderState } from "../../src/integrations/types.js";

const GOOGLE_DOCUMENT = "application/vnd.google-apps.document";

function state(cursor?: string, sources: ProviderState["sources"] = {}): ProviderState {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    ...(cursor === undefined ? {} : { cursor }),
    sources,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function transport(responses: Record<string, Response[]>): GoogleHttpTransport {
  return async (url) => {
    const response = Object.entries(responses)
      .find(([prefix]) => url.startsWith(prefix))?.[1]
      .shift();
    if (response === undefined) throw new Error(`unexpected request: ${url}`);
    return response;
  };
}

function requireCapability<T>(capability: T | undefined, name: string): T {
  if (capability === undefined) throw new Error(`Google adapter is missing ${name}`);
  return capability;
}

describe("Google Docs adapter", () => {
  it("discovers every accessible native Google Doc and advances its Drive change cursor", async () => {
    const providerState = state();
    const adapter = createGoogleDocsAdapter({
      redirectUri: "https://vault.example/integrations/google/callback",
      now: () => new Date("2026-08-24T12:00:00.000Z"),
      transport: transport({
        "https://www.googleapis.com/drive/v3/changes/startPageToken": [
          json({ startPageToken: "changes-3" }),
        ],
        "https://www.googleapis.com/drive/v3/files": [
          json({
            nextPageToken: "files-2",
            files: [
              { id: "sheet-1", mimeType: "application/vnd.google-apps.spreadsheet", version: "2" },
              { id: "doc-2", mimeType: GOOGLE_DOCUMENT, version: "8" },
            ],
          }),
          json({
            files: [
              { id: "folder-1", mimeType: "application/vnd.google-apps.folder", version: "5" },
              { id: "doc-1", mimeType: GOOGLE_DOCUMENT, version: "3" },
            ],
          }),
        ],
      }),
    });

    const result = await adapter.discover(providerState);

    expect(result).toEqual({
      ok: true,
      value: [
        { id: "doc-1", revision: "3" },
        { id: "doc-2", revision: "8" },
      ],
    });
    expect(providerState.cursor).toBe("changes-3");
    expect(providerState.sources).toEqual({
      "doc-1": {
        id: "doc-1",
        revision: "3",
        contentHash: "",
        available: true,
        lastSeenAt: "2026-08-24T12:00:00.000Z",
      },
      "doc-2": {
        id: "doc-2",
        revision: "8",
        contentHash: "",
        available: true,
        lastSeenAt: "2026-08-24T12:00:00.000Z",
      },
    });
  });

  it("refuses an incomplete Drive listing rather than reporting partial discovery", async () => {
    const providerState = state();
    const adapter = createGoogleDocsAdapter({
      redirectUri: "https://vault.example/integrations/google/callback",
      transport: transport({
        "https://www.googleapis.com/drive/v3/changes/startPageToken": [
          json({ startPageToken: "changes-3" }),
        ],
        "https://www.googleapis.com/drive/v3/files": [
          json({
            incompleteSearch: true,
            files: [{ id: "doc-1", mimeType: GOOGLE_DOCUMENT, version: "3" }],
          }),
        ],
      }),
    });

    const result = await adapter.discover(providerState);

    expect(result.ok).toBe(false);
    expect(providerState).toEqual(state());
  });

  it("requests incompleteSearch in the Drive listing field mask", async () => {
    const requestedUrls: string[] = [];
    const adapter = createGoogleDocsAdapter({
      redirectUri: "https://vault.example/integrations/google/callback",
      transport: async (url) => {
        requestedUrls.push(url);
        if (url.startsWith("https://www.googleapis.com/drive/v3/changes/startPageToken")) {
          return json({ startPageToken: "changes-3" });
        }
        if (url.startsWith("https://www.googleapis.com/drive/v3/files")) {
          return json({ files: [] });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    const result = await adapter.discover(state());

    expect(result).toEqual({ ok: true, value: [] });
    const filesUrl = requestedUrls.find((url) =>
      url.startsWith("https://www.googleapis.com/drive/v3/files"),
    );
    expect(new URL(filesUrl).searchParams.get("fields")).toContain("incompleteSearch");
  });

  it("uses Drive changes incrementally after the initial full discovery", async () => {
    const providerState = state("changes-1", {
      "doc-1": {
        id: "doc-1",
        revision: "1",
        contentHash: "hash-1",
        available: true,
        lastSeenAt: "2026-08-23T12:00:00.000Z",
      },
      "doc-removed": {
        id: "doc-removed",
        revision: "1",
        contentHash: "hash-removed",
        available: true,
        lastSeenAt: "2026-08-23T12:00:00.000Z",
      },
    });
    const adapter = createGoogleDocsAdapter({
      redirectUri: "https://vault.example/integrations/google/callback",
      transport: transport({
        "https://www.googleapis.com/drive/v3/changes": [
          json({
            newStartPageToken: "changes-2",
            changes: [
              {
                fileId: "doc-1",
                removed: false,
                file: { id: "doc-1", mimeType: GOOGLE_DOCUMENT, version: "2" },
              },
              {
                fileId: "doc-2",
                removed: false,
                file: { id: "doc-2", mimeType: GOOGLE_DOCUMENT, version: "1" },
              },
              { fileId: "doc-removed", removed: true },
              {
                fileId: "sheet-1",
                removed: false,
                file: {
                  id: "sheet-1",
                  mimeType: "application/vnd.google-apps.spreadsheet",
                  version: "2",
                },
              },
            ],
          }),
        ],
      }),
    });

    const result = await adapter.discover(providerState);

    expect(result).toEqual({
      ok: true,
      value: [
        { id: "doc-1", revision: "2" },
        { id: "doc-2", revision: "1" },
      ],
    });
    expect(providerState.cursor).toBe("changes-2");
  });

  it("normalizes Google document paragraphs into stable plain text", async () => {
    const adapter = createGoogleDocsAdapter({
      redirectUri: "https://vault.example/integrations/google/callback",
      transport: transport({
        "https://docs.googleapis.com/v1/documents/doc-1": [
          json({
            body: {
              content: [
                { paragraph: { elements: [{ textRun: { content: "Title\n" } }] } },
                { paragraph: { elements: [{ textRun: { content: "\n" } }] } },
                {
                  paragraph: {
                    elements: [{ textRun: { content: "First paragraph\n" } }],
                  },
                },
                {
                  paragraph: {
                    elements: [{ textRun: { content: "Second paragraph\n" } }],
                  },
                },
              ],
            },
          }),
        ],
      }),
    });

    const result = await adapter.fetch({ id: "doc-1", revision: "3" }, state());

    expect(result).toEqual({
      ok: true,
      value: {
        id: "doc-1",
        revision: "3",
        text: "Title\n\nFirst paragraph\nSecond paragraph",
      },
    });
  });

  it("normalizes every Google Docs tab in document order", async () => {
    const adapter = createGoogleDocsAdapter({
      redirectUri: "https://vault.example/integrations/google/callback",
      transport: transport({
        "https://docs.googleapis.com/v1/documents/doc-1": [
          json({
            tabs: [
              {
                documentTab: {
                  body: {
                    content: [
                      { paragraph: { elements: [{ textRun: { content: "Overview\n" } }] } },
                    ],
                  },
                },
                childTabs: [
                  {
                    documentTab: {
                      body: {
                        content: [
                          { paragraph: { elements: [{ textRun: { content: "Detail\n" } }] } },
                        ],
                      },
                    },
                  },
                ],
              },
            ],
          }),
        ],
      }),
    });

    const result = await adapter.fetch({ id: "doc-1", revision: "3" }, state());

    expect(result).toEqual({
      ok: true,
      value: { id: "doc-1", revision: "3", text: "Overview\nDetail" },
    });
  });

  it("uses web-server OAuth with PKCE and exchanges a code through Google's token endpoint", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const adapter = createGoogleDocsAdapter({
      redirectUri: "https://vault.example/integrations/google/callback",
      now: () => new Date("2026-08-24T12:00:00.000Z"),
      transport: async (url, init) => {
        requests.push({ url, init });
        return json({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        });
      },
    });

    const authorization = new URL(
      adapter.authorizationUrl({
        provider: "google",
        clientId: "google-client-id",
        state: "state-token",
        codeChallenge: "pkce-challenge",
        codeChallengeMethod: "S256",
      }),
    );
    const exchanged = await adapter.exchangeCode({
      code: "authorization-code",
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
      callbackNonce: "unused-by-google",
      pkceVerifier: "pkce-verifier",
    });

    expect(authorization.origin + authorization.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(authorization.searchParams)).toMatchObject({
      access_type: "offline",
      client_id: "google-client-id",
      code_challenge: "pkce-challenge",
      code_challenge_method: "S256",
      include_granted_scopes: "true",
      prompt: "consent",
      redirect_uri: "https://vault.example/integrations/google/callback",
      response_type: "code",
      scope:
        "https://www.googleapis.com/auth/documents.readonly https://www.googleapis.com/auth/drive.metadata.readonly",
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
        url: "https://oauth2.googleapis.com/token",
        init: {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: "google-client-id",
            client_secret: "google-client-secret",
            code: "authorization-code",
            code_verifier: "pkce-verifier",
            grant_type: "authorization_code",
            redirect_uri: "https://vault.example/integrations/google/callback",
          }).toString(),
        },
      },
    ]);
  });

  it("refreshes access tokens without replacing Google's omitted refresh token", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const adapter = createGoogleDocsAdapter({
      redirectUri: "https://vault.example/integrations/google/callback",
      now: () => new Date("2026-08-24T12:00:00.000Z"),
      transport: async (url, init) => {
        requests.push({ url, init });
        return json({ access_token: "rotated-access", expires_in: 1800 });
      },
    });

    const refreshed = await requireCapability(
      adapter.refreshTokens,
      "refreshTokens",
    )({
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
      refreshToken: "durable-refresh-token",
    });

    expect(refreshed).toEqual({
      ok: true,
      value: {
        accessToken: "rotated-access",
        refreshToken: "durable-refresh-token",
        accessTokenExpiresAt: "2026-08-24T12:30:00.000Z",
      },
    });
    expect(requests).toEqual([
      {
        url: "https://oauth2.googleapis.com/token",
        init: {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: "google-client-id",
            client_secret: "google-client-secret",
            grant_type: "refresh_token",
            refresh_token: "durable-refresh-token",
          }).toString(),
        },
      },
    ]);
  });

  it("rejects a failed Google token refresh without accepting a partial response", async () => {
    const adapter = createGoogleDocsAdapter({
      redirectUri: "https://vault.example/integrations/google/callback",
      transport: transport({
        "https://oauth2.googleapis.com/token": [json({ error: "invalid_grant" }, 400)],
      }),
    });

    const refreshed = await requireCapability(
      adapter.refreshTokens,
      "refreshTokens",
    )({
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
      refreshToken: "durable-refresh-token",
    });

    expect(refreshed.ok).toBe(false);
  });

  it("creates a renewed Drive change channel from the stored cursor", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const providerState = state("changes-7");
    providerState.webhook = {
      id: "expired-channel",
      secret: "expired-secret",
      expiresAt: "2026-08-24T11:59:00.000Z",
    };
    const adapter = createGoogleDocsAdapter({
      redirectUri: "https://vault.example/integrations/google/callback",
      transport: async (url, init) => {
        requests.push({ url, init });
        const request = JSON.parse(String(init.body)) as { id: string };
        return json({ id: request.id, expiration: "1787576400000" });
      },
    });

    const ensured = await requireCapability(adapter.ensureWebhook, "ensureWebhook")(providerState, {
      callbackUrl: "https://vault.example/integrations/google/webhook",
      now: new Date("2026-08-24T12:00:00.000Z"),
      renewBefore: new Date("2026-08-24T12:05:00.000Z"),
    });

    expect(ensured).toMatchObject({
      ok: true,
      value: {
        id: expect.any(String),
        secret: expect.any(String),
        expiresAt: "2026-08-24T13:00:00.000Z",
      },
    });
    if (!ensured.ok) return;
    expect(ensured.value.id).not.toBe("expired-channel");
    expect(ensured.value.secret).not.toBe("expired-secret");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("https://www.googleapis.com/drive/v3/changes/watch?");
    const query = new URL(requests[0]?.url).searchParams;
    expect(query.get("pageToken")).toBe("changes-7");
    expect(query.get("includeItemsFromAllDrives")).toBe("true");
    expect(query.get("supportsAllDrives")).toBe("true");
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
      id: ensured.value.id,
      token: ensured.value.secret,
      type: "web_hook",
      address: "https://vault.example/integrations/google/webhook",
    });
  });

  it("retains an unexpired Drive channel and refuses an insecure callback URL", async () => {
    const providerState = state("changes-7");
    providerState.webhook = {
      id: "current-channel",
      secret: "current-secret",
      expiresAt: "2026-08-24T13:00:00.000Z",
    };
    const adapter = createGoogleDocsAdapter({
      redirectUri: "https://vault.example/integrations/google/callback",
      transport: async () => {
        throw new Error("a current channel must not create a new watch request");
      },
    });

    const retained = await requireCapability(adapter.ensureWebhook, "ensureWebhook")(
      providerState,
      {
        callbackUrl: "https://vault.example/integrations/google/webhook",
        now: new Date("2026-08-24T12:00:00.000Z"),
        renewBefore: new Date("2026-08-24T12:05:00.000Z"),
      },
    );
    const insecure = await requireCapability(adapter.ensureWebhook, "ensureWebhook")(
      state("changes-7"),
      {
        callbackUrl: "http://localhost/integrations/google/webhook",
        now: new Date("2026-08-24T12:00:00.000Z"),
        renewBefore: new Date("2026-08-24T12:05:00.000Z"),
      },
    );

    expect(retained).toEqual({
      ok: true,
      value: {
        id: "current-channel",
        secret: "current-secret",
        expiresAt: "2026-08-24T13:00:00.000Z",
      },
    });
    expect(insecure.ok).toBe(false);
  });

  it("accepts only the active Google change-channel credentials", async () => {
    const providerState = state("changes-7");
    providerState.webhook = { id: "channel-1", secret: "channel-token" };
    const adapter = createGoogleDocsAdapter({
      redirectUri: "https://vault.example/integrations/google/callback",
    });

    const valid = await requireCapability(adapter.verifyWebhook, "verifyWebhook")(
      {
        headers: {
          "X-Goog-Channel-ID": "channel-1",
          "X-Goog-Channel-Token": "channel-token",
          "X-Goog-Resource-State": "change",
          "X-Goog-Message-Number": "42",
        },
        body: new Uint8Array([1, 2, 3]),
      },
      providerState,
    );
    const wrongToken = await requireCapability(adapter.verifyWebhook, "verifyWebhook")(
      {
        headers: {
          "x-goog-channel-id": "channel-1",
          "x-goog-channel-token": "attacker-token",
          "x-goog-resource-state": "change",
          "x-goog-message-number": "42",
        },
        body: new Uint8Array(),
      },
      providerState,
    );
    const wrongState = await requireCapability(adapter.verifyWebhook, "verifyWebhook")(
      {
        headers: {
          "x-goog-channel-id": "channel-1",
          "x-goog-channel-token": "channel-token",
          "x-goog-resource-state": "update",
          "x-goog-message-number": "42",
        },
        body: new Uint8Array(),
      },
      providerState,
    );

    const missingMessageNumber = await requireCapability(adapter.verifyWebhook, "verifyWebhook")(
      {
        headers: {
          "x-goog-channel-id": "channel-1",
          "x-goog-channel-token": "channel-token",
          "x-goog-resource-state": "change",
        },
        body: new Uint8Array(),
      },
      providerState,
    );

    expect(valid).toEqual({
      ok: true,
      value: { kind: "event", eventId: "channel-1:42", hint: { kind: "reconcile" } },
    });
    expect(wrongToken.ok).toBe(false);
    expect(wrongState.ok).toBe(false);
    expect(missingMessageNumber.ok).toBe(false);
  });
});
