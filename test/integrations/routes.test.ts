import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "../../src/frontmatter/types.js";
import type { EngineDeps, ProviderAdapter } from "../../src/integrations/engine.js";
import { createIntegrationQueue } from "../../src/integrations/queue.js";
import { handleIntegrationRoute } from "../../src/integrations/routes.js";
import { writeIntegrationState } from "../../src/integrations/state.js";
import type { IntegrationConfig } from "../../src/integrations/types.js";

const KEY = Buffer.alloc(32, 4);
const config: IntegrationConfig = {
  encryptionKeyEnv: "INTEGRATION_KEY",
  pollingIntervalMinutes: 15,
  google: { clientIdEnv: "GOOGLE_ID", clientSecretEnv: "GOOGLE_SECRET" },
};
const environment = {
  INTEGRATION_KEY: KEY.toString("base64"),
  GOOGLE_ID: "client-id",
  GOOGLE_SECRET: "client-secret",
};

function adapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    name: "google",
    authorizationUrl: ({ state }) => `https://accounts.example/authorize?state=${state}`,
    exchangeCode: async () => ok({ accessToken: "access", refreshToken: "refresh" }),
    refreshTokens: async () => ok({ accessToken: "access", refreshToken: "refresh" }),
    ensureWebhook: async () => ok({ id: "channel", secret: "secret" }),
    verifyWebhook: async () =>
      ok({ kind: "event", eventId: "message-7", hint: { kind: "reconcile" } }),
    discover: async () => ok([]),
    fetch: async () => err(new Error("not used")),
    ...overrides,
  };
}

