import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "../../src/frontmatter/types.js";
import {
  type DistillationInput,
  type EngineDeps,
  type ProviderAdapter,
  reconcileProvider,
  startPeriodicIntegrationSync,
} from "../../src/integrations/engine.js";
import {
  integrationStatePath,
  readIntegrationState,
  writeIntegrationState,
} from "../../src/integrations/state.js";
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
    expect(readFileSync(integrationStatePath(vault), "utf8")).not.toContain(text);
    expect(readIntegrationState(vault, KEY).value.providers.google?.sources["doc-1"]).toMatchObject(
      {
        revision: "2",
        contentHash: sha256Hex(text),
        lastDistillRunId: "run-2",
      },
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
