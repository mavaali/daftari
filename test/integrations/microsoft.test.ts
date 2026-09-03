import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateContinuousAdapterCapabilities } from "../../src/integrations/engine.js";
import {
  createMicrosoftAdapter,
  MICROSOFT_ESTIMATE_RATIOS,
} from "../../src/integrations/microsoft.js";
import { createConfiguredIntegrationRuntime } from "../../src/integrations/runtime.js";
import { writeIntegrationState } from "../../src/integrations/state.js";
import type {
  EnrollmentRecord,
  IntegrationConfig,
  ProviderState,
  SourceState,
} from "../../src/integrations/types.js";
import type { RoleConfig } from "../../src/utils/config.js";
import { buildDeck, buildDocxZip, buildPdf, textOp, wrapDocument } from "../extract/fixtures.js";
import {
  createFixtureTransport,
  meFixture,
  microsoftProviderConfig,
  microsoftProviderState,
} from "./microsoft-fixtures.js";

const KEY = Buffer.alloc(32, 7);

function enrollment(
  overrides: Partial<EnrollmentRecord> &
    Pick<EnrollmentRecord, "id" | "kind" | "driveId" | "remoteId" | "cursorKey">,
): EnrollmentRecord {
  return {
    label: overrides.id,
    collection: "distill",
    includeSpeakerNotes: true,
    enrolledBy: "user-1",
    enrolledAt: "2026-08-24T00:00:00.000Z",
    audienceAckAt: "2026-08-24T00:00:00.000Z",
    readersAtEnrollment: [],
    ...overrides,
  };
}

describe("Microsoft adapter skeleton (U12)", () => {
  it("satisfies the continuous-adapter capability gate (refreshTokens + webhook methods present)", () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
    });

    expect(adapter.name).toBe("microsoft");
    expect(adapter.webhookSetup).toBe("automatic");
    const withoutWebhooks = validateContinuousAdapterCapabilities(adapter, {
      webhooksRequired: false,
    });
    expect(withoutWebhooks).toEqual({ ok: true, value: undefined });
    const withWebhooks = validateContinuousAdapterCapabilities(adapter, {
      webhooksRequired: true,
    });
    expect(withWebhooks).toEqual({ ok: true, value: undefined });
  });

  it("builds a well-formed authorization URL scoped to the configured tenant", () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig({ tenantId: "contoso-tenant" }),
    });

    const url = adapter.authorizationUrl({
      provider: "microsoft",
      clientId: "client-1",
      state: "state-1",
      codeChallenge: "challenge-1",
      codeChallengeMethod: "S256",
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://login.microsoftonline.com");
    expect(parsed.pathname).toBe("/contoso-tenant/oauth2/v2.0/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("client-1");
    expect(parsed.searchParams.get("state")).toBe("state-1");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://vault.example/integrations/microsoft/callback",
    );
    expect(parsed.searchParams.get("response_type")).toBe("code");
  });

  it("discover with no enrollments returns an empty set without any HTTP call; webhook methods are wired (see the dedicated U16 describe block below)", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
    });

    await expect(
      adapter.discover({ accessToken: "a", refreshToken: "r", sources: {} }),
    ).resolves.toEqual({ ok: true, value: [] });
    // fetch is implemented as of U15 (see the dedicated "Microsoft adapter
    // fetch (U15)" describe block below) — a malformed source id (no
    // "driveId:itemId" separator) is rejected before any HTTP call, so this
    // is safe to exercise here even without an injected transport.
    await expect(
      adapter.fetch(
        { id: "x", revision: "1" },
        { accessToken: "a", refreshToken: "r", sources: {} },
      ),
    ).resolves.toMatchObject({ ok: false });
    // ensureWebhook is implemented as of U16 (see the dedicated "Microsoft
    // adapter webhooks (U16)" describe block below) — a non-HTTPS callback
    // is rejected into an empty polling-fallback channel (R19) without any
    // HTTP call, so this is safe to exercise here even without an injected
    // transport.
    await expect(
      adapter.ensureWebhook?.(
        { accessToken: "a", refreshToken: "r", sources: {} },
        { callbackUrl: "http://localhost/hook", now: new Date(), renewBefore: new Date() },
      ),
    ).resolves.toMatchObject({ ok: true, value: { subscriptions: [] } });
    // verifyWebhook is implemented as of U16 — an unconfigured webhook (no
    // state.webhook) is rejected before any body parsing.
    await expect(
      adapter.verifyWebhook?.(
        { headers: {}, body: new Uint8Array() },
        { accessToken: "a", refreshToken: "r", sources: {} },
      ),
    ).resolves.toMatchObject({ ok: false });
  });

  it("delivers a fixtured /me response through the injected-transport harness (R40 seam)", async () => {
    const transport = createFixtureTransport({
      "https://graph.microsoft.com/v1.0/me": [meFixture({ displayName: "Ada Lovelace" })],
    });

    // Constructing the adapter with an injected transport must not throw —
    // proves the option is wired even though this unit's placeholders don't
    // call it yet.
    expect(() =>
      createMicrosoftAdapter({
        redirectUri: "https://vault.example/integrations/microsoft/callback",
        config: microsoftProviderConfig(),
        transport,
      }),
    ).not.toThrow();

    const response = await transport("https://graph.microsoft.com/v1.0/me", {});
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ displayName: "Ada Lovelace" });
  });
});

