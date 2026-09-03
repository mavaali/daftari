import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateContinuousAdapterCapabilities } from "../../src/integrations/engine.js";
import { createMicrosoftAdapter } from "../../src/integrations/microsoft.js";
import { createConfiguredIntegrationRuntime } from "../../src/integrations/runtime.js";
import { writeIntegrationState } from "../../src/integrations/state.js";
import type { EnrollmentRecord, IntegrationConfig } from "../../src/integrations/types.js";
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

  it("discover with no enrollments returns an empty set without any HTTP call; the remaining not-yet-implemented methods are clearly labelled", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
    });

    await expect(
      adapter.discover({ accessToken: "a", refreshToken: "r", sources: {} }),
    ).resolves.toEqual({ ok: true, value: [] });
    await expect(
      adapter.fetch(
        { id: "x", revision: "1" },
        { accessToken: "a", refreshToken: "r", sources: {} },
      ),
    ).rejects.toThrow("microsoft fetch not yet implemented (U15)");
    await expect(
      adapter.ensureWebhook?.(
        { accessToken: "a", refreshToken: "r", sources: {} },
        { callbackUrl: "https://vault.example/hook", now: new Date(), renewBefore: new Date() },
      ),
    ).rejects.toThrow("microsoft ensureWebhook not yet implemented (U16)");
    await expect(
      adapter.verifyWebhook?.(
        { headers: {}, body: new Uint8Array() },
        { accessToken: "a", refreshToken: "r", sources: {} },
      ),
    ).rejects.toThrow("microsoft verifyWebhook not yet implemented (U16)");
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
