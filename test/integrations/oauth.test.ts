import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "../../src/frontmatter/types.js";
import type { EngineDeps, ProviderAdapter } from "../../src/integrations/engine.js";
import { beginAuthorization, completeAuthorization } from "../../src/integrations/oauth.js";
import { readIntegrationState } from "../../src/integrations/state.js";
import type { IntegrationConfig } from "../../src/integrations/types.js";

const KEY = Buffer.alloc(32, 7);
const config: IntegrationConfig = {
  encryptionKeyEnv: "DAFTARI_INTEGRATIONS_KEY",
  pollingIntervalMinutes: 15,
  google: { clientIdEnv: "GOOGLE_CLIENT_ID", clientSecretEnv: "GOOGLE_CLIENT_SECRET" },
};
const environment = {
  DAFTARI_INTEGRATIONS_KEY: KEY.toString("base64"),
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
};
const now = () => new Date("2026-08-24T12:00:00.000Z");

function adapter(
  exchangeCode = vi.fn(async () => ok({ accessToken: "access", refreshToken: "refresh" })),
) {
  return {
    name: "google",
    authorizationUrl: () => "https://accounts.example/authorize",
    exchangeCode,
    discover: async () => ok([]),
    fetch: async () => err(new Error("not used")),
  } satisfies ProviderAdapter;
}

function deps(provider: ProviderAdapter): EngineDeps {
  return {
    config,
    environment,
    adapters: { google: provider },
    now,
    distill: async () => ok({ runId: "unused" }),
  };
}

describe("integration OAuth transactions", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-integration-oauth-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("consumes a replayed OAuth state before a second code exchange", async () => {
    const provider = adapter();
    const started = beginAuthorization(vault, "google", config, environment, now);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(
      await completeAuthorization(vault, "google", started.value.state, "code", deps(provider)),
    ).toEqual(ok(undefined));
    const replay = await completeAuthorization(
      vault,
      "google",
      started.value.state,
      "code",
      deps(provider),
    );

    expect(replay.ok).toBe(false);
    expect(provider.exchangeCode).toHaveBeenCalledTimes(1);
    expect(readIntegrationState(vault, KEY)).toEqual(
      ok({
        providers: {
          google: { accessToken: "access", refreshToken: "refresh", sources: {} },
        },
        oauthStates: {},
      }),
    );
  });

  it("rejects an expired OAuth state without exchanging a code", async () => {
    const provider = adapter();
    const started = beginAuthorization(vault, "google", config, environment, now);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const expired = await completeAuthorization(
      vault,
      "google",
      started.value.state,
      "another-code",
      { ...deps(provider), now: () => new Date("2026-08-24T12:11:00.000Z") },
    );
    expect(expired.ok).toBe(false);
    expect(provider.exchangeCode).not.toHaveBeenCalled();
  });

  it("returns a safe error when a provider code exchange throws", async () => {
    const provider = adapter(
      vi.fn(async () => {
        throw new Error("provider response included a secret");
      }),
    );
    const started = beginAuthorization(vault, "google", config, environment, now);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const result = await completeAuthorization(
      vault,
      "google",
      started.value.state,
      "code",
      deps(provider),
    );

    expect(result).toEqual(err(new Error("OAuth code exchange failed for google")));
    expect(readIntegrationState(vault, KEY)).toEqual(ok({ providers: {}, oauthStates: {} }));
  });
});