describe("integration routes", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-integration-routes-"));
    writeIntegrationState(
      vault,
      {
        providers: {
          google: { accessToken: "access", refreshToken: "refresh", sources: {} },
        },
        oauthStates: {},
      },
      KEY,
    );
  });

  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  async function start(
    providerAdapter: ProviderAdapter,
    authorize = vi.fn(async () => ({ cookieAuthenticated: false, canManageIntegrations: true })),
    csrf = vi.fn(() => null),
    wake = vi.fn(),
  ) {
    const queue = createIntegrationQueue(vault, () => new Date("2026-08-24T12:00:00.000Z"));
    const engineDeps: EngineDeps = {
      config,
      environment,
      adapters: { google: providerAdapter },
      distill: async () => ok({ runId: "run" }),
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void handleIntegrationRoute(req, res, url, {
        vaultRoot: vault,
        config,
        environment,
        adapters: { google: providerAdapter },
        engineDeps,
        queue,
        publicBaseUrl: "https://vault.example/daftari",
        authorize,
        checkCsrf: csrf,
        wake,
      }).then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing address");
    return {
      base: `http://127.0.0.1:${address.port}`,
      queue,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      wake,
    };
  }

  it("returns 202 only after a verified event is durably deduplicated", async () => {
    writeIntegrationState(
      vault,
      {
        providers: {
          google: {
            accessToken: "access",
            refreshToken: "refresh",
            sources: {},
            webhook: { id: "channel", secret: "secret" },
          },
        },
        oauthStates: {},
      },
      KEY,
    );
    const authorize = vi.fn(async () => ({
      cookieAuthenticated: false,
      canManageIntegrations: true,
    }));
    const running = await start(adapter(), authorize);
    try {
      const first = await fetch(`${running.base}/integrations/google/webhook`, {
        method: "POST",
        body: "provider payload",
      });
      const second = await fetch(`${running.base}/integrations/google/webhook`, {
        method: "POST",
        body: "provider payload",
      });
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      const pending = running.queue.pending();
      expect(pending.ok && pending.value).toHaveLength(1);
      expect(JSON.stringify(pending)).not.toContain("provider payload");
      expect(authorize).not.toHaveBeenCalled();
      expect(running.wake).toHaveBeenCalledTimes(2);
    } finally {
      await running.close();
    }
  });

  it("captures initial provider verification without enqueueing an event", async () => {
    const channel = {
      id: "notion-verification",
      secret: "manual-token",
      verificationRequired: true,
    };
    const notionAdapter = adapter({
      name: "notion",
      webhookSetup: "manual",
      verifyWebhook: async () => ok({ kind: "verification", channel }),
    });
    const notionConfig: IntegrationConfig = { ...config, google: undefined, notion: config.google };
    writeIntegrationState(
      vault,
      {
        providers: {
          notion: { accessToken: "access", refreshToken: "refresh", sources: {} },
        },
        oauthStates: {},
      },
      KEY,
    );
    const queue = createIntegrationQueue(vault);
    const engineDeps: EngineDeps = {
      config: notionConfig,
      environment,
      adapters: { notion: notionAdapter },
      distill: async () => ok({ runId: "run" }),
    };
    const server = createServer((req, res) => {
      void handleIntegrationRoute(req, res, new URL(req.url ?? "/", "http://localhost"), {
        vaultRoot: vault,
        config: notionConfig,
        environment,
        adapters: { notion: notionAdapter },
        engineDeps,
        queue,
        publicBaseUrl: "https://vault.example/daftari",
        authorize: async () => ({ cookieAuthenticated: false, canManageIntegrations: true }),
        checkCsrf: () => null,
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing address");
    try {
      const setup = await fetch(
        `http://127.0.0.1:${address.port}/integrations/notion/webhook/setup`,
        { method: "POST" },
      );
      expect(setup.status).toBe(200);
      const setupBody = (await setup.json()) as { callbackUrl: string };
      const setupToken = new URL(setupBody.callbackUrl).searchParams.get("setup_token");
      expect(setupToken).not.toBeNull();
      const response = await fetch(
        `http://127.0.0.1:${address.port}/integrations/notion/webhook?setup_token=${encodeURIComponent(setupToken ?? "")}`,
        { method: "POST", body: '{"verification_token":"manual-token"}' },
      );
      expect(response.status).toBe(200);
      expect(queue.pending()).toEqual(ok([]));

      const firstRead = await fetch(
        `http://127.0.0.1:${address.port}/integrations/notion/webhook/verification`,
        { method: "POST" },
      );
      const secondRead = await fetch(
        `http://127.0.0.1:${address.port}/integrations/notion/webhook/verification`,
        { method: "POST" },
      );
      expect(await firstRead.json()).toEqual({
        provider: "notion",
        verificationToken: "manual-token",
      });
      expect(await secondRead.json()).toEqual({
        provider: "notion",
        verificationToken: "manual-token",
      });
      const confirmed = await fetch(
        `http://127.0.0.1:${address.port}/integrations/notion/webhook/verification/confirm`,
        { method: "POST" },
      );
      expect(confirmed.status).toBe(204);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("requires authentication and cookie CSRF for authorization starts", async () => {
    const authorize = vi.fn(async () => ({
      cookieAuthenticated: true,
      canManageIntegrations: true,
    }));
    const csrf = vi.fn(() => "missing CSRF token");
    const running = await start(adapter(), authorize, csrf);
    try {
      const response = await fetch(`${running.base}/integrations/google/connect`, {
        method: "POST",
      });
      expect(response.status).toBe(403);
      expect(csrf).toHaveBeenCalledTimes(1);
    } finally {
      await running.close();
    }
  });

  it("rejects guest and read-only principals while allowing an integration operator", async () => {
    const readOnly = await start(
      adapter(),
      vi.fn(async () => ({ cookieAuthenticated: false, canManageIntegrations: false })),
    );
    try {
      const denied = await fetch(`${readOnly.base}/integrations/google/connect`, {
        method: "POST",
        redirect: "manual",
      });
      expect(denied.status).toBe(403);
    } finally {
      await readOnly.close();
    }

    const operator = await start(adapter());
    try {
      const allowed = await fetch(`${operator.base}/integrations/google/connect`, {
        method: "POST",
        redirect: "manual",
      });
      expect(allowed.status).toBe(302);
    } finally {
      await operator.close();
    }
  });

  it("does not expose manual webhook setup for an automatic provider", async () => {
    const running = await start(adapter());
    try {
      const response = await fetch(`${running.base}/integrations/google/webhook/setup`, {
        method: "POST",
      });
      expect(response.status).toBe(404);
    } finally {
      await running.close();
    }
  });
});
