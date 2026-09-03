import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "../../src/frontmatter/types.js";
import type { ProviderAdapter } from "../../src/integrations/engine.js";
import { createIntegrationQueue, integrationQueuePath } from "../../src/integrations/queue.js";
import { createConfiguredIntegrationRuntime } from "../../src/integrations/runtime.js";
import { writeIntegrationState } from "../../src/integrations/state.js";
import type { IntegrationConfig } from "../../src/integrations/types.js";

const KEY = Buffer.alloc(32, 9);
const config: IntegrationConfig = {
  encryptionKeyEnv: "INTEGRATION_KEY",
  pollingIntervalMinutes: 10,
  google: { clientIdEnv: "GOOGLE_ID", clientSecretEnv: "GOOGLE_SECRET" },
};
const environment = {
  INTEGRATION_KEY: KEY.toString("base64"),
  GOOGLE_ID: "id",
  GOOGLE_SECRET: "secret",
};
const distill = async () => ok({ runId: "test-run" });

describe("configured integration runtime", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-integration-runtime-"));
    writeIntegrationState(
      vault,
      {
        providers: { google: { accessToken: "access", refreshToken: "refresh", sources: {} } },
        oauthStates: {},
      },
      KEY,
    );
  });

  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  function factory(spy: { redirect?: string; discover: number; ensure: number }) {
    return (redirectUri: string): ProviderAdapter => {
      spy.redirect = redirectUri;
      return {
        name: "google",
        authorizationUrl: () => "https://accounts.example/authorize",
        exchangeCode: async () => ok({ accessToken: "access", refreshToken: "refresh" }),
        refreshTokens: async () => ok({ accessToken: "access", refreshToken: "refresh" }),
        ensureWebhook: async () => {
          spy.ensure += 1;
          return ok({ id: "channel", secret: "secret" });
        },
        verifyWebhook: async () =>
          ok({ kind: "event", eventId: "evt", hint: { kind: "reconcile" } }),
        discover: async (state) => {
          spy.discover += 1;
          state.cursor = "cursor";
          return ok([]);
        },
        fetch: async () => err(new Error("not used")),
      };
    };
  }

  it("uses a loopback OAuth callback and polling without pretending webhooks work", async () => {
    const spy = { discover: 0, ensure: 0 };
    const created = createConfiguredIntegrationRuntime({
      vaultRoot: vault,
      config,
      environment,
      distill,
      adapterFactories: { google: factory(spy) },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await created.value.start("http://127.0.0.1:8787")).toEqual(ok(undefined));
    await created.value.runOnce();
    expect(spy.redirect).toBe("http://127.0.0.1:8787/integrations/google/callback");
    expect(spy.discover).toBeGreaterThan(0);
    expect(spy.ensure).toBe(0);
    await created.value.close();
  });

  it("uses the public base URL and maintains webhook channels after reconciliation", async () => {
    const spy = { discover: 0, ensure: 0 };
    const created = createConfiguredIntegrationRuntime({
      vaultRoot: vault,
      config,
      environment,
      distill,
      publicBaseUrl: "https://vault.example/daftari",
      adapterFactories: { google: factory(spy) },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await created.value.start("http://127.0.0.1:8787")).toEqual(ok(undefined));
    await created.value.runOnce();
    expect(spy.redirect).toBe("https://vault.example/daftari/integrations/google/callback");
    expect(spy.ensure).toBeGreaterThan(0);
    await created.value.close();
  });

  it("routes the public base path prefix to provider-neutral integration routes", async () => {
    const spy = { discover: 0, ensure: 0 };
    const created = createConfiguredIntegrationRuntime({
      vaultRoot: vault,
      config,
      environment,
      distill,
      publicBaseUrl: "https://vault.example/daftari",
      adapterFactories: { google: factory(spy) },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await created.value.start("http://127.0.0.1:8787")).toEqual(ok(undefined));
    const server = createServer((request, response) => {
      void created.value
        .handle(request, response, new URL(request.url ?? "/", "http://localhost"), {
          admitPublic: () => () => undefined,
          authorize: async () => ({
            cookieAuthenticated: false,
            canManageIntegrations: true,
          }),
          checkCsrf: () => null,
        })
        .then((handled) => {
          if (!handled) {
            response.statusCode = 404;
            response.end();
          }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing address");
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/daftari/integrations/google/connect`,
        { method: "POST", redirect: "manual" },
      );
      expect(response.status).toBe(302);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await created.value.close();
    }
  });

  it("fails before constructing an adapter when a named secret is missing", async () => {
    const factorySpy = vi.fn(factory({ discover: 0, ensure: 0 }));
    const created = createConfiguredIntegrationRuntime({
      vaultRoot: vault,
      config,
      environment: { ...environment, GOOGLE_SECRET: undefined },
      distill,
      adapterFactories: { google: factorySpy },
    });
    expect(created.ok).toBe(false);
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("surfaces safe lifecycle failures without provider response data", async () => {
    const messages: string[] = [];
    const created = createConfiguredIntegrationRuntime({
      vaultRoot: vault,
      config,
      environment,
      distill,
      adapterFactories: {
        google: () => ({
          ...factory({ discover: 0, ensure: 0 })("http://localhost/callback"),
          discover: async () => err(new Error("provider body with secret")),
        }),
      },
      onError: (message) => messages.push(message),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await created.value.start("http://127.0.0.1:8787")).toEqual(ok(undefined));
    await created.value.runOnce();
    expect(messages).toContain("integration google reconcile failed");
    expect(messages.join(" ")).not.toContain("provider body with secret");
    await created.value.close();
  });

  it("runs one immediate follow-up when woken after the active queue drain", async () => {
    let discoveries = 0;
    let release: (() => void) | undefined;
    const created = createConfiguredIntegrationRuntime({
      vaultRoot: vault,
      config,
      environment,
      distill,
      adapterFactories: {
        google: (redirectUri) => ({
          ...factory({ discover: 0, ensure: 0 })(redirectUri),
          discover: async () => {
            discoveries += 1;
            if (discoveries === 1) {
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            }
            return ok([]);
          },
        }),
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await created.value.start("http://127.0.0.1:8787")).toEqual(ok(undefined));
    while (discoveries === 0) await Promise.resolve();
    const followUp = created.value.runOnce();
    release?.();
    await followUp;
    expect(discoveries).toBe(2);
    await created.value.close();
  });

  it("passes a coalesced source hint into reconciliation", async () => {
    const queue = createIntegrationQueue(vault);
    expect(
      queue.enqueue({
        provider: "google",
        eventId: "source-event",
        hint: { kind: "sources", sourceIds: ["doc-hinted"], rediscover: false },
      }),
    ).toEqual(ok({ enqueued: true }));
    const discover = vi.fn(async () => ok([]));
    const fetch = vi.fn(async () => ok({ id: "doc-hinted", revision: "2", text: "changed text" }));
    const created = createConfiguredIntegrationRuntime({
      vaultRoot: vault,
      config,
      environment,
      distill,
      adapterFactories: {
        google: (redirectUri) => ({
          ...factory({ discover: 0, ensure: 0 })(redirectUri),
          discover,
          fetch,
        }),
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await created.value.start("http://127.0.0.1:8787")).toEqual(ok(undefined));
    await vi.waitFor(() => expect(createIntegrationQueue(vault).pending()).toEqual(ok([])));

    expect(discover).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      { id: "doc-hinted", revision: "targeted-refresh" },
      expect.any(Object),
    );
    await created.value.close();
  });

  it("closes before waiting, ignores reruns, and delegates a bounded shutdown wait", async () => {
    let release: (() => void) | undefined;
    let discoveries = 0;
    const waits: number[] = [];
    const created = createConfiguredIntegrationRuntime({
      vaultRoot: vault,
      config,
      environment,
      distill,
      shutdownTimeoutMilliseconds: 17,
      waitForShutdown: async () => {
        waits.push(17);
      },
      adapterFactories: {
        google: (redirectUri) => ({
          ...factory({ discover: 0, ensure: 0 })(redirectUri),
          discover: async () => {
            discoveries += 1;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return ok([]);
          },
        }),
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await created.value.start("http://127.0.0.1:8787")).toEqual(ok(undefined));
    await vi.waitFor(() => expect(discoveries).toBe(1));

    await created.value.close();
    await created.value.runOnce();

    expect(waits).toEqual([17]);
    expect(discoveries).toBe(1);
    release?.();
  });

  it("preflights distill configuration before constructing adapters", () => {
    const factorySpy = vi.fn(factory({ discover: 0, ensure: 0 }));
    const created = createConfiguredIntegrationRuntime({
      vaultRoot: vault,
      config,
      environment,
      adapterFactories: { google: factorySpy },
    });

    expect(created.ok).toBe(false);
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("tombstones partial-source events without starving later work and reports safely", async () => {
    const messages: string[] = [];
    const queue = createIntegrationQueue(vault);
    expect(
      queue.enqueue({ provider: "google", eventId: "evt-failed", hint: { kind: "reconcile" } }),
    ).toEqual(ok({ enqueued: true }));
    expect(
      queue.enqueue({ provider: "google", eventId: "evt-later", hint: { kind: "reconcile" } }),
    ).toEqual(ok({ enqueued: true }));
    const created = createConfiguredIntegrationRuntime({
      vaultRoot: vault,
      config,
      environment,
      distill,
      adapterFactories: {
        google: (redirectUri) => ({
          ...factory({ discover: 0, ensure: 0 })(redirectUri),
          discover: async () => ok([{ id: "doc-failed", revision: "1" }]),
          fetch: async () => err(new Error("provider response with secret")),
        }),
      },
      onError: (message) => messages.push(message),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await created.value.start("http://127.0.0.1:8787")).toEqual(ok(undefined));
    await created.value.runOnce();

    expect(queue.pending()).toEqual(ok([]));
    expect(messages).toContain("integration google reconcile incomplete (1 source)");
    expect(messages).not.toContain("integration queue drain failed");
    expect(messages.join(" ")).not.toContain("provider response with secret");
    await created.value.close();
  });

  it("coalesces ten thousand queued events into one provider reconcile", async () => {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(
      integrationQueuePath(vault),
      JSON.stringify({
        version: 2,
        pending: Array.from({ length: 10_000 }, (_, index) => ({
          provider: "google",
          eventId: `evt-${index}`,
          hint: { kind: "reconcile" },
          enqueuedAt: "2026-08-25T12:00:00.000Z",
          attempts: 0,
        })),
        processedEvents: [],
      }),
    );
    let discoveries = 0;
    const created = createConfiguredIntegrationRuntime({
      vaultRoot: vault,
      config,
      environment,
      distill,
      adapterFactories: {
        google: (redirectUri) => ({
          ...factory({ discover: 0, ensure: 0 })(redirectUri),
          discover: async () => {
            discoveries += 1;
            return ok([]);
          },
        }),
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await created.value.start("http://127.0.0.1:8787")).toEqual(ok(undefined));
    await vi.waitFor(() => expect(createIntegrationQueue(vault).pending()).toEqual(ok([])));
    await created.value.close();

    expect(discoveries).toBeLessThanOrEqual(2);
    const raw = readFileSync(integrationQueuePath(vault), "utf8");
    const durable = JSON.parse(raw) as { processedEvents: unknown[] };
    expect(durable.processedEvents).toHaveLength(10_000);
    expect(raw.length).toBeLessThan(1_500_000);
  });

  it("retains the last reconcile outcome for a provider after a cycle (R36)", async () => {
    const spy = { discover: 0, ensure: 0 };
    const created = createConfiguredIntegrationRuntime({
      vaultRoot: vault,
      config,
      environment,
      distill,
      adapterFactories: { google: factory(spy) },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.lastOutcome("google")).toBeUndefined();
    expect(await created.value.start("http://127.0.0.1:8787")).toEqual(ok(undefined));
    await created.value.runOnce();
    const retained = created.value.lastOutcome("google");
    expect(retained).toBeDefined();
    expect(retained?.outcome).toEqual({
      distilledSourceIds: [],
      unchangedSourceIds: [],
      failedSourceIds: [],
      unavailableSourceIds: [],
    });
    expect(typeof retained?.at).toBe("string");
    await created.value.close();
  });

  it("does not retain an outcome for a provider whose reconcile failed", async () => {
    const created = createConfiguredIntegrationRuntime({
      vaultRoot: vault,
      config,
      environment,
      distill,
      adapterFactories: {
        google: () => ({
          ...factory({ discover: 0, ensure: 0 })("http://localhost/callback"),
          discover: async () => err(new Error("boom")),
        }),
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await created.value.start("http://127.0.0.1:8787")).toEqual(ok(undefined));
    await created.value.runOnce();
    expect(created.value.lastOutcome("google")).toBeUndefined();
    await created.value.close();
  });

  it("wires RBAC roles + distill.estimated_usd_per_call into the DEFAULT Microsoft adapter factory (U19)", async () => {
    const microsoftConfig: IntegrationConfig = {
      encryptionKeyEnv: "INTEGRATION_KEY",
      pollingIntervalMinutes: 10,
      microsoft: {
        clientIdEnv: "MICROSOFT_ID",
        clientSecretEnv: "MICROSOFT_SECRET",
        tenantId: "tenant-id",
        scopeProfile: "sharepoint",
        collections: ["distill"],
        includeSpeakerNotes: true,
      },
    };
    const microsoftEnvironment = {
      ...environment,
      MICROSOFT_ID: "client-id",
      MICROSOFT_SECRET: "client-secret",
    };
    writeIntegrationState(
      vault,
      {
        providers: {
          microsoft: { accessToken: "access", refreshToken: "refresh", sources: {} },
        },
        oauthStates: {},
      },
      KEY,
    );
    const roles = {
      editor: { read: ["distill"], write: ["distill"], promote: false, ratify: false },
      admin: { read: ["distill"], write: ["distill"], promote: true, ratify: true },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://graph.microsoft.com/v1.0/drives/drive-a/items/item-1")) {
        return new Response(
          JSON.stringify({ id: "item-1", name: "a.docx", file: {}, eTag: "e1", size: 1_000 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      // No adapterFactories override for microsoft — this exercises
      // defaultFactories()'s own createMicrosoftAdapter call, proving
      // roles/estimatedUsdPerCall reach production adapter construction.
      const created = createConfiguredIntegrationRuntime({
        vaultRoot: vault,
        config: microsoftConfig,
        environment: microsoftEnvironment,
        distill,
        roles,
        estimatedUsdPerCall: 0.02,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(await created.value.start("http://127.0.0.1:8787")).toEqual(ok(undefined));

      const server = createServer((request, response) => {
        void created.value
          .handle(request, response, new URL(request.url ?? "/", "http://localhost"), {
            admitPublic: () => () => undefined,
            authorize: async () => ({
              cookieAuthenticated: false,
              canManageIntegrations: true,
              user: "alice",
              roleName: "editor",
              role: roles.editor,
            }),
            checkCsrf: () => null,
          })
          .then((handled) => {
            if (!handled) {
              response.statusCode = 404;
              response.end();
            }
          });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (typeof address !== "object" || address === null) throw new Error("missing address");
      try {
        const response = await originalFetch(
          `http://127.0.0.1:${address.port}/integrations/microsoft/enrollments/preview`,
          {
            method: "POST",
            body: JSON.stringify({
              collection: "distill",
              selection: [{ driveId: "drive-a", itemId: "item-1" }],
            }),
          },
        );
        expect(response.status).toBe(200);
        const estimate = (await response.json()) as {
          readers: string[];
          ratifiers: string[];
          estimatedUsd?: { expected: number };
        };
        expect(estimate.readers).toEqual(["admin", "editor"]);
        expect(estimate.ratifiers).toEqual(["admin"]);
        expect(estimate.estimatedUsd?.expected).toBeGreaterThan(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await created.value.close();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