function base64UrlJson(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function fakeIdToken(payload: Record<string, unknown>): string {
  return `${base64UrlJson({ alg: "none" })}.${base64UrlJson(payload)}.signature`;
}

describe("Microsoft adapter OAuth (U13)", () => {
  it("scopes a sharepoint authorization URL to Files.Read.All + the shared base scopes, never the picker scopes", () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig({ tenantId: "contoso-tenant", scopeProfile: "sharepoint" }),
    });

    const url = new URL(
      adapter.authorizationUrl({
        provider: "microsoft",
        clientId: "client-1",
        state: "state-1",
        codeChallenge: "challenge-1",
        codeChallengeMethod: "S256",
      }),
    );

    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.pathname).toBe("/contoso-tenant/oauth2/v2.0/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("response_mode")).toBe("query");
    const scope = url.searchParams.get("scope") ?? "";
    const scopeTokens = scope.split(" ");
    expect(scopeTokens).toEqual(
      expect.arrayContaining(["Files.Read.All", "offline_access", "User.Read", "openid"]),
    );
    expect(scopeTokens).not.toContain("AllSites.Read");
    expect(scopeTokens).not.toContain("MyFiles.Read");
  });

  it("scopes a onedrive authorization URL to Files.Read", () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig({ scopeProfile: "onedrive" }),
    });

    const url = new URL(
      adapter.authorizationUrl({
        provider: "microsoft",
        clientId: "client-1",
        state: "state-1",
        codeChallenge: "challenge-1",
        codeChallengeMethod: "S256",
      }),
    );

    expect((url.searchParams.get("scope") ?? "").split(" ")).toEqual(
      expect.arrayContaining(["Files.Read", "offline_access", "User.Read", "openid"]),
    );
  });

  it("exchanges a code through Microsoft's token endpoint, decodes the id_token tid, and fetches /me", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const idToken = fakeIdToken({ tid: "contoso-tenant-guid" });
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      now: () => new Date("2026-08-24T12:00:00.000Z"),
      config: microsoftProviderConfig({ tenantId: "contoso-tenant", scopeProfile: "sharepoint" }),
      transport: async (url, init) => {
        requests.push({ url, init });
        if (url.startsWith("https://login.microsoftonline.com/contoso-tenant/oauth2/v2.0/token")) {
          return new Response(
            JSON.stringify({
              access_token: "new-access-token",
              refresh_token: "new-refresh-token",
              expires_in: 3600,
              id_token: idToken,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.startsWith("https://graph.microsoft.com/v1.0/me")) {
          return meFixture({
            id: "user-1",
            displayName: "Ada Lovelace",
            userPrincipalName: "ada@contoso.com",
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    const exchanged = await adapter.exchangeCode({
      code: "authorization-code",
      clientId: "microsoft-client-id",
      clientSecret: "microsoft-client-secret",
      callbackNonce: "unused-by-microsoft",
      pkceVerifier: "pkce-verifier",
    });

    expect(exchanged).toEqual({
      ok: true,
      value: {
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        accessTokenExpiresAt: "2026-08-24T13:00:00.000Z",
        account: {
          id: "user-1",
          tenantId: "contoso-tenant-guid",
          displayName: "Ada Lovelace",
          upn: "ada@contoso.com",
        },
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe(
      "https://login.microsoftonline.com/contoso-tenant/oauth2/v2.0/token",
    );
    expect(requests[0].init.method).toBe("POST");
    expect(requests[0].init.headers).toEqual({
      "content-type": "application/x-www-form-urlencoded",
    });
    const body = new URLSearchParams(requests[0].init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("authorization-code");
    expect(body.get("code_verifier")).toBe("pkce-verifier");
    expect(body.get("client_secret")).toBe("microsoft-client-secret");
    expect(body.get("redirect_uri")).toBe("https://vault.example/integrations/microsoft/callback");
  });

  it("falls back to the /organization endpoint for tenant id when the id_token/tid is absent", async () => {
    const requests: string[] = [];
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      now: () => new Date("2026-08-24T12:00:00.000Z"),
      config: microsoftProviderConfig({ tenantId: "contoso-tenant" }),
      transport: async (url) => {
        requests.push(url);
        if (url.startsWith("https://login.microsoftonline.com/")) {
          return new Response(
            JSON.stringify({
              access_token: "new-access-token",
              refresh_token: "new-refresh-token",
              expires_in: 3600,
              // No id_token in this response.
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.startsWith("https://graph.microsoft.com/v1.0/organization")) {
          return new Response(JSON.stringify({ value: [{ id: "org-tenant-guid" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.startsWith("https://graph.microsoft.com/v1.0/me")) {
          return meFixture({ id: "user-1" });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    const exchanged = await adapter.exchangeCode({
      code: "authorization-code",
      clientId: "microsoft-client-id",
      clientSecret: "microsoft-client-secret",
      callbackNonce: "unused-by-microsoft",
      pkceVerifier: "pkce-verifier",
    });

    expect(exchanged.ok).toBe(true);
    if (exchanged.ok) {
      expect(exchanged.value.account?.tenantId).toBe("org-tenant-guid");
    }
    expect(requests).toContain("https://graph.microsoft.com/v1.0/organization");
  });

  it("falls back to the /organization endpoint (without throwing) when the id_token is malformed", async () => {
    const requests: string[] = [];
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      now: () => new Date("2026-08-24T12:00:00.000Z"),
      config: microsoftProviderConfig({ tenantId: "contoso-tenant" }),
      transport: async (url) => {
        requests.push(url);
        if (url.startsWith("https://login.microsoftonline.com/")) {
          return new Response(
            JSON.stringify({
              access_token: "new-access-token",
              refresh_token: "new-refresh-token",
              expires_in: 3600,
              // Not a valid JWT: no base64url-JSON middle segment.
              id_token: "not-a-jwt",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.startsWith("https://graph.microsoft.com/v1.0/organization")) {
          return new Response(JSON.stringify({ value: [{ id: "org-tenant-guid" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.startsWith("https://graph.microsoft.com/v1.0/me")) {
          return meFixture({ id: "user-1" });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    const exchanged = await adapter.exchangeCode({
      code: "authorization-code",
      clientId: "microsoft-client-id",
      clientSecret: "microsoft-client-secret",
      callbackNonce: "unused-by-microsoft",
      pkceVerifier: "pkce-verifier",
    });

    expect(exchanged.ok).toBe(true);
    if (exchanged.ok) {
      expect(exchanged.value.account?.tenantId).toBe("org-tenant-guid");
    }
    expect(requests).toContain("https://graph.microsoft.com/v1.0/organization");
  });

  it("refreshes access tokens and persists Microsoft's rotated refresh token", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      now: () => new Date("2026-08-24T12:00:00.000Z"),
      config: microsoftProviderConfig(),
      transport: async (url, init) => {
        requests.push({ url, init });
        return new Response(
          JSON.stringify({
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
            expires_in: 1800,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const refreshed = await adapter.refreshTokens?.({
      clientId: "microsoft-client-id",
      clientSecret: "microsoft-client-secret",
      refreshToken: "old-refresh-token",
    });

    expect(refreshed).toEqual({
      ok: true,
      value: {
        accessToken: "rotated-access",
        refreshToken: "rotated-refresh",
        accessTokenExpiresAt: "2026-08-24T12:30:00.000Z",
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].init.method).toBe("POST");
    const body = new URLSearchParams(requests[0].init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh-token");
    expect(body.get("client_secret")).toBe("microsoft-client-secret");
  });

  it("falls back to the prior refresh token when Microsoft's response omits a new one", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      now: () => new Date("2026-08-24T12:00:00.000Z"),
      config: microsoftProviderConfig(),
      transport: async () =>
        new Response(JSON.stringify({ access_token: "rotated-access", expires_in: 1800 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    const refreshed = await adapter.refreshTokens?.({
      clientId: "microsoft-client-id",
      clientSecret: "microsoft-client-secret",
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
  });

  it("carries a terminal signal on a 400 invalid_grant refresh failure so the engine's classifier flags reconnect_required", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });

    const refreshed = await adapter.refreshTokens?.({
      clientId: "microsoft-client-id",
      clientSecret: "microsoft-client-secret",
      refreshToken: "revoked-refresh-token",
    });

    expect(refreshed?.ok).toBe(false);
    if (refreshed?.ok !== false) throw new Error("expected refresh failure");
    const error = refreshed.error as Error & { status?: number; terminal?: boolean };
    expect(error.status === 400 || error.terminal === true).toBe(true);
  });

  it("does not carry a terminal signal on a transient 503 refresh failure", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async () =>
        new Response(JSON.stringify({ error: "server_error" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    });

    const refreshed = await adapter.refreshTokens?.({
      clientId: "microsoft-client-id",
      clientSecret: "microsoft-client-secret",
      refreshToken: "durable-refresh-token",
    });

    expect(refreshed?.ok).toBe(false);
    if (refreshed?.ok !== false) throw new Error("expected refresh failure");
    const error = refreshed.error as Error & { status?: number; terminal?: boolean };
    expect(error.terminal).not.toBe(true);
    expect(error.status === 400 || error.status === 401 || error.status === 403).toBe(false);
  });

  it("bounds Graph request time (design §11) with a clean, non-terminal error", async () => {
    let aborted = false;
    const timed = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      requestTimeoutMilliseconds: 5,
      transport: async (_url, init) =>
        new Promise<Response>((_resolve) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    });

    const refreshed = await timed.refreshTokens?.({
      clientId: "microsoft-client-id",
      clientSecret: "microsoft-client-secret",
      refreshToken: "durable-refresh-token",
    });

    expect(refreshed?.ok).toBe(false);
    expect(aborted).toBe(true);
    if (refreshed?.ok !== false) throw new Error("expected refresh failure");
    const error = refreshed.error as Error & { status?: number; terminal?: boolean };
    expect(error.status).toBeUndefined();
    expect(error.terminal).not.toBe(true);
  });

  it("bounds Graph response bytes (design §11) with a clean, non-terminal error", async () => {
    const bounded = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      maxResponseBytes: 8,
      transport: async () =>
        new Response(JSON.stringify({ access_token: "way-too-large-a-payload-for-the-cap" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    const refreshed = await bounded.refreshTokens?.({
      clientId: "microsoft-client-id",
      clientSecret: "microsoft-client-secret",
      refreshToken: "durable-refresh-token",
    });

    expect(refreshed?.ok).toBe(false);
    if (refreshed?.ok !== false) throw new Error("expected refresh failure");
    const error = refreshed.error as Error & { status?: number; terminal?: boolean };
    expect(error.message).toMatch(/too large/);
    expect(error.status).toBeUndefined();
    expect(error.terminal).not.toBe(true);
  });
});

describe("runtime wiring accepts the microsoft adapter at start()", () => {
  const config: IntegrationConfig = {
    encryptionKeyEnv: "INTEGRATION_KEY",
    pollingIntervalMinutes: 10,
    microsoft: microsoftProviderConfig(),
  };
  const environment = {
    INTEGRATION_KEY: KEY.toString("base64"),
    MICROSOFT_CLIENT_ID: "client-id",
    MICROSOFT_CLIENT_SECRET: "client-secret",
  };
  const distill = async () => ({ ok: true as const, value: { runId: "test-run" } });

  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-integration-microsoft-"));
    writeIntegrationState(
      vault,
      {
        providers: { microsoft: { accessToken: "access", refreshToken: "refresh", sources: {} } },
        oauthStates: {},
      },
      KEY,
    );
  });

  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  it("constructs the default microsoft factory and passes capability validation", async () => {
    const created = createConfiguredIntegrationRuntime({
      vaultRoot: vault,
      config,
      environment,
      distill,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const started = await created.value.start("http://127.0.0.1:8788");
    expect(started).toEqual({ ok: true, value: undefined });
    await created.value.close();
  });
});

function graphJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Microsoft adapter discover (U14)", () => {
  it("has no enrollments -> ok([]) without an HTTP call", async () => {
    let calls = 0;
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async () => {
        calls += 1;
        throw new Error("unexpected request");
      },
    });
    const state = microsoftProviderState();
    await expect(adapter.discover(state)).resolves.toEqual({ ok: true, value: [] });
    expect(calls).toBe(0);
  });

  it("walks a container root's folder-scoped delta and an item-group root's drive-root delta, merges both into the full present set, and threads both terminal deltaLinks into the new cursor", async () => {
    const requests: string[] = [];
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        requests.push(url);
        if (
          url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-a/items/folder-a/delta")
        ) {
          return graphJson({
            value: [{ id: "f1", eTag: "e1", file: {}, parentReference: { id: "folder-a" } }],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/drives/drive-a/delta-page-2",
          });
        }
        if (url === "https://graph.microsoft.com/v1.0/drives/drive-a/delta-page-2") {
          return graphJson({
            value: [{ id: "f2", eTag: "e2", file: {}, parentReference: { id: "folder-a" } }],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-a/delta-link-c",
          });
        }
        if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-b/root/delta")) {
          expect(url).toContain("token=latest");
          return graphJson({
            value: [
              { id: "item-1", eTag: "e3", file: {}, parentReference: { id: "root-b" } },
              { id: "item-999", eTag: "unrelated", file: {}, parentReference: { id: "root-b" } },
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-b/delta-link-i",
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    const state = microsoftProviderState(
      {
        enrollments: {
          c1: enrollment({
            id: "c1",
            kind: "container",
            driveId: "drive-a",
            remoteId: "folder-a",
            cursorKey: "enrollment:c1",
          }),
          i1: enrollment({
            id: "i1",
            kind: "item",
            driveId: "drive-b",
            remoteId: "item-1",
            cursorKey: "drive:drive-b",
          }),
        },
      },
      {},
    );

    const discovered = await adapter.discover(state);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    expect([...discovered.value].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "drive-a:f1", revision: "e1" },
      { id: "drive-a:f2", revision: "e2" },
      { id: "drive-b:item-1", revision: "e3" },
    ]);

    expect(JSON.parse(state.cursor as string)).toEqual({
      v: 1,
      roots: {
        "enrollment:c1": "https://graph.microsoft.com/v1.0/drives/drive-a/delta-link-c",
        "drive:drive-b": "https://graph.microsoft.com/v1.0/drives/drive-b/delta-link-i",
      },
    });

    // Container uses the folder-scoped delta; item-group uses root/delta?token=latest.
    expect(
      requests.some((url) =>
        url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-a/items/folder-a/delta"),
      ),
    ).toBe(true);
    expect(
      requests.some((url) =>
        url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-b/root/delta"),
      ),
    ).toBe(true);
  });

  it("a deleted-facet item drops out of the returned present set", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        if (url === "https://graph.microsoft.com/v1.0/drives/drive-b/stored-delta-link") {
          return graphJson({
            value: [{ id: "item-1", deleted: {} }],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-b/delta-link-2",
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    const state = microsoftProviderState(
      {
        cursor: JSON.stringify({
          v: 1,
          roots: {
            "drive:drive-b": "https://graph.microsoft.com/v1.0/drives/drive-b/stored-delta-link",
          },
        }),
        enrollments: {
          i1: enrollment({
            id: "i1",
            kind: "item",
            driveId: "drive-b",
            remoteId: "item-1",
            cursorKey: "drive:drive-b",
          }),
        },
      },
      {
        "drive-b:item-1": {
          id: "drive-b:item-1",
          revision: "e1",
          contentHash: "h",
          available: true,
          lastSeenAt: "2026-08-24T00:00:00.000Z",
        },
      },
    );

    const discovered = await adapter.discover(state);
    expect(discovered).toEqual({ ok: true, value: [] });
  });

  // Critical-bug regression (quality review of dd0d329): a RESUMED primary
  // (folder-scoped) container walk must NOT drop a changed nested file just
  // because its unchanged parent subfolder record isn't resent this cycle —
  // Graph delta only sends CHANGED items, so a file 2+ levels deep can arrive
  // with a parentReference the walk has never independently learned about.
  // The fix: the primary path no longer reasons about ancestry/parents at
  // all — it trusts Graph's own folder-scoped delta to have already scoped
  // every returned item to the subtree.
  it("a resumed primary container walk keeps a changed nested file whose parent subfolder record is absent from the page", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        if (url === "https://graph.microsoft.com/v1.0/drives/drive-a/stored-delta-link") {
          return graphJson({
            // Only the changed nested file is sent — no record at all for
            // "folder-child", its (unchanged) parent subfolder.
            value: [
              {
                id: "f-nested",
                eTag: "e2",
                file: {},
                parentReference: { id: "folder-child" },
              },
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-a/delta-link-2",
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    const state = microsoftProviderState(
      {
        cursor: JSON.stringify({
          v: 1,
          roots: {
            "enrollment:c1": "https://graph.microsoft.com/v1.0/drives/drive-a/stored-delta-link",
          },
        }),
        enrollments: {
          c1: enrollment({
            id: "c1",
            kind: "container",
            driveId: "drive-a",
            remoteId: "folder-a",
            cursorKey: "enrollment:c1",
          }),
        },
      },
      {
        "drive-a:f-nested": {
          id: "drive-a:f-nested",
          revision: "e1",
          contentHash: "h",
          available: true,
          lastSeenAt: "2026-08-24T00:00:00.000Z",
        },
      },
    );

    const discovered = await adapter.discover(state);
    expect(discovered).toEqual({ ok: true, value: [{ id: "drive-a:f-nested", revision: "e2" }] });
  });

  it("the drive-root fallback walk classifies a nested file correctly even when its record arrives before its subfolder's, in the same page", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        if (
          url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-c/items/folder-root/delta")
        ) {
          return new Response(null, { status: 400 });
        }
        if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-c/root/delta")) {
          return graphJson({
            value: [
              // The nested file arrives FIRST, before "folder-child" (its
              // parent) has been seen at all in this page.
              { id: "f-nested", eTag: "e1", file: {}, parentReference: { id: "folder-child" } },
              { id: "folder-child", folder: {}, parentReference: { id: "folder-root" } },
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-c/delta-link",
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    const state = microsoftProviderState(
      {
        enrollments: {
          c1: enrollment({
            id: "c1",
            kind: "container",
            driveId: "drive-c",
            remoteId: "folder-root",
            cursorKey: "enrollment:c1",
          }),
        },
      },
      {},
    );

    const discovered = await adapter.discover(state);
    expect(discovered).toEqual({ ok: true, value: [{ id: "drive-c:f-nested", revision: "e1" }] });
  });

  it("the two-pass fixpoint resolves 3+ levels of nesting even when delivered file-first (grandparent and parent both arrive after the file)", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        if (
          url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-c/items/folder-root/delta")
        ) {
          return new Response(null, { status: 400 });
        }
        if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-c/root/delta")) {
          return graphJson({
            value: [
              // File first, then its parent ("folder-grandchild"), then the
              // grandparent ("folder-child") whose own parent is the
              // enrolled root. A single streaming pass could never resolve
              // this; the fixpoint fold must run multiple sweeps.
              {
                id: "f-deep",
                eTag: "e1",
                file: {},
                parentReference: { id: "folder-grandchild" },
              },
              {
                id: "folder-grandchild",
                folder: {},
                parentReference: { id: "folder-child" },
              },
              { id: "folder-child", folder: {}, parentReference: { id: "folder-root" } },
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-c/delta-link",
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    const state = microsoftProviderState(
      {
        enrollments: {
          c1: enrollment({
            id: "c1",
            kind: "container",
            driveId: "drive-c",
            remoteId: "folder-root",
            cursorKey: "enrollment:c1",
          }),
        },
      },
      {},
    );

    const discovered = await adapter.discover(state);
    expect(discovered).toEqual({ ok: true, value: [{ id: "drive-c:f-deep", revision: "e1" }] });
  });

  // Locks in a conscious, documented R21/R37 deviation (fallback path only,
  // see applyContainerFallbackItem's comment): a previously-tracked item
  // that genuinely moves out of the enrolled subtree does NOT resolve to
  // available:false the moment its parent changes — it lingers in the
  // present set until an explicit `deleted` facet or a full resync. This is
  // the accepted cost of the Critical-bug fix (treating an ambiguous/
  // unresolved parent as "moved out" is exactly what caused the silent
  // data-loss this unit fixed).
  it("fallback mode: a previously-tracked item whose parent moves outside the enrolled subtree LINGERS in the present set (documented R21/R37 deviation)", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        if (url === "https://graph.microsoft.com/v1.0/drives/drive-c/stored-fallback-link") {
          return graphJson({
            value: [
              {
                id: "f-moved",
                eTag: "e2",
                file: {},
                parentReference: { id: "some-other-folder-entirely" },
              },
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-c/delta-link-2",
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    const state = microsoftProviderState(
      {
        cursor: JSON.stringify({
          v: 1,
          roots: {
            "enrollment:c1": {
              link: "https://graph.microsoft.com/v1.0/drives/drive-c/stored-fallback-link",
              folders: ["folder-root"],
            },
          },
        }),
        enrollments: {
          c1: enrollment({
            id: "c1",
            kind: "container",
            driveId: "drive-c",
            remoteId: "folder-root",
            cursorKey: "enrollment:c1",
          }),
        },
      },
      {
        "drive-c:f-moved": {
          id: "drive-c:f-moved",
          revision: "e1",
          contentHash: "h",
          available: true,
          lastSeenAt: "2026-08-24T00:00:00.000Z",
        },
      },
    );

    const discovered = await adapter.discover(state);
    // Lingers: still present, now carrying the stale-but-latest-seen
    // revision from this delta record, not removed.
    expect(discovered).toEqual({ ok: true, value: [{ id: "drive-c:f-moved", revision: "e1" }] });
  });

  it("last-occurrence-wins across a page boundary: the same id changing on page 1 and page 2 resolves to page 2's revision", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-b/root/delta")) {
          return graphJson({
            value: [{ id: "item-1", eTag: "e1", file: {}, parentReference: { id: "root-b" } }],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/drives/drive-b/page-2",
          });
        }
        if (url === "https://graph.microsoft.com/v1.0/drives/drive-b/page-2") {
          return graphJson({
            value: [{ id: "item-1", eTag: "e2", file: {}, parentReference: { id: "root-b" } }],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-b/delta-link",
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    const state = microsoftProviderState(
      {
        enrollments: {
          i1: enrollment({
            id: "i1",
            kind: "item",
            driveId: "drive-b",
            remoteId: "item-1",
            cursorKey: "drive:drive-b",
          }),
        },
      },
      {},
    );

    const discovered = await adapter.discover(state);
    expect(discovered).toEqual({ ok: true, value: [{ id: "drive-b:item-1", revision: "e2" }] });
  });

  it("a deleted item that reappears later in the same stream resolves to present", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-b/root/delta")) {
          return graphJson({
            value: [
              { id: "item-1", deleted: {} },
              { id: "item-1", eTag: "e2", file: {}, parentReference: { id: "root-b" } },
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-b/delta-link",
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    const state = microsoftProviderState(
      {
        enrollments: {
          i1: enrollment({
            id: "i1",
            kind: "item",
            driveId: "drive-b",
            remoteId: "item-1",
            cursorKey: "drive:drive-b",
          }),
        },
      },
      {},
    );

    const discovered = await adapter.discover(state);
    expect(discovered).toEqual({ ok: true, value: [{ id: "drive-b:item-1", revision: "e2" }] });
  });

  it("410 Gone on one root only re-initializes that root; the other root's stored link is retained", async () => {
    const requests: string[] = [];
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        requests.push(url);
        if (url === "https://graph.microsoft.com/v1.0/drives/drive-a/stale-delta-link") {
          return new Response(null, { status: 410 });
        }
        if (
          url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-a/items/folder-a/delta")
        ) {
          return graphJson({
            value: [{ id: "f1", eTag: "e1", file: {}, parentReference: { id: "folder-a" } }],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-a/delta-link-fresh",
          });
        }
        if (url === "https://graph.microsoft.com/v1.0/drives/drive-b/stored-delta-link") {
          return graphJson({
            value: [],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/drives/drive-b/delta-link-still-b",
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    const state = microsoftProviderState(
      {
        cursor: JSON.stringify({
          v: 1,
          roots: {
            "enrollment:c1": "https://graph.microsoft.com/v1.0/drives/drive-a/stale-delta-link",
            "drive:drive-b": "https://graph.microsoft.com/v1.0/drives/drive-b/stored-delta-link",
          },
        }),
        enrollments: {
          c1: enrollment({
            id: "c1",
            kind: "container",
            driveId: "drive-a",
            remoteId: "folder-a",
            cursorKey: "enrollment:c1",
          }),
          i1: enrollment({
            id: "i1",
            kind: "item",
            driveId: "drive-b",
            remoteId: "item-1",
            cursorKey: "drive:drive-b",
          }),
        },
      },
      {},
    );

    const discovered = await adapter.discover(state);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    expect(discovered.value).toEqual([{ id: "drive-a:f1", revision: "e1" }]);

    expect(JSON.parse(state.cursor as string)).toEqual({
      v: 1,
      roots: {
        "enrollment:c1": "https://graph.microsoft.com/v1.0/drives/drive-a/delta-link-fresh",
        "drive:drive-b": "https://graph.microsoft.com/v1.0/drives/drive-b/delta-link-still-b",
      },
    });
    // Root B resumed straight from its stored link — never re-initialized.
    expect(
      requests.some((url) =>
        url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-b/root/delta"),
      ),
    ).toBe(false);
    expect(requests).toContain("https://graph.microsoft.com/v1.0/drives/drive-b/stored-delta-link");
  });

  it("410 Gone on a root already in fallback mode re-inits straight to the drive-root endpoint, never re-probing the folder-scoped primary", async () => {
    const requests: string[] = [];
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        requests.push(url);
        if (url === "https://graph.microsoft.com/v1.0/drives/drive-c/stale-fallback-link") {
          return new Response(null, { status: 410 });
        }
        if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-c/root/delta")) {
          return graphJson({
            value: [{ id: "f1", eTag: "e1", file: {}, parentReference: { id: "folder-root" } }],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-c/delta-link-fresh",
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    const state = microsoftProviderState(
      {
        cursor: JSON.stringify({
          v: 1,
          roots: {
            "enrollment:c1": {
              link: "https://graph.microsoft.com/v1.0/drives/drive-c/stale-fallback-link",
              folders: ["folder-root"],
            },
          },
        }),
        enrollments: {
          c1: enrollment({
            id: "c1",
            kind: "container",
            driveId: "drive-c",
            remoteId: "folder-root",
            cursorKey: "enrollment:c1",
          }),
        },
      },
      {},
    );

    const discovered = await adapter.discover(state);
    expect(discovered).toEqual({ ok: true, value: [{ id: "drive-c:f1", revision: "e1" }] });
    // Never re-probed the folder-scoped primary endpoint — a root already
    // known (from its persisted cursor shape) to be in fallback mode skips
    // straight to the drive-root endpoint on resync.
    expect(
      requests.some((url) =>
        url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-c/items/folder-root/delta"),
      ),
    ).toBe(false);
    expect(JSON.parse(state.cursor as string)).toEqual({
      v: 1,
      roots: {
        "enrollment:c1": {
          link: "https://graph.microsoft.com/v1.0/drives/drive-c/delta-link-fresh",
          folders: ["folder-root"],
        },
      },
    });
  });

  it("429 with a short Retry-After retries once and succeeds", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const adapter = createMicrosoftAdapter({
        redirectUri: "https://vault.example/integrations/microsoft/callback",
        config: microsoftProviderConfig(),
        transport: async (url) => {
          if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-b/root/delta")) {
            attempts += 1;
            if (attempts === 1) {
              return new Response(null, { status: 429, headers: { "retry-after": "10" } });
            }
            return graphJson({
              value: [{ id: "item-1", eTag: "e1", file: {}, parentReference: { id: "root-b" } }],
              "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-b/delta-link",
            });
          }
          throw new Error(`unexpected request: ${url}`);
        },
      });
      const state = microsoftProviderState(
        {
          enrollments: {
            i1: enrollment({
              id: "i1",
              kind: "item",
              driveId: "drive-b",
              remoteId: "item-1",
              cursorKey: "drive:drive-b",
            }),
          },
        },
        {},
      );

      const discoverPromise = adapter.discover(state);
      await vi.advanceTimersByTimeAsync(10_000);
      const discovered = await discoverPromise;

      expect(discovered).toEqual({ ok: true, value: [{ id: "drive-b:item-1", revision: "e1" }] });
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("429 with a Retry-After beyond the retry budget fails without advancing the cursor", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-b/root/delta")) {
          return new Response(null, { status: 429, headers: { "retry-after": "60" } });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });
    const state = microsoftProviderState(
      {
        enrollments: {
          i1: enrollment({
            id: "i1",
            kind: "item",
            driveId: "drive-b",
            remoteId: "item-1",
            cursorKey: "drive:drive-b",
          }),
        },
      },
      {},
    );

    const discovered = await adapter.discover(state);
    expect(discovered.ok).toBe(false);
    expect(state.cursor).toBeUndefined();
  });

  it("bounds pagination against a repeated nextLink instead of looping forever", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        if (
          url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-b/root/delta") ||
          url === "https://graph.microsoft.com/v1.0/drives/drive-b/loop-link"
        ) {
          return graphJson({
            value: [],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/drives/drive-b/loop-link",
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });
    const state = microsoftProviderState(
      {
        enrollments: {
          i1: enrollment({
            id: "i1",
            kind: "item",
            driveId: "drive-b",
            remoteId: "item-1",
            cursorKey: "drive:drive-b",
          }),
        },
      },
      {},
    );

    const discovered = await adapter.discover(state);
    expect(discovered.ok).toBe(false);
    if (discovered.ok) return;
    expect(discovered.error.message).toMatch(/repeated a page link/);
    expect(state.cursor).toBeUndefined();
  });

  it("bounds pagination at the page limit when every nextLink is distinct", async () => {
    let pages = 0;
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        if (
          url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-b/root/delta") ||
          url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-b/unbounded-page-")
        ) {
          pages += 1;
          return graphJson({
            value: [],
            "@odata.nextLink": `https://graph.microsoft.com/v1.0/drives/drive-b/unbounded-page-${pages}`,
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });
    const state = microsoftProviderState(
      {
        enrollments: {
          i1: enrollment({
            id: "i1",
            kind: "item",
            driveId: "drive-b",
            remoteId: "item-1",
            cursorKey: "drive:drive-b",
          }),
        },
      },
      {},
    );

    const discovered = await adapter.discover(state);
    expect(discovered.ok).toBe(false);
    if (discovered.ok) return;
    expect(discovered.error.message).toMatch(/page limit/);
    expect(pages).toBe(1_000);
  });

  it("falls back to drive-root delta with ancestry filtering when the folder-scoped container delta 400s", async () => {
    const requests: string[] = [];
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        requests.push(url);
        if (
          url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-c/items/folder-root/delta")
        ) {
          return new Response(null, { status: 400 });
        }
        if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-c/root/delta")) {
          return graphJson({
            value: [
              // Out-of-subtree item, appearing on page 1 BEFORE any subfolder
              // of the enrolled tree is seen — ancestry is seeded with only
              // {folderId}, so this must be excluded purely on that basis.
              {
                id: "outside-1",
                eTag: "eo1",
                file: {},
                parentReference: { id: "some-other-folder" },
              },
              // The enrolled root folder itself — skipped as a source (id
              // matches folderId) but already a seeded ancestor.
              { id: "folder-root", folder: {}, parentReference: { id: "root" } },
              // A subfolder directly under the enrolled root: grows ancestry.
              { id: "folder-child", folder: {}, parentReference: { id: "folder-root" } },
              // A file under that just-discovered subfolder: included because
              // ancestry grew earlier in this same page.
              { id: "f-nested", eTag: "e2", file: {}, parentReference: { id: "folder-child" } },
              // A file directly under the enrolled root: included.
              { id: "f-direct", eTag: "e3", file: {}, parentReference: { id: "folder-root" } },
            ],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/drives/drive-c/delta-link-fallback",
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    const state = microsoftProviderState(
      {
        enrollments: {
          c1: enrollment({
            id: "c1",
            kind: "container",
            driveId: "drive-c",
            remoteId: "folder-root",
            cursorKey: "enrollment:c1",
          }),
        },
      },
      {},
    );

    const discovered = await adapter.discover(state);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    expect([...discovered.value].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "drive-c:f-direct", revision: "e3" },
      { id: "drive-c:f-nested", revision: "e2" },
    ]);
    // Fallback mode persists {link, folders} — not a bare link string — so a
    // resumed cycle can seed ancestry from what was already learned instead
    // of re-deriving it from just {folderId} (the Critical bug this fixes).
    expect(JSON.parse(state.cursor as string)).toEqual({
      v: 1,
      roots: {
        "enrollment:c1": {
          link: "https://graph.microsoft.com/v1.0/drives/drive-c/delta-link-fallback",
          folders: ["folder-root", "folder-child"],
        },
      },
    });

    expect(
      requests.some((url) =>
        url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-c/items/folder-root/delta"),
      ),
    ).toBe(true);
    expect(
      requests.some((url) =>
        url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-c/root/delta"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// U15: fetch — download, extractor routing, legacy conversion, short-circuit.
// ---------------------------------------------------------------------------

const GRAPH = "https://graph.microsoft.com/v1.0";

/** A raw-bytes Graph response (a download body, or a converted PDF). */
function bytesFixture(
  bytes: Uint8Array,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(bytes, {
    status,
    headers: { "content-type": "application/octet-stream", ...headers },
  });
}

function jsonFixture(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function redirectFixture(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

/**
 * Same prefix-matching contract as microsoft-fixtures.ts's
 * createFixtureTransport, but also records every request — U15's tests need
 * to assert on what WAS or WASN'T requested (no-download-on-guard-failure,
 * no-Authorization-on-the-redirect-followed-request, short-circuit skipping
 * HTTP entirely), which the response-only fixture helper can't do.
 */
function capturingTransport(
  fixtures: Record<string, Response[]>,
  requests: Array<{ url: string; init: RequestInit }>,
) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    requests.push({ url, init });
    const match = Object.entries(fixtures).find(([prefix]) => url.startsWith(prefix));
    if (match === undefined) throw new Error(`unexpected request: ${url}`);
    const response = match[1].shift();
    if (response === undefined) throw new Error(`no fixture left for: ${url}`);
    return response;
  };
}

function pptxMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "item1", name: "Deck.pptx", size: 12_345, file: {}, ...overrides };
}

function fetchState(
  overrides: Partial<ProviderState> = {},
  sources: Record<string, SourceState> = {},
): ProviderState {
  return { accessToken: "access-token", refreshToken: "refresh-token", sources, ...overrides };
}

describe("Microsoft adapter fetch (U15)", () => {
  it("happy .pptx: metadata -> 302 content -> real bytes -> text; the redirect-followed request carries NO Authorization header", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const deckBytes = buildDeck({ slideOrder: [1], withNotes: true });
    const transport = capturingTransport(
      {
        [`${GRAPH}/drives/drive1/items/item1/content`]: [
          redirectFixture("https://sas.example/blob1"),
        ],
        [`${GRAPH}/drives/drive1/items/item1`]: [jsonFixture(pptxMetadata())],
        "https://sas.example/blob1": [bytesFixture(deckBytes)],
      },
      requests,
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });

    const result = await adapter.fetch({ id: "drive1:item1", revision: "etag-1" }, fetchState());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe("drive1:item1");
    expect(result.value.revision).toBe("etag-1"); // revision echo (R21)
    expect(result.value.text).toContain("Slide 1 body text");

    const sasRequest = requests.find((r) => r.url.startsWith("https://sas.example/blob1"));
    expect(sasRequest).toBeDefined();
    const headers = new Headers(sasRequest?.init.headers);
    expect(headers.get("authorization")).toBeNull();
  });

  it("a malware facet on the metadata refuses without ever issuing a content request", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = capturingTransport(
      {
        [`${GRAPH}/drives/drive1/items/item1`]: [
          jsonFixture(pptxMetadata({ name: "bad.pdf", malware: { description: "eicar" } })),
        ],
      },
      requests,
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });

    const result = await adapter.fetch({ id: "drive1:item1", revision: "etag-1" }, fetchState());

    expect(result).toMatchObject({ ok: false, error: { reason: "malware" } });
    expect(requests.some((r) => r.url.includes("/content"))).toBe(false);
  });

  it("a metadata size over 25 MiB refuses before any content GET", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = capturingTransport(
      {
        [`${GRAPH}/drives/drive1/items/item1`]: [
          jsonFixture(pptxMetadata({ size: 30 * 1024 * 1024 })),
        ],
      },
      requests,
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });

    const result = await adapter.fetch({ id: "drive1:item1", revision: "etag-1" }, fetchState());

    expect(result).toMatchObject({ ok: false, error: { reason: "too_large" } });
    expect(requests.some((r) => r.url.includes("/content"))).toBe(false);
  });

  it("legacy .ppt converts via ?format=pdf, extracts through the PDF extractor, and is labeled pdf-conversion", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const pdfBytes = buildPdf([
      { contentOps: textOp("F1", 12, 50, 250, "Legacy content"), fonts: { F1: "Helvetica" } },
    ]);
    const transport = capturingTransport(
      {
        [`${GRAPH}/drives/drive1/items/item2/content`]: [
          redirectFixture("https://sas.example/blob2"),
        ],
        [`${GRAPH}/drives/drive1/items/item2`]: [
          jsonFixture(pptxMetadata({ id: "item2", name: "Old.ppt" })),
        ],
        "https://sas.example/blob2": [bytesFixture(pdfBytes)],
      },
      requests,
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });

    const result = await adapter.fetch({ id: "drive1:item2", revision: "etag-2" }, fetchState());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toContain("Legacy content");
    expect(result.value.text).not.toContain("[speaker notes]"); // lossy, as expected
    expect((result.value as { extractor?: string }).extractor).toBe("pdf-conversion");

    const contentRequest = requests.find((r) => r.url.includes("/item2/content"));
    expect(contentRequest?.url).toContain("format=pdf");
  });

  it("short-circuits a prior durable failure (R30) without any HTTP call when the revision is unchanged, but re-fetches once the revision changes", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = capturingTransport({}, requests);
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });
    const state = fetchState(undefined, {
      "drive1:item1": {
        id: "drive1:item1",
        revision: "etag-1",
        contentHash: "",
        available: true,
        lastSeenAt: "2026-08-24T00:00:00.000Z",
        lastFailure: { at: "2026-08-24T00:00:00.000Z", reason: "empty" },
      },
    });

    const unchanged = await adapter.fetch({ id: "drive1:item1", revision: "etag-1" }, state);
    expect(unchanged).toMatchObject({ ok: false, error: { reason: "empty" } });
    expect(requests).toHaveLength(0);

    const changedTransport = capturingTransport(
      {
        [`${GRAPH}/drives/drive1/items/item1/content`]: [
          redirectFixture("https://sas.example/blob1"),
        ],
        [`${GRAPH}/drives/drive1/items/item1`]: [jsonFixture(pptxMetadata())],
        "https://sas.example/blob1": [bytesFixture(buildDeck({ slideOrder: [1] }))],
      },
      requests,
    );
    const changedAdapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: changedTransport,
    });
    const changed = await changedAdapter.fetch({ id: "drive1:item1", revision: "etag-2" }, state);
    expect(changed.ok).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
  });

  it("an unsupported extension (.xlsx) refuses without any content download", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = capturingTransport(
      {
        [`${GRAPH}/drives/drive1/items/item1`]: [jsonFixture(pptxMetadata({ name: "Sheet.xlsx" }))],
      },
      requests,
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });

    const result = await adapter.fetch({ id: "drive1:item1", revision: "etag-1" }, fetchState());

    expect(result).toMatchObject({ ok: false, error: { reason: "unsupported_type" } });
    expect(requests.some((r) => r.url.includes("/content"))).toBe(false);
  });

  it("a 403 on the content download maps to permission_revoked", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = capturingTransport(
      {
        [`${GRAPH}/drives/drive1/items/item1/content`]: [new Response(null, { status: 403 })],
        [`${GRAPH}/drives/drive1/items/item1`]: [jsonFixture(pptxMetadata())],
      },
      requests,
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });

    const result = await adapter.fetch({ id: "drive1:item1", revision: "etag-1" }, fetchState());

    expect(result).toMatchObject({ ok: false, error: { reason: "permission_revoked" } });
  });

  it("resolves includeSpeakerNotes from the owning item enrollment, falling back to config when unresolvable", async () => {
    const deckBytes = buildDeck({ slideOrder: [1], withNotes: true });

    // Enrollment says false: speaker notes must be OMITTED even though the
    // provider config default (below) is true.
    const withEnrollment = capturingTransport(
      {
        [`${GRAPH}/drives/drive1/items/item1/content`]: [
          redirectFixture("https://sas.example/blob1"),
        ],
        [`${GRAPH}/drives/drive1/items/item1`]: [jsonFixture(pptxMetadata())],
        "https://sas.example/blob1": [bytesFixture(deckBytes)],
      },
      [],
    );
    const adapterWithEnrollment = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig({ includeSpeakerNotes: true }),
      transport: withEnrollment,
    });
    const stateWithEnrollment = fetchState({
      enrollments: {
        enr1: {
          id: "enr1",
          kind: "item",
          driveId: "drive1",
          remoteId: "item1",
          label: "Deck",
          collection: "distill",
          includeSpeakerNotes: false,
          enrolledBy: "user-1",
          enrolledAt: "2026-08-24T00:00:00.000Z",
          audienceAckAt: "2026-08-24T00:00:00.000Z",
          readersAtEnrollment: [],
          cursorKey: "enrollment:enr1",
        },
      },
    });
    const withEnrollmentResult = await adapterWithEnrollment.fetch(
      { id: "drive1:item1", revision: "etag-1" },
      stateWithEnrollment,
    );
    expect(withEnrollmentResult.ok).toBe(true);
    if (withEnrollmentResult.ok) {
      expect(withEnrollmentResult.value.text).not.toContain("[speaker notes]");
    }

    // No enrollment matches this source: falls back to config default (true).
    const withoutEnrollment = capturingTransport(
      {
        [`${GRAPH}/drives/drive1/items/item1/content`]: [
          redirectFixture("https://sas.example/blob1"),
        ],
        [`${GRAPH}/drives/drive1/items/item1`]: [jsonFixture(pptxMetadata())],
        "https://sas.example/blob1": [bytesFixture(deckBytes)],
      },
      [],
    );
    const adapterWithoutEnrollment = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig({ includeSpeakerNotes: true }),
      transport: withoutEnrollment,
    });
    const withoutEnrollmentResult = await adapterWithoutEnrollment.fetch(
      { id: "drive1:item1", revision: "etag-1" },
      fetchState(),
    );
    expect(withoutEnrollmentResult.ok).toBe(true);
    if (withoutEnrollmentResult.ok) {
      expect(withoutEnrollmentResult.value.text).toContain("[speaker notes]");
    }
  });

  it("a 429 on the metadata GET with a short Retry-After retries once and succeeds", async () => {
    vi.useFakeTimers();
    try {
      let metadataAttempts = 0;
      const requests: Array<{ url: string; init: RequestInit }> = [];
      const deckBytes = buildDeck({ slideOrder: [1] });
      const transport = async (url: string, init: RequestInit): Promise<Response> => {
        requests.push({ url, init });
        if (url.startsWith(`${GRAPH}/drives/drive1/items/item1/content`)) {
          return redirectFixture("https://sas.example/blob1");
        }
        if (url.startsWith("https://sas.example/blob1")) {
          return bytesFixture(deckBytes);
        }
        if (url.startsWith(`${GRAPH}/drives/drive1/items/item1`)) {
          metadataAttempts += 1;
          if (metadataAttempts === 1) {
            return new Response(null, { status: 429, headers: { "retry-after": "10" } });
          }
          return jsonFixture(pptxMetadata());
        }
        throw new Error(`unexpected request: ${url}`);
      };
      const adapter = createMicrosoftAdapter({
        redirectUri: "https://vault.example/integrations/microsoft/callback",
        config: microsoftProviderConfig(),
        transport,
      });

      const fetchPromise = adapter.fetch({ id: "drive1:item1", revision: "etag-1" }, fetchState());
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await fetchPromise;

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.text).toContain("Slide 1 body text");
      expect(metadataAttempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a 429 on the content GET beyond the retry budget fails without a partial result or further calls", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let contentAttempts = 0;
    const transport = async (url: string, init: RequestInit): Promise<Response> => {
      requests.push({ url, init });
      if (url.startsWith(`${GRAPH}/drives/drive1/items/item1/content`)) {
        contentAttempts += 1;
        return new Response(null, { status: 429, headers: { "retry-after": "60" } });
      }
      if (url.startsWith(`${GRAPH}/drives/drive1/items/item1`)) {
        return jsonFixture(pptxMetadata());
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });

    const result = await adapter.fetch({ id: "drive1:item1", revision: "etag-1" }, fetchState());

    expect(result.ok).toBe(false);
    // A Retry-After beyond the budget is a single hard failure, not a retry
    // loop: exactly one content request, and no SAS follow-up was ever
    // reached (there's nothing to follow — the content GET itself failed).
    expect(contentAttempts).toBe(1);
    expect(requests.some((r) => r.url.startsWith("https://sas.example"))).toBe(false);
  });

  it("routes a native .docx through the docx extractor with no ?format=pdf conversion", async () => {
    const docxBytes = buildDocxZip({
      "word/document.xml": wrapDocument("<w:p><w:r><w:t>Native docx content</w:t></w:r></w:p>"),
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = capturingTransport(
      {
        [`${GRAPH}/drives/drive1/items/item3/content`]: [
          redirectFixture("https://sas.example/blob3"),
        ],
        [`${GRAPH}/drives/drive1/items/item3`]: [
          jsonFixture(pptxMetadata({ id: "item3", name: "Doc.docx" })),
        ],
        "https://sas.example/blob3": [bytesFixture(docxBytes)],
      },
      requests,
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });

    const result = await adapter.fetch({ id: "drive1:item3", revision: "etag-3" }, fetchState());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toContain("Native docx content");
    const contentRequest = requests.find((r) => r.url.includes("/item3/content"));
    expect(contentRequest?.url).not.toContain("format=pdf");
  });

  it("routes a native .pdf through the pdf extractor with no ?format=pdf conversion", async () => {
    const pdfBytes = buildPdf([
      { contentOps: textOp("F1", 12, 50, 250, "Native pdf content"), fonts: { F1: "Helvetica" } },
    ]);
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = capturingTransport(
      {
        [`${GRAPH}/drives/drive1/items/item4/content`]: [
          redirectFixture("https://sas.example/blob4"),
        ],
        [`${GRAPH}/drives/drive1/items/item4`]: [
          jsonFixture(pptxMetadata({ id: "item4", name: "File.pdf" })),
        ],
        "https://sas.example/blob4": [bytesFixture(pdfBytes)],
      },
      requests,
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });

    const result = await adapter.fetch({ id: "drive1:item4", revision: "etag-4" }, fetchState());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toContain("Native pdf content");
    const contentRequest = requests.find((r) => r.url.includes("/item4/content"));
    expect(contentRequest?.url).not.toContain("format=pdf");
  });

  it("a 3xx content response with no Location header fails without crashing", async () => {
    const transport = capturingTransport(
      {
        [`${GRAPH}/drives/drive1/items/item1/content`]: [new Response(null, { status: 302 })],
        [`${GRAPH}/drives/drive1/items/item1`]: [jsonFixture(pptxMetadata())],
      },
      [],
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });

    const result = await adapter.fetch({ id: "drive1:item1", revision: "etag-1" }, fetchState());

    expect(result).toMatchObject({ ok: false, error: { reason: "fetch" } });
  });

  it("a double-302 (the SAS host redirects again) fails without following further, no infinite loop", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = capturingTransport(
      {
        [`${GRAPH}/drives/drive1/items/item1/content`]: [
          redirectFixture("https://sas.example/blob1"),
        ],
        [`${GRAPH}/drives/drive1/items/item1`]: [jsonFixture(pptxMetadata())],
        "https://sas.example/blob1": [redirectFixture("https://sas.example/blob1-again")],
      },
      requests,
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });

    const result = await adapter.fetch({ id: "drive1:item1", revision: "etag-1" }, fetchState());

    expect(result).toMatchObject({ ok: false, error: { reason: "fetch" } });
    // Bounded: the second redirect target is never requested.
    expect(requests.some((r) => r.url.startsWith("https://sas.example/blob1-again"))).toBe(false);
  });

  it("an unexpected 500 on the metadata GET fails tagged as reason 'fetch'", async () => {
    const transport = capturingTransport(
      { [`${GRAPH}/drives/drive1/items/item1`]: [new Response(null, { status: 500 })] },
      [],
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });

    const result = await adapter.fetch({ id: "drive1:item1", revision: "etag-1" }, fetchState());

    expect(result).toMatchObject({ ok: false, error: { reason: "fetch" } });
  });

  it("an unexpected 500 on the content GET fails tagged as reason 'fetch'", async () => {
    const transport = capturingTransport(
      {
        [`${GRAPH}/drives/drive1/items/item1/content`]: [new Response(null, { status: 500 })],
        [`${GRAPH}/drives/drive1/items/item1`]: [jsonFixture(pptxMetadata())],
      },
      [],
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });

    const result = await adapter.fetch({ id: "drive1:item1", revision: "etag-1" }, fetchState());

    expect(result).toMatchObject({ ok: false, error: { reason: "fetch" } });
  });

  it("a malware facet serialized as null is treated as no-malware, not refused", async () => {
    const deckBytes = buildDeck({ slideOrder: [1] });
    const transport = capturingTransport(
      {
        [`${GRAPH}/drives/drive1/items/item1/content`]: [
          redirectFixture("https://sas.example/blob1"),
        ],
        [`${GRAPH}/drives/drive1/items/item1`]: [jsonFixture(pptxMetadata({ malware: null }))],
        "https://sas.example/blob1": [bytesFixture(deckBytes)],
      },
      [],
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });

    const result = await adapter.fetch({ id: "drive1:item1", revision: "etag-1" }, fetchState());

    expect(result.ok).toBe(true);
  });
});

describe("Microsoft adapter webhooks (U16)", () => {
  function requireCapability<T>(capability: T | undefined, name: string): T {
    if (capability === undefined) throw new Error(`adapter is missing capability: ${name}`);
    return capability;
  }

  it("ensures one subscription per enrolled drive, fanned out under one channel; expiresAt is the earliest expiry", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = capturingTransport(
      {
        [`${GRAPH}/subscriptions`]: [
          jsonFixture({ id: "sub-1", expirationDateTime: "2026-10-01T00:00:00.000Z" }),
          jsonFixture({ id: "sub-2", expirationDateTime: "2026-09-25T00:00:00.000Z" }),
        ],
      },
      requests,
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });
    const providerState = fetchState({
      enrollments: {
        e1: enrollment({
          id: "e1",
          kind: "item",
          driveId: "drive1",
          remoteId: "item1",
          cursorKey: "drive:drive1",
        }),
        e2: enrollment({
          id: "e2",
          kind: "item",
          driveId: "drive2",
          remoteId: "item2",
          cursorKey: "drive:drive2",
        }),
      },
    });

    const ensured = await requireCapability(adapter.ensureWebhook, "ensureWebhook")(providerState, {
      callbackUrl: "https://vault.example/integrations/microsoft/webhook",
      now: new Date("2026-09-02T00:00:00.000Z"),
      renewBefore: new Date("2026-09-03T00:00:00.000Z"),
    });

    expect(ensured.ok).toBe(true);
    if (!ensured.ok) return;
    expect(ensured.value.expiresAt).toBe("2026-09-25T00:00:00.000Z");
    expect(ensured.value.subscriptions).toHaveLength(2);
    expect(ensured.value.subscriptions?.map((s) => s.resource).sort()).toEqual([
      "/drives/drive1/root",
      "/drives/drive2/root",
    ]);

    const posts = requests.filter((r) => r.url === `${GRAPH}/subscriptions`);
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      const body = JSON.parse(String(post.init.body)) as Record<string, unknown>;
      expect(body.changeType).toBe("updated");
      expect(body.clientState).toBe(ensured.value.secret);
      expect(body.notificationUrl).toBe("https://vault.example/integrations/microsoft/webhook");
      expect(body.lifecycleNotificationUrl).toBe(
        "https://vault.example/integrations/microsoft/webhook/lifecycle",
      );
      expect(body.resource).toMatch(/^\/drives\/drive[12]\/root$/);
    }
  });

  it("two enrollments sharing the same driveId dedup to exactly one subscription for that drive", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = capturingTransport(
      {
        [`${GRAPH}/subscriptions`]: [
          jsonFixture({ id: "sub-1", expirationDateTime: "2026-10-01T00:00:00.000Z" }),
        ],
      },
      requests,
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });
    const providerState = fetchState({
      enrollments: {
        e1: enrollment({
          id: "e1",
          kind: "item",
          driveId: "drive1",
          remoteId: "item1",
          cursorKey: "drive:drive1",
        }),
        // A second, distinct enrollment (a container, not an item) on the
        // SAME driveId — this must not produce a second subscription.
        e2: enrollment({
          id: "e2",
          kind: "container",
          driveId: "drive1",
          remoteId: "folder1",
          cursorKey: "enrollment:e2",
        }),
      },
    });

    const ensured = await requireCapability(adapter.ensureWebhook, "ensureWebhook")(providerState, {
      callbackUrl: "https://vault.example/integrations/microsoft/webhook",
      now: new Date("2026-09-02T00:00:00.000Z"),
      renewBefore: new Date("2026-09-03T00:00:00.000Z"),
    });

    expect(ensured).toMatchObject({
      ok: true,
      value: {
        subscriptions: [{ id: "sub-1", resource: "/drives/drive1/root" }],
      },
    });
    if (!ensured.ok) return;
    expect(ensured.value.subscriptions).toHaveLength(1);
    const posts = requests.filter((r) => r.url === `${GRAPH}/subscriptions`);
    expect(posts).toHaveLength(1);
  });

  it("renews a soon-to-expire subscription via PATCH, recreating via POST on a 404", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = capturingTransport(
      {
        [`${GRAPH}/subscriptions/sub-old`]: [jsonFixture({ error: "not found" }, 404)],
        [`${GRAPH}/subscriptions`]: [
          jsonFixture({ id: "sub-new", expirationDateTime: "2026-10-13T08:33:20.000Z" }),
        ],
      },
      requests,
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });
    const providerState = fetchState({
      enrollments: {
        e1: enrollment({
          id: "e1",
          kind: "item",
          driveId: "drive1",
          remoteId: "item1",
          cursorKey: "drive:drive1",
        }),
      },
      webhook: {
        id: "channel-1",
        secret: "channel-secret",
        subscriptions: [
          { id: "sub-old", resource: "/drives/drive1/root", expiresAt: "2026-09-02T10:00:00.000Z" },
        ],
      },
    });

    const ensured = await requireCapability(adapter.ensureWebhook, "ensureWebhook")(providerState, {
      callbackUrl: "https://vault.example/integrations/microsoft/webhook",
      now: new Date("2026-09-02T00:00:00.000Z"),
      renewBefore: new Date("2026-09-03T00:00:00.000Z"),
    });

    expect(ensured).toMatchObject({
      ok: true,
      value: {
        id: "channel-1",
        secret: "channel-secret",
        subscriptions: [
          { id: "sub-new", resource: "/drives/drive1/root", expiresAt: "2026-10-13T08:33:20.000Z" },
        ],
      },
    });
    const patched = requests.find((r) => r.url === `${GRAPH}/subscriptions/sub-old`);
    expect(patched?.init.method).toBe("PATCH");
    const recreated = requests.find((r) => r.url === `${GRAPH}/subscriptions`);
    expect(recreated?.init.method).toBe("POST");
  });

  it("keeps an unexpired subscription without any Graph call", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = capturingTransport({}, requests);
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });
    const providerState = fetchState({
      enrollments: {
        e1: enrollment({
          id: "e1",
          kind: "item",
          driveId: "drive1",
          remoteId: "item1",
          cursorKey: "drive:drive1",
        }),
      },
      webhook: {
        id: "channel-1",
        secret: "channel-secret",
        subscriptions: [
          {
            id: "sub-current",
            resource: "/drives/drive1/root",
            expiresAt: "2026-09-10T00:00:00.000Z",
          },
        ],
      },
    });

    const ensured = await requireCapability(adapter.ensureWebhook, "ensureWebhook")(providerState, {
      callbackUrl: "https://vault.example/integrations/microsoft/webhook",
      now: new Date("2026-09-02T00:00:00.000Z"),
      renewBefore: new Date("2026-09-03T00:00:00.000Z"),
    });

    expect(ensured).toMatchObject({
      ok: true,
      value: {
        id: "channel-1",
        secret: "channel-secret",
        subscriptions: [
          {
            id: "sub-current",
            resource: "/drives/drive1/root",
            expiresAt: "2026-09-10T00:00:00.000Z",
          },
        ],
      },
    });
    expect(requests).toHaveLength(0);
  });

  it("deletes a subscription whose drive no longer has a current enrollment", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = capturingTransport(
      { [`${GRAPH}/subscriptions/sub-gone`]: [new Response(null, { status: 204 })] },
      requests,
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });
    const providerState = fetchState({
      enrollments: {},
      webhook: {
        id: "channel-1",
        secret: "channel-secret",
        subscriptions: [
          {
            id: "sub-gone",
            resource: "/drives/drive-unenrolled/root",
            expiresAt: "2026-09-10T00:00:00.000Z",
          },
        ],
      },
    });

    const ensured = await requireCapability(adapter.ensureWebhook, "ensureWebhook")(providerState, {
      callbackUrl: "https://vault.example/integrations/microsoft/webhook",
      now: new Date("2026-09-02T00:00:00.000Z"),
      renewBefore: new Date("2026-09-03T00:00:00.000Z"),
    });

    expect(ensured).toMatchObject({ ok: true, value: { subscriptions: [] } });
    const deleted = requests.find((r) => r.url === `${GRAPH}/subscriptions/sub-gone`);
    expect(deleted?.init.method).toBe("DELETE");
  });

  it("deletes a stored subscription whose resource doesn't parse to any drive, rather than silently leaking it untracked", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = capturingTransport(
      { [`${GRAPH}/subscriptions/sub-malformed`]: [new Response(null, { status: 204 })] },
      requests,
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });
    const providerState = fetchState({
      enrollments: {},
      webhook: {
        id: "channel-1",
        secret: "channel-secret",
        subscriptions: [
          // A resource that doesn't match the `/drives/{id}/root` shape at
          // all — driveIdFromResource can't parse it, so it must never be
          // silently dropped from tracking; it has to be deleted just like
          // any other orphan.
          {
            id: "sub-malformed",
            resource: "not-a-drive-resource",
            expiresAt: "2026-09-10T00:00:00.000Z",
          },
        ],
      },
    });

    const ensured = await requireCapability(adapter.ensureWebhook, "ensureWebhook")(providerState, {
      callbackUrl: "https://vault.example/integrations/microsoft/webhook",
      now: new Date("2026-09-02T00:00:00.000Z"),
      renewBefore: new Date("2026-09-03T00:00:00.000Z"),
    });

    expect(ensured).toMatchObject({ ok: true, value: { subscriptions: [] } });
    const deleted = requests.find((r) => r.url === `${GRAPH}/subscriptions/sub-malformed`);
    expect(deleted?.init.method).toBe("DELETE");
  });

  it("R19: a non-HTTPS/loopback callback returns an empty channel and never calls Graph", async () => {
    const transport = capturingTransport({}, []);
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });
    const providerState = fetchState({
      enrollments: {
        e1: enrollment({
          id: "e1",
          kind: "item",
          driveId: "drive1",
          remoteId: "item1",
          cursorKey: "drive:drive1",
        }),
      },
    });

    const ensured = await requireCapability(adapter.ensureWebhook, "ensureWebhook")(providerState, {
      callbackUrl: "http://localhost/integrations/microsoft/webhook",
      now: new Date("2026-09-02T00:00:00.000Z"),
      renewBefore: new Date("2026-09-03T00:00:00.000Z"),
    });

    expect(ensured).toMatchObject({ ok: true, value: { subscriptions: [] } });
  });

  it("the clientState secret and channel id are stable across a renewal cycle", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = capturingTransport(
      {
        [`${GRAPH}/subscriptions`]: [
          jsonFixture({ id: "sub-1", expirationDateTime: "2026-10-01T00:00:00.000Z" }),
        ],
      },
      requests,
    );
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport,
    });
    const providerState = fetchState({
      enrollments: {
        e1: enrollment({
          id: "e1",
          kind: "item",
          driveId: "drive1",
          remoteId: "item1",
          cursorKey: "drive:drive1",
        }),
      },
    });

    const first = await requireCapability(adapter.ensureWebhook, "ensureWebhook")(providerState, {
      callbackUrl: "https://vault.example/integrations/microsoft/webhook",
      now: new Date("2026-09-02T00:00:00.000Z"),
      renewBefore: new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    providerState.webhook = first.value;

    const second = await requireCapability(adapter.ensureWebhook, "ensureWebhook")(providerState, {
      callbackUrl: "https://vault.example/integrations/microsoft/webhook",
      now: new Date("2026-09-02T01:00:00.000Z"),
      renewBefore: new Date("2026-09-03T01:00:00.000Z"),
    });
    expect(second).toMatchObject({
      ok: true,
      value: { id: first.value.id, secret: first.value.secret },
    });
    // The unexpired subscription (expires 2026-10-01, well past renewBefore
    // 2026-09-03T01:00:00) is retained without a second Graph call.
    expect(requests.filter((r) => r.url === `${GRAPH}/subscriptions`)).toHaveLength(1);
  });

  it("answerWebhookChallenge echoes the validation token verbatim, or returns undefined when absent", () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
    });

    expect(
      requireCapability(
        adapter.answerWebhookChallenge,
        "answerWebhookChallenge",
      )({
        headers: {},
        body: new Uint8Array(),
        query: { validationToken: "abc" },
      }),
    ).toBe("abc");
    expect(
      requireCapability(
        adapter.answerWebhookChallenge,
        "answerWebhookChallenge",
      )({
        headers: {},
        body: new Uint8Array(),
      }),
    ).toBeUndefined();
  });

  function webhookState(): ProviderState {
    return fetchState({
      webhook: {
        id: "channel-1",
        secret: "channel-secret",
        subscriptions: [
          { id: "sub-1", resource: "/drives/drive1/root", expiresAt: "2026-10-01T00:00:00.000Z" },
        ],
      },
    });
  }

  function notificationBody(entries: Array<Record<string, unknown>>): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ value: entries }));
  }

  it("verifyWebhook accepts a valid clientState + known subscriptionId, and rejects a wrong secret or unknown subscription", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
    });

    const valid = await requireCapability(adapter.verifyWebhook, "verifyWebhook")(
      {
        headers: {},
        body: notificationBody([{ subscriptionId: "sub-1", clientState: "channel-secret" }]),
      },
      webhookState(),
    );
    const wrongSecret = await requireCapability(adapter.verifyWebhook, "verifyWebhook")(
      {
        headers: {},
        body: notificationBody([{ subscriptionId: "sub-1", clientState: "attacker-secret" }]),
      },
      webhookState(),
    );
    const unknownSubscription = await requireCapability(adapter.verifyWebhook, "verifyWebhook")(
      {
        headers: {},
        body: notificationBody([{ subscriptionId: "sub-unknown", clientState: "channel-secret" }]),
      },
      webhookState(),
    );

    expect(valid).toEqual({
      ok: true,
      value: { kind: "event", eventId: expect.any(String), hint: { kind: "reconcile" } },
    });
    expect(wrongSecret.ok).toBe(false);
    expect(unknownSubscription.ok).toBe(false);
  });

  it("verifyWebhook mints a distinct event id for a duplicate Graph-retried notification with no id field", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
    });
    const body = notificationBody([{ subscriptionId: "sub-1", clientState: "channel-secret" }]);

    const first = await requireCapability(adapter.verifyWebhook, "verifyWebhook")(
      { headers: {}, body },
      webhookState(),
    );
    const second = await requireCapability(adapter.verifyWebhook, "verifyWebhook")(
      { headers: {}, body },
      webhookState(),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value).toMatchObject({ kind: "event" });
    expect(second.value).toMatchObject({ kind: "event" });
    expect((first.value as { eventId: string }).eventId).not.toBe(
      (second.value as { eventId: string }).eventId,
    );
  });

  it("verifyWebhook rejects the WHOLE batch when only one entry in a multi-entry notification is invalid", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
    });

    const wrongSecretInBatch = await requireCapability(adapter.verifyWebhook, "verifyWebhook")(
      {
        headers: {},
        body: notificationBody([
          { subscriptionId: "sub-1", clientState: "channel-secret" },
          { subscriptionId: "sub-1", clientState: "attacker-secret" },
        ]),
      },
      webhookState(),
    );
    const unknownSubscriptionInBatch = await requireCapability(
      adapter.verifyWebhook,
      "verifyWebhook",
    )(
      {
        headers: {},
        body: notificationBody([
          { subscriptionId: "sub-1", clientState: "channel-secret" },
          { subscriptionId: "sub-unknown", clientState: "channel-secret" },
        ]),
      },
      webhookState(),
    );

    expect(wrongSecretInBatch.ok).toBe(false);
    expect(unknownSubscriptionInBatch.ok).toBe(false);
  });

  it("verifyLifecycleWebhook maps each lifecycle event to its queued action, and rejects a wrong clientState", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
    });

    const reauthorize = await requireCapability(
      adapter.verifyLifecycleWebhook,
      "verifyLifecycleWebhook",
    )(
      {
        headers: {},
        body: notificationBody([
          {
            subscriptionId: "sub-1",
            clientState: "channel-secret",
            lifecycleEvent: "reauthorizationRequired",
          },
        ]),
      },
      webhookState(),
    );
    const recreate = await requireCapability(
      adapter.verifyLifecycleWebhook,
      "verifyLifecycleWebhook",
    )(
      {
        headers: {},
        body: notificationBody([
          {
            subscriptionId: "sub-1",
            clientState: "channel-secret",
            lifecycleEvent: "subscriptionRemoved",
          },
        ]),
      },
      webhookState(),
    );
    const reconcile = await requireCapability(
      adapter.verifyLifecycleWebhook,
      "verifyLifecycleWebhook",
    )(
      {
        headers: {},
        body: notificationBody([
          { subscriptionId: "sub-1", clientState: "channel-secret", lifecycleEvent: "missed" },
        ]),
      },
      webhookState(),
    );
    const wrongSecret = await requireCapability(
      adapter.verifyLifecycleWebhook,
      "verifyLifecycleWebhook",
    )(
      {
        headers: {},
        body: notificationBody([
          { subscriptionId: "sub-1", clientState: "attacker-secret", lifecycleEvent: "missed" },
        ]),
      },
      webhookState(),
    );

    expect(reauthorize).toEqual({
      ok: true,
      value: { kind: "lifecycle", eventId: expect.any(String), action: "reauthorize" },
    });
    expect(recreate).toEqual({
      ok: true,
      value: { kind: "lifecycle", eventId: expect.any(String), action: "recreate" },
    });
    expect(reconcile).toEqual({
      ok: true,
      value: { kind: "lifecycle", eventId: expect.any(String), action: "reconcile" },
    });
    expect(wrongSecret.ok).toBe(false);
  });
});

