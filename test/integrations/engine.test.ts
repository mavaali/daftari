import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "../../src/frontmatter/types.js";
import {
  type DistillationInput,
  type EngineDeps,
  ensureProviderWebhook,
  type ProviderAdapter,
  reconcileProvider,
  startPeriodicIntegrationSync,
  validateContinuousAdapterCapabilities,
  verifyProviderWebhook,
} from "../../src/integrations/engine.js";
import { readIntegrationState, writeIntegrationState } from "../../src/integrations/state.js";
import type { IntegrationConfig, ProviderState } from "../../src/integrations/types.js";
import { sha256Hex } from "../../src/utils/hash.js";

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

function providerState(sources: ProviderState["sources"] = {}): ProviderState {
  return { accessToken: "access", refreshToken: "refresh", sources };
}

function adapter(input: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    name: "google",
    authorizationUrl: () => "https://accounts.example/authorize",
    exchangeCode: async () => ok({ accessToken: "access", refreshToken: "refresh" }),
    discover: async () => ok([]),
    fetch: async () => err(new Error("not used")),
    ...input,
  };
}

function deps(overrides: Partial<EngineDeps> = {}): EngineDeps {
  return {
    config,
    environment,
    adapters: {},
    now,
    distill: async () => ok({ runId: "run-1" }),
    ...overrides,
  };
}

