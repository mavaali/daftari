import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateContinuousAdapterCapabilities } from "../../src/integrations/engine.js";
import { createMicrosoftAdapter } from "../../src/integrations/microsoft.js";
import { createConfiguredIntegrationRuntime } from "../../src/integrations/runtime.js";
import { writeIntegrationState } from "../../src/integrations/state.js";
import type { IntegrationConfig } from "../../src/integrations/types.js";
import {
  createFixtureTransport,
  meFixture,
  microsoftProviderConfig,
} from "./microsoft-fixtures.js";

const KEY = Buffer.alloc(32, 7);

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

  it("leaves discover a safe no-op and the remaining not-yet-implemented methods clearly labelled", async () => {
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
