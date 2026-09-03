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

  it("leaves discover a safe no-op and the not-yet-implemented methods clearly labelled", async () => {
    const adapter = createMicrosoftAdapter({
      redirectUri: "https://vault.example/integrations/microsoft/callback",
      config: microsoftProviderConfig(),
    });

    await expect(
      adapter.discover({ accessToken: "a", refreshToken: "r", sources: {} }),
    ).resolves.toEqual({ ok: true, value: [] });
    await expect(adapter.exchangeCode({} as never)).resolves.toEqual({
      ok: false,
      error: new Error("microsoft exchangeCode not yet implemented (U13)"),
    });
    await expect(adapter.refreshTokens?.({} as never)).rejects.toThrow(
      "microsoft refreshTokens not yet implemented (U14)",
    );
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