describe("Microsoft adapter enrollment resolve + estimate (U17)", () => {
  function role(overrides: Partial<RoleConfig> = {}): RoleConfig {
    return { read: [], write: [], promote: false, ratify: false, ...overrides };
  }

  const ctx = {
    user: "user-1",
    role: "editor",
    collection: "distill",
    includeSpeakerNotes: true,
  };

  it("rejects a forged picker item the account can't read (403) by name; it never reaches the draft", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-a/items/secret-1")) {
          return graphJson({ error: { code: "accessDenied" } }, 403);
        }
        if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-a/items/ok-1")) {
          return graphJson({ id: "ok-1", name: "ok.docx", file: {}, eTag: "e1", size: 100 });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });
    const state = microsoftProviderState();
    const selection = [
      { driveId: "drive-a", itemId: "secret-1", name: "secret.docx" },
      { driveId: "drive-a", itemId: "ok-1" },
    ];

    const result = await adapter.resolveEnrollment?.(selection, state, ctx);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value.items).toEqual([
      { driveId: "drive-a", remoteId: "ok-1", kind: "item", label: "ok.docx" },
    ]);
    expect(result.value.skipped).toEqual([{ name: "secret.docx", reason: "not_readable" }]);
  });

  it("skips an unsupported .xlsx in the pick, never enrolling it", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-a/items/sheet-1")) {
          return graphJson({ id: "sheet-1", name: "budget.xlsx", file: {}, eTag: "e1", size: 10 });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });
    const state = microsoftProviderState();
    const selection = [{ driveId: "drive-a", itemId: "sheet-1" }];

    const result = await adapter.resolveEnrollment?.(selection, state, ctx);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value.items).toEqual([]);
    expect(result.value.skipped).toEqual([{ name: "budget.xlsx", reason: "unsupported_type" }]);
  });

  it("a container expanding past 1,000 eligible files fails resolve instead of silently truncating", async () => {
    const manyFiles = Array.from({ length: 1_001 }, (_, i) => ({
      id: `f${i}`,
      name: `doc-${i}.docx`,
      eTag: `e${i}`,
      size: 10,
      file: {},
      parentReference: { id: "folder-big" },
    }));
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        if (
          url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-a/items/folder-big/delta")
        ) {
          return graphJson({
            value: manyFiles,
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-a/delta-link-big",
          });
        }
        if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-a/items/folder-big")) {
          return graphJson({ id: "folder-big", name: "Big Folder", folder: {} });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });
    const state = microsoftProviderState();
    const selection = [{ driveId: "drive-a", itemId: "folder-big" }];

    const result = await adapter.resolveEnrollment?.(selection, state, ctx);
    expect(result?.ok).toBe(false);
    if (result?.ok) return;
    expect(result.error.message).toMatch(/1,?001 eligible files/);
    expect(result.error.message).toMatch(/sub-folders/);
  });

  it("fails resolve when existing + newly-eligible sources would exceed the 2,000-source vault bound", async () => {
    const existingSources: ProviderState["sources"] = {};
    for (let i = 0; i < 1_995; i += 1) {
      existingSources[`drive-a:existing-${i}`] = {
        id: `drive-a:existing-${i}`,
        revision: "e",
        contentHash: "h",
        available: true,
        lastSeenAt: "2026-08-24T00:00:00.000Z",
      };
    }
    const manyFiles = Array.from({ length: 10 }, (_, i) => ({
      id: `f${i}`,
      name: `doc-${i}.docx`,
      eTag: `e${i}`,
      size: 10,
      file: {},
      parentReference: { id: "folder-near" },
    }));
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        if (
          url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-a/items/folder-near/delta")
        ) {
          return graphJson({
            value: manyFiles,
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-a/delta-link-near",
          });
        }
        if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-a/items/folder-near")) {
          return graphJson({ id: "folder-near", name: "Near Folder", folder: {} });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });
    const state = microsoftProviderState({}, existingSources);
    const selection = [{ driveId: "drive-a", itemId: "folder-near" }];

    const result = await adapter.resolveEnrollment?.(selection, state, ctx);
    expect(result?.ok).toBe(false);
    if (result?.ok) return;
    expect(result.error.message).toMatch(/2000-source vault/);
  });

  it("draft.readersAtEnrollment reflects the target collection's reader roles", async () => {
    const roles: Record<string, RoleConfig> = {
      editor: role({ read: ["distill"] }),
      viewer: role({ read: ["*"] }),
      other: role({ read: ["other-collection"] }),
    };
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      roles,
      transport: async (url) => {
        if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-a/items/doc-1")) {
          return graphJson({ id: "doc-1", name: "doc.docx", file: {}, eTag: "e1", size: 10 });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });
    const state = microsoftProviderState();
    const selection = [{ driveId: "drive-a", itemId: "doc-1" }];

    const result = await adapter.resolveEnrollment?.(selection, state, ctx);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value.readersAtEnrollment).toEqual(["editor", "viewer"]);
  });

  it("estimateEnrollment returns the §12 shape, with estimatedUsd present when configured, and readers/ratifiers reflect the collection's roles", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      estimatedUsdPerCall: 0.02,
      roles: {
        editor: role({ read: ["distill"] }),
        curator: role({ read: ["distill"], ratify: true }),
        unrelated: role({ read: ["other-collection"] }),
      },
      transport: async (url) => {
        if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-a/items/doc-1")) {
          return graphJson({
            id: "doc-1",
            name: "report.docx",
            file: {},
            eTag: "e1",
            size: 1_000_000,
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });
    const draft = {
      items: [
        { driveId: "drive-a", remoteId: "doc-1", kind: "item" as const, label: "report.docx" },
      ],
      collection: "distill",
      includeSpeakerNotes: true,
      readersAtEnrollment: [],
      skipped: [],
    };
    const state = microsoftProviderState();

    const result = await adapter.estimateEnrollment?.(draft, state);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value.eligible).toBe(1);
    expect(result.value.skipped).toEqual([]);
    expect(result.value.bytes).toBe(1_000_000);
    expect(result.value.byType).toEqual({ docx: 1_000_000, pptx: 0, pdf: 0 });
    // 1_000_000 * docxRatio(0.12354847077613262) / 16000 = 7.72..., ceil -> 8
    expect(result.value.estimatedCalls).toEqual({ low: 6, expected: 8, high: 10 });
    expect(result.value.estimatedUsd).toEqual({ expected: 0.16 });
    expect(result.value.collection).toBe("distill");
    expect(result.value.readers).toEqual(["curator", "editor"]);
    expect(result.value.ratifiers).toEqual(["curator"]);
  });

  it("omits estimatedUsd entirely when distill.estimated_usd_per_call is not configured", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-a/items/doc-1")) {
          return graphJson({ id: "doc-1", name: "report.docx", file: {}, eTag: "e1", size: 1_000 });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });
    const draft = {
      items: [
        { driveId: "drive-a", remoteId: "doc-1", kind: "item" as const, label: "report.docx" },
      ],
      collection: "distill",
      includeSpeakerNotes: true,
      readersAtEnrollment: [],
      skipped: [],
    };
    const state = microsoftProviderState();

    const result = await adapter.estimateEnrollment?.(draft, state);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value).not.toHaveProperty("estimatedUsd");
  });

  it("warns about lossy PDF conversion when the enrollment includes a legacy .ppt", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
      transport: async (url) => {
        if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-a/items/legacy-1")) {
          return graphJson({ id: "legacy-1", name: "deck.ppt", file: {}, eTag: "e1", size: 5_000 });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });
    const draft = {
      items: [
        { driveId: "drive-a", remoteId: "legacy-1", kind: "item" as const, label: "deck.ppt" },
      ],
      collection: "distill",
      includeSpeakerNotes: true,
      readersAtEnrollment: [],
      skipped: [],
    };
    const state = microsoftProviderState();

    const result = await adapter.estimateEnrollment?.(draft, state);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    // Legacy .doc/.ppt are converted to PDF by Graph before extraction, so
    // they're counted under the pdf ratio/bucket, not a separate one.
    expect(result.value.byType.pdf).toBe(5_000);
    expect(result.value.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/lossy PDF conversion/)]),
    );
  });

  it("the ratio constants match the committed U10 ratios.json (drift guard)", () => {
    const ratiosPath = new URL("../fixtures/extract/ratios.json", import.meta.url);
    const committed = JSON.parse(readFileSync(ratiosPath, "utf-8")) as Record<string, number>;
    expect(MICROSOFT_ESTIMATE_RATIOS.docx).toBe(committed.docx);
    expect(MICROSOFT_ESTIMATE_RATIOS.pptx).toBe(committed.pptx);
    expect(MICROSOFT_ESTIMATE_RATIOS.pdf).toBe(committed.pdf);
  });
});