describe("provider reconciliation", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-integration-engine-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("does not invoke distillation when a normalized source hash is unchanged", async () => {
    const text = "A stable normalized document";
    expect(
      writeIntegrationState(
        vault,
        {
          providers: {
            google: providerState({
              "doc-1": {
                id: "doc-1",
                revision: "1",
                contentHash: sha256Hex(text),
                available: true,
                lastSeenAt: "2026-08-23T12:00:00.000Z",
              },
            }),
          },
          oauthStates: {},
        },
        KEY,
      ),
    ).toEqual(ok(undefined));
    const distill = vi.fn(async () => ok({ runId: "should-not-run" }));
    const result = await reconcileProvider(
      vault,
      adapter({
        discover: async () => ok([{ id: "doc-1", revision: "2" }]),
        fetch: async () => ok({ id: "doc-1", revision: "2", text }),
      }),
      deps({ distill }),
    );

    expect(result).toEqual(
      ok({
        distilledSourceIds: [],
        unchangedSourceIds: ["google:doc-1"],
        failedSourceIds: [],
        unavailableSourceIds: [],
      }),
    );
    expect(distill).not.toHaveBeenCalled();
    expect(readIntegrationState(vault, KEY).value.providers.google?.sources["doc-1"]).toMatchObject(
      {
        revision: "2",
        available: true,
        lastSeenAt: "2026-08-24T12:00:00.000Z",
      },
    );
  });

  it("stages only changed normalized text and never persists that text", async () => {
    const text = "A changed normalized document";
    expect(
      writeIntegrationState(
        vault,
        { providers: { google: providerState() }, oauthStates: {} },
        KEY,
      ),
    ).toEqual(ok(undefined));
    const inputs: DistillationInput[] = [];
    const result = await reconcileProvider(
      vault,
      adapter({
        discover: async () => ok([{ id: "doc-1", revision: "2" }]),
        fetch: async () => ok({ id: "doc-1", revision: "2", text }),
      }),
      deps({
        distill: async (input) => {
          inputs.push(input);
          return ok({ runId: "run-2" });
        },
      }),
    );

    expect(result).toEqual(
      ok({
        distilledSourceIds: ["google:doc-1"],
        unchangedSourceIds: [],
        failedSourceIds: [],
        unavailableSourceIds: [],
      }),
    );
    expect(inputs).toEqual([{ providerSourceId: "google:doc-1", revision: "2", text }]);
    expect(readIntegrationState(vault, KEY)).toEqual(
      ok({
        providers: {
          google: {
            accessToken: "access",
            refreshToken: "refresh",
            sources: {
              "doc-1": {
                id: "doc-1",
                revision: "2",
                contentHash: sha256Hex(text),
                available: true,
                lastSeenAt: "2026-08-24T12:00:00.000Z",
                lastDistillRunId: "run-2",
              },
            },
          },
        },
        oauthStates: {},
      }),
    );
  });

  it("continues after one distillation failure without advancing that source hash", async () => {
    const failedText = "This source fails distillation";
    expect(
      writeIntegrationState(
        vault,
        { providers: { google: providerState() }, oauthStates: {} },
        KEY,
      ),
    ).toEqual(ok(undefined));
    const result = await reconcileProvider(
      vault,
      adapter({
        discover: async () =>
          ok([
            { id: "failed", revision: "2" },
            { id: "good", revision: "1" },
          ]),
        fetch: async (source) =>
          ok({
            id: source.id,
            revision: source.revision,
            text: source.id === "failed" ? failedText : "Good",
          }),
      }),
      deps({
        distill: async (input) =>
          input.providerSourceId === "google:failed"
            ? err(new Error("distillation failed"))
            : ok({ runId: "run-good" }),
      }),
    );

    expect(result).toEqual(
      ok({
        distilledSourceIds: ["google:good"],
        unchangedSourceIds: [],
        failedSourceIds: ["google:failed"],
        unavailableSourceIds: [],
      }),
    );
    const sources = readIntegrationState(vault, KEY).value.providers.google?.sources;
    expect(sources?.failed.contentHash).toBe("");
    expect(sources?.failed.revision).toBe("2");
    expect(sources?.good.contentHash).toBe(sha256Hex("Good"));
  });

  it("continues after one source fetch throws", async () => {
    expect(
      writeIntegrationState(
        vault,
        { providers: { google: providerState() }, oauthStates: {} },
        KEY,
      ),
    ).toEqual(ok(undefined));
    const result = await reconcileProvider(
      vault,
      adapter({
        discover: async () =>
          ok([
            { id: "failed", revision: "1" },
            { id: "good", revision: "1" },
          ]),
        fetch: async (source) => {
          if (source.id === "failed") throw new Error("temporary provider failure");
          return ok({ id: source.id, revision: source.revision, text: "Good" });
        },
      }),
      deps(),
    );

    expect(result).toEqual(
      ok({
        distilledSourceIds: ["google:good"],
        unchangedSourceIds: [],
        failedSourceIds: ["google:failed"],
        unavailableSourceIds: [],
      }),
    );
  });

  it("persists rotated tokens before discovering with an expired access token", async () => {
    expect(
      writeIntegrationState(
        vault,
        {
          providers: {
            google: {
              ...providerState(),
              accessToken: "expired-access",
              refreshToken: "old-refresh",
              accessTokenExpiresAt: "2026-08-24T11:00:00.000Z",
            },
          },
          oauthStates: {},
        },
        KEY,
      ),
    ).toEqual(ok(undefined));
    let refreshInput: unknown;
    let discoveredState: ProviderState | undefined;
    let persistedAccessToken: string | undefined;
    const result = await reconcileProvider(
      vault,
      adapter({
        refreshTokens: async (input) => {
          refreshInput = input;
          return ok({
            accessToken: "rotated-access",
            refreshToken: "rotated-refresh",
            accessTokenExpiresAt: "2026-08-24T13:00:00.000Z",
          });
        },
        discover: async (state) => {
          discoveredState = state;
          const persisted = readIntegrationState(vault, KEY);
          if (persisted.ok) persistedAccessToken = persisted.value.providers.google?.accessToken;
          return ok([]);
        },
      }),
      deps(),
    );

    expect(result.ok).toBe(true);
    expect(refreshInput).toEqual({
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
      refreshToken: "old-refresh",
    });
    expect(discoveredState).toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
    });
    expect(persistedAccessToken).toBe("rotated-access");
    expect(readIntegrationState(vault, KEY).value.providers.google).toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      accessTokenExpiresAt: "2026-08-24T13:00:00.000Z",
    });
  });

  it("does not call a provider when expired-token refresh fails", async () => {
    expect(
      writeIntegrationState(
        vault,
        {
          providers: {
            google: {
              ...providerState(),
              accessToken: "expired-access",
              refreshToken: "old-refresh",
              accessTokenExpiresAt: "2026-08-24T11:00:00.000Z",
            },
          },
          oauthStates: {},
        },
        KEY,
      ),
    ).toEqual(ok(undefined));
    let discovered = false;
    const result = await reconcileProvider(
      vault,
      adapter({
        refreshTokens: async () => err(new Error("refresh failed")),
        discover: async () => {
          discovered = true;
          return ok([]);
        },
      }),
      deps(),
    );

    expect(result.ok).toBe(false);
    expect(discovered).toBe(false);
    expect(readIntegrationState(vault, KEY).value.providers.google?.accessToken).toBe(
      "expired-access",
    );
  });

  it("persists a webhook channel only after provider setup succeeds", async () => {
    expect(
      writeIntegrationState(
        vault,
        { providers: { google: providerState() }, oauthStates: {} },
        KEY,
      ),
    ).toEqual(ok(undefined));
    const result = await ensureProviderWebhook(
      vault,
      adapter({
        ensureWebhook: async () =>
          ok({ id: "channel-1", secret: "webhook-secret", expiresAt: "2026-08-25T12:00:00.000Z" }),
      }),
      {
        callbackUrl: "https://daftari.example/integrations/google/webhook",
        now: new Date("2026-08-24T12:00:00.000Z"),
        renewBefore: new Date("2026-08-25T11:00:00.000Z"),
      },
      deps(),
    );

    expect(result).toEqual(
      ok({ id: "channel-1", secret: "webhook-secret", expiresAt: "2026-08-25T12:00:00.000Z" }),
    );
    expect(readIntegrationState(vault, KEY).value.providers.google?.webhook).toEqual({
      id: "channel-1",
      secret: "webhook-secret",
      expiresAt: "2026-08-25T12:00:00.000Z",
    });
  });

  it("refreshes and persists expired tokens before ensuring a webhook", async () => {
    expect(
      writeIntegrationState(
        vault,
        {
          providers: {
            google: {
              ...providerState(),
              accessToken: "expired-access",
              refreshToken: "old-refresh",
              accessTokenExpiresAt: "2026-08-24T11:00:00.000Z",
            },
          },
          oauthStates: {},
        },
        KEY,
      ),
    ).toEqual(ok(undefined));
    let ensuredAccessToken: string | undefined;
    let persistedAccessToken: string | undefined;
    const result = await ensureProviderWebhook(
      vault,
      adapter({
        refreshTokens: async () =>
          ok({
            accessToken: "rotated-access",
            refreshToken: "rotated-refresh",
            accessTokenExpiresAt: "2026-08-24T13:00:00.000Z",
          }),
        ensureWebhook: async (state) => {
          ensuredAccessToken = state.accessToken;
          const persisted = readIntegrationState(vault, KEY);
          if (persisted.ok) persistedAccessToken = persisted.value.providers.google?.accessToken;
          return ok({ id: "channel-1", secret: "webhook-secret" });
        },
      }),
      {
        callbackUrl: "https://daftari.example/integrations/google/webhook",
        now: new Date("2026-08-24T12:00:00.000Z"),
        renewBefore: new Date("2026-08-25T11:00:00.000Z"),
      },
      deps(),
    );

    expect(result.ok).toBe(true);
    expect(ensuredAccessToken).toBe("rotated-access");
    expect(persistedAccessToken).toBe("rotated-access");
    expect(readIntegrationState(vault, KEY).value.providers.google).toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      webhook: { id: "channel-1", secret: "webhook-secret" },
    });
  });

  it("does not ensure a webhook after expired-token refresh fails", async () => {
    expect(
      writeIntegrationState(
        vault,
        {
          providers: {
            google: {
              ...providerState(),
              accessToken: "expired-access",
              refreshToken: "old-refresh",
              accessTokenExpiresAt: "2026-08-24T11:00:00.000Z",
            },
          },
          oauthStates: {},
        },
        KEY,
      ),
    ).toEqual(ok(undefined));
    let ensured = false;
    const result = await ensureProviderWebhook(
      vault,
      adapter({
        refreshTokens: async () => err(new Error("refresh failed")),
        ensureWebhook: async () => {
          ensured = true;
          return ok({ id: "channel-1", secret: "webhook-secret" });
        },
      }),
      {
        callbackUrl: "https://daftari.example/integrations/google/webhook",
        now: new Date("2026-08-24T12:00:00.000Z"),
        renewBefore: new Date("2026-08-25T11:00:00.000Z"),
      },
      deps(),
    );

    expect(result.ok).toBe(false);
    expect(ensured).toBe(false);
    expect(readIntegrationState(vault, KEY).value.providers.google?.accessToken).toBe(
      "expired-access",
    );
  });

  it("preserves a prior webhook channel when provider setup fails", async () => {
    const previous = { id: "previous-channel", secret: "previous-secret" };
    expect(
      writeIntegrationState(
        vault,
        { providers: { google: { ...providerState(), webhook: previous } }, oauthStates: {} },
        KEY,
      ),
    ).toEqual(ok(undefined));
    const result = await ensureProviderWebhook(
      vault,
      adapter({ ensureWebhook: async () => err(new Error("webhook setup failed")) }),
      {
        callbackUrl: "https://daftari.example/integrations/google/webhook",
        now: new Date("2026-08-24T12:00:00.000Z"),
        renewBefore: new Date("2026-08-25T11:00:00.000Z"),
      },
      deps(),
    );

    expect(result.ok).toBe(false);
    expect(readIntegrationState(vault, KEY).value.providers.google?.webhook).toEqual(previous);
  });

  it("returns generic verified webhook refresh hints for routes to queue", async () => {
    expect(
      writeIntegrationState(
        vault,
        { providers: { google: providerState() }, oauthStates: {} },
        KEY,
      ),
    ).toEqual(ok(undefined));
    const result = await verifyProviderWebhook(
      vault,
      adapter({
        verifyWebhook: async () => ok({ kind: "sources", sourceIds: ["doc-1"], rediscover: true }),
      }),
      { headers: { "x-provider-signature": "signature" }, body: Buffer.from("event") },
      deps(),
    );

    expect(result).toEqual(ok({ kind: "sources", sourceIds: ["doc-1"], rediscover: true }));
  });

  it("rejects a polling adapter missing token refresh capability", () => {
    expect(validateContinuousAdapterCapabilities(adapter(), { webhooksRequired: false }).ok).toBe(
      false,
    );
  });

  it("rejects a webhook adapter missing both webhook capabilities", () => {
    expect(
      validateContinuousAdapterCapabilities(
        adapter({ refreshTokens: async () => ok({ accessToken: "next", refreshToken: "next" }) }),
        { webhooksRequired: true },
      ).ok,
    ).toBe(false);
  });

  it("accepts a complete continuous adapter contract", () => {
    expect(
      validateContinuousAdapterCapabilities(
        adapter({
          refreshTokens: async () => ok({ accessToken: "next", refreshToken: "next" }),
          ensureWebhook: async () => ok({ id: "channel-1", secret: "secret" }),
          verifyWebhook: async () => ok({ kind: "reconcile" }),
        }),
        { webhooksRequired: true },
      ),
    ).toEqual(ok(undefined));
  });

  it("marks a no-longer-discovered source unavailable while preserving its hash", async () => {
    const priorHash = sha256Hex("Previously available");
    expect(
      writeIntegrationState(
        vault,
        {
          providers: {
            google: providerState({
              "doc-1": {
                id: "doc-1",
                revision: "1",
                contentHash: priorHash,
                available: true,
                lastSeenAt: "2026-08-23T12:00:00.000Z",
              },
            }),
          },
          oauthStates: {},
        },
        KEY,
      ),
    ).toEqual(ok(undefined));
    const unavailable: Array<{ providerSourceId: string; reason: string }> = [];

    const result = await reconcileProvider(
      vault,
      adapter({ discover: async () => ok([]) }),
      deps({
        recordUnavailable: (event) => {
          unavailable.push(event);
          return ok(undefined);
        },
      }),
    );

    expect(result).toEqual(
      ok({
        distilledSourceIds: [],
        unchangedSourceIds: [],
        failedSourceIds: [],
        unavailableSourceIds: ["google:doc-1"],
      }),
    );
    expect(unavailable).toEqual([
      {
        idempotencyKey: "google:doc-1:1",
        providerSourceId: "google:doc-1",
        reason: "no_longer_discovered",
        revision: "1",
        occurredAt: "2026-08-24T12:00:00.000Z",
      },
    ]);
    expect(readIntegrationState(vault, KEY).value.providers.google?.sources["doc-1"]).toMatchObject(
      {
        contentHash: priorHash,
        available: false,
      },
    );
  });

  it("retries an unavailable review event before marking its source unavailable", async () => {
    expect(
      writeIntegrationState(
        vault,
        {
          providers: {
            google: providerState({
              "doc-1": {
                id: "doc-1",
                revision: "1",
                contentHash: sha256Hex("Previously available"),
                available: true,
                lastSeenAt: "2026-08-23T12:00:00.000Z",
              },
            }),
          },
          oauthStates: {},
        },
        KEY,
      ),
    ).toEqual(ok(undefined));
    const events: string[] = [];
    let firstAttempt = true;
    const recordUnavailable = (event: { providerSourceId: string }) => {
      if (firstAttempt) {
        firstAttempt = false;
        return err(new Error("review queue unavailable"));
      }
      events.push(event.providerSourceId);
      return ok(undefined);
    };

    const first = await reconcileProvider(
      vault,
      adapter({ discover: async () => ok([]) }),
      deps({ recordUnavailable }),
    );
    expect(first.ok).toBe(false);
    expect(
      readIntegrationState(vault, KEY).value.providers.google?.sources["doc-1"]?.available,
    ).toBe(true);

    const second = await reconcileProvider(
      vault,
      adapter({ discover: async () => ok([]) }),
      deps({ recordUnavailable }),
    );
    expect(second).toEqual(
      ok({
        distilledSourceIds: [],
        unchangedSourceIds: [],
        failedSourceIds: [],
        unavailableSourceIds: ["google:doc-1"],
      }),
    );
    expect(events).toEqual(["google:doc-1"]);
    expect(
      readIntegrationState(vault, KEY).value.providers.google?.sources["doc-1"]?.available,
    ).toBe(false);
  });

  it("reuses an unavailable event key when the state write fails after event persistence", async () => {
    expect(
      writeIntegrationState(
        vault,
        {
          providers: {
            google: providerState({
              "doc-1": {
                id: "doc-1",
                revision: "1",
                contentHash: sha256Hex("Previously available"),
                available: true,
                lastSeenAt: "2026-08-23T12:00:00.000Z",
              },
            }),
          },
          oauthStates: {},
        },
        KEY,
      ),
    ).toEqual(ok(undefined));
    const eventKeys: string[] = [];
    const recordUnavailable = (event: { idempotencyKey: string }) => {
      eventKeys.push(event.idempotencyKey);
      return ok(undefined);
    };

    const first = await reconcileProvider(
      vault,
      adapter({ discover: async () => ok([]) }),
      deps({
        recordUnavailable,
        writeIntegrationState: () => err(new Error("state disk unavailable")),
      }),
    );
    expect(first.ok).toBe(false);
    expect(
      readIntegrationState(vault, KEY).value.providers.google?.sources["doc-1"]?.available,
    ).toBe(true);

    const second = await reconcileProvider(
      vault,
      adapter({ discover: async () => ok([]) }),
      deps({ recordUnavailable }),
    );
    expect(second.ok).toBe(true);
    expect(eventKeys).toEqual(["google:doc-1:1", "google:doc-1:1"]);
    expect(
      readIntegrationState(vault, KEY).value.providers.google?.sources["doc-1"]?.available,
    ).toBe(false);
  });

  it("returns a stop function that prevents future periodic reconciliations", async () => {
    vi.useFakeTimers();
    expect(
      writeIntegrationState(
        vault,
        { providers: { google: providerState() }, oauthStates: {} },
        KEY,
      ),
    ).toEqual(ok(undefined));
    let discoveries = 0;
    const stop = startPeriodicIntegrationSync(
      vault,
      [
        adapter({
          discover: async () => {
            discoveries += 1;
            return ok([]);
          },
        }),
      ],
      deps(),
      1,
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(discoveries).toBe(1);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(discoveries).toBe(1);
    vi.useRealTimers();
  });
});
