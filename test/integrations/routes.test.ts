import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "../../src/frontmatter/types.js";
import type { EngineDeps, ProviderAdapter } from "../../src/integrations/engine.js";
import { createIntegrationQueue } from "../../src/integrations/queue.js";
import { integrationReviewPath } from "../../src/integrations/review.js";
import {
  handleIntegrationRoute,
  type IntegrationRouteAuthorization,
  type IntegrationRouteDependencies,
  providerFrom,
} from "../../src/integrations/routes.js";
import { readIntegrationState, writeIntegrationState } from "../../src/integrations/state.js";
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

describe("providerFrom", () => {
  it("matches the microsoft connect path", () => {
    expect(providerFrom("/integrations/microsoft/connect")).toBe("microsoft");
  });

  it("rejects an unrecognised provider path", () => {
    expect(providerFrom("/integrations/foo/connect")).toBeNull();
  });
});

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
    admitPublic = vi.fn(() => () => undefined),
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
        admitPublic,
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

  it("rejects a public webhook before reading or verifying its body when admission is full", async () => {
    const verifyWebhook = vi.fn(async () =>
      ok({ kind: "event" as const, eventId: "evt-full", hint: { kind: "reconcile" as const } }),
    );
    const admitPublic = vi.fn((_request, response) => {
      response.writeHead(503);
      response.end();
      return null;
    });
    const running = await start(
      adapter({ verifyWebhook }),
      undefined,
      undefined,
      undefined,
      admitPublic,
    );
    try {
      const response = await fetch(`${running.base}/integrations/google/webhook`, {
        method: "POST",
        body: "must-not-be-buffered",
      });
      expect(response.status).toBe(503);
      expect(admitPublic).toHaveBeenCalledTimes(1);
      expect(verifyWebhook).not.toHaveBeenCalled();
      expect(running.queue.pending()).toEqual(ok([]));
    } finally {
      await running.close();
    }
  });

  it("admits OAuth callbacks through the public gate and releases it afterward", async () => {
    const release = vi.fn();
    const admitPublic = vi.fn(() => release);
    const running = await start(adapter(), undefined, undefined, undefined, admitPublic);
    try {
      const response = await fetch(
        `${running.base}/integrations/google/callback?state=invalid&code=invalid`,
      );
      expect(response.status).toBe(400);
      expect(admitPublic).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
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
        admitPublic: () => () => undefined,
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

  it("404s the lifecycle webhook route for a provider without verifyLifecycleWebhook", async () => {
    const running = await start(adapter());
    try {
      const response = await fetch(`${running.base}/integrations/google/webhook/lifecycle`, {
        method: "POST",
        body: "{}",
      });
      expect(response.status).toBe(404);
    } finally {
      await running.close();
    }
  });
});

describe("provider-neutral webhook challenge + lifecycle routes (U5)", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-integration-routes-m365-"));
  });

  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  async function startWithAdapter(providerAdapter: ProviderAdapter) {
    const microsoftConfig: IntegrationConfig = {
      ...config,
      microsoft: {
        clientIdEnv: "MICROSOFT_ID",
        clientSecretEnv: "MICROSOFT_SECRET",
        tenantId: "tenant-id",
        scopeProfile: "sharepoint",
        collections: ["inbox"],
        includeSpeakerNotes: true,
      },
    };
    const microsoftEnvironment = {
      ...environment,
      MICROSOFT_ID: "client-id",
      MICROSOFT_SECRET: "client-secret",
    };
    const queue = createIntegrationQueue(vault, () => new Date("2026-08-24T12:00:00.000Z"));
    const engineDeps: EngineDeps = {
      config: microsoftConfig,
      environment: microsoftEnvironment,
      adapters: { microsoft: providerAdapter },
      distill: async () => ok({ runId: "run" }),
    };
    const wake = vi.fn();
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void handleIntegrationRoute(req, res, url, {
        vaultRoot: vault,
        config: microsoftConfig,
        environment: microsoftEnvironment,
        adapters: { microsoft: providerAdapter },
        engineDeps,
        queue,
        publicBaseUrl: "https://vault.example/daftari",
        authorize: async () => ({ cookieAuthenticated: false, canManageIntegrations: true }),
        admitPublic: () => () => undefined,
        checkCsrf: () => null,
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
      wake,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("answers a webhook validation challenge directly, without touching state or the queue", async () => {
    const providerAdapter = adapter({
      name: "microsoft",
      answerWebhookChallenge: (input) => input.query?.validationToken,
      verifyWebhook: async () => {
        throw new Error("must not be called for a challenge request");
      },
    });
    const running = await startWithAdapter(providerAdapter);
    try {
      const response = await fetch(
        `${running.base}/integrations/microsoft/webhook?validationToken=abc123`,
        { method: "POST", body: "" },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
      expect(await response.text()).toBe("abc123");
      expect(running.queue.pending()).toEqual(ok([]));
      expect(running.wake).not.toHaveBeenCalled();
    } finally {
      await running.close();
    }
  });

  it("404s the lifecycle webhook route for a provider without verifyLifecycleWebhook", async () => {
    const providerAdapter = adapter({ name: "microsoft" });
    const running = await startWithAdapter(providerAdapter);
    try {
      const response = await fetch(`${running.base}/integrations/microsoft/webhook/lifecycle`, {
        method: "POST",
        body: "{}",
      });
      expect(response.status).toBe(404);
    } finally {
      await running.close();
    }
  });

  it("enqueues a verified lifecycle notification through the durable queue and responds 202", async () => {
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
    const providerAdapter = adapter({
      name: "microsoft",
      verifyLifecycleWebhook: async () =>
        ok({ kind: "lifecycle", eventId: "lifecycle-1", action: "reauthorize" }),
    });
    const running = await startWithAdapter(providerAdapter);
    try {
      const response = await fetch(`${running.base}/integrations/microsoft/webhook/lifecycle`, {
        method: "POST",
        body: "{}",
      });
      expect(response.status).toBe(202);
      const pending = running.queue.pending();
      expect(pending.ok && pending.value).toHaveLength(1);
      expect(pending.ok && pending.value[0]?.eventId).toBe("lifecycle-1");
      expect(pending.ok && pending.value[0]?.hint).toEqual({
        kind: "lifecycle",
        action: "reauthorize",
      });
      expect(running.wake).toHaveBeenCalledTimes(1);
    } finally {
      await running.close();
    }
  });
});

describe("enrollment/status routes (U19)", () => {
  let vault: string;

  const KEY2 = Buffer.alloc(32, 7);
  const microsoftConfig: IntegrationConfig = {
    encryptionKeyEnv: "INTEGRATION_KEY",
    pollingIntervalMinutes: 15,
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
    INTEGRATION_KEY: KEY2.toString("base64"),
    MICROSOFT_ID: "client-id",
    MICROSOFT_SECRET: "client-secret",
  };

  function microsoftAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
    return {
      name: "microsoft",
      authorizationUrl: ({ state }) => `https://login.example/authorize?state=${state}`,
      exchangeCode: async () => ok({ accessToken: "access", refreshToken: "refresh" }),
      discover: async () => ok([]),
      fetch: async () => err(new Error("not used")),
      // Present by default so tests exercising the auth/allowlist/CSRF/ack
      // gates (not the enrollment logic itself) don't trip the 404
      // capability-missing gate before those checks ever run.
      resolveEnrollment: async () =>
        ok({
          items: [],
          collection: "distill",
          includeSpeakerNotes: true,
          readersAtEnrollment: [],
          skipped: [],
        }),
      estimateEnrollment: async () =>
        ok({
          eligible: 0,
          skipped: [],
          bytes: 0,
          byType: {},
          estimatedCalls: { low: 0, expected: 0, high: 0 },
          collection: "distill",
          readers: [],
          ratifiers: [],
          warnings: [],
        }),
      ...overrides,
    };
  }

  function authorization(
    overrides: Partial<IntegrationRouteAuthorization> = {},
  ): IntegrationRouteAuthorization {
    return {
      cookieAuthenticated: false,
      canManageIntegrations: true,
      user: "alice",
      roleName: "editor",
      role: { read: ["distill"], write: ["distill"], promote: false, ratify: true },
      ...overrides,
    };
  }

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-integration-enroll-"));
  });

  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  function writeState(
    providerState: Parameters<typeof writeIntegrationState>[1]["providers"]["microsoft"],
  ): void {
    writeIntegrationState(
      vault,
      { providers: { microsoft: providerState }, oauthStates: {} },
      KEY2,
    );
  }

  async function startRoute(options: {
    adapter: ProviderAdapter;
    authorize?: ReturnType<typeof vi.fn>;
    checkCsrf?: ReturnType<typeof vi.fn>;
    lastOutcome?: IntegrationRouteDependencies["lastOutcome"];
    wake?: ReturnType<typeof vi.fn>;
  }) {
    const queue = createIntegrationQueue(vault, () => new Date("2026-09-01T00:00:00.000Z"));
    const engineDeps: EngineDeps = {
      config: microsoftConfig,
      environment: microsoftEnvironment,
      adapters: { microsoft: options.adapter },
      now: () => new Date("2026-09-01T00:00:00.000Z"),
      distill: async () => ok({ runId: "run" }),
    };
    const authorize = options.authorize ?? vi.fn(async () => authorization());
    const checkCsrf = options.checkCsrf ?? vi.fn(() => null);
    const wake = options.wake ?? vi.fn();
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void handleIntegrationRoute(req, res, url, {
        vaultRoot: vault,
        config: microsoftConfig,
        environment: microsoftEnvironment,
        adapters: { microsoft: options.adapter },
        engineDeps,
        queue,
        publicBaseUrl: "https://vault.example/daftari",
        authorize,
        admitPublic: () => () => undefined,
        checkCsrf,
        wake,
        ...(options.lastOutcome === undefined ? {} : { lastOutcome: options.lastOutcome }),
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
      wake,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("404s the preview route for an adapter without resolveEnrollment (google)", async () => {
    const googleConfig: IntegrationConfig = { ...config, microsoft: undefined };
    const queue = createIntegrationQueue(vault);
    const providerAdapter = adapter();
    const engineDeps: EngineDeps = {
      config: googleConfig,
      environment,
      adapters: { google: providerAdapter },
      distill: async () => ok({ runId: "run" }),
    };
    const server = createServer((req, res) => {
      void handleIntegrationRoute(req, res, new URL(req.url ?? "/", "http://localhost"), {
        vaultRoot: vault,
        config: googleConfig,
        environment,
        adapters: { google: providerAdapter },
        engineDeps,
        queue,
        authorize: async () => authorization(),
        admitPublic: () => () => undefined,
        checkCsrf: () => null,
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("missing address");
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/integrations/google/enrollments/preview`,
        { method: "POST", body: "{}" },
      );
      expect(response.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a preview request without manage_integrations", async () => {
    writeState({ accessToken: "access", refreshToken: "refresh", sources: {} });
    const running = await startRoute({
      adapter: microsoftAdapter(),
      authorize: vi.fn(async () => authorization({ canManageIntegrations: false })),
    });
    try {
      const response = await fetch(`${running.base}/integrations/microsoft/enrollments/preview`, {
        method: "POST",
        body: JSON.stringify({ collection: "distill", selection: [] }),
      });
      expect(response.status).toBe(403);
    } finally {
      await running.close();
    }
  });

  it("rejects a collection outside the provider's allowlist with 422", async () => {
    writeState({ accessToken: "access", refreshToken: "refresh", sources: {} });
    const running = await startRoute({ adapter: microsoftAdapter() });
    try {
      const response = await fetch(`${running.base}/integrations/microsoft/enrollments/preview`, {
        method: "POST",
        body: JSON.stringify({ collection: "not-allowed", selection: [] }),
      });
      expect(response.status).toBe(422);
    } finally {
      await running.close();
    }
  });

  it("rejects a caller who cannot write the target collection with 403", async () => {
    writeState({ accessToken: "access", refreshToken: "refresh", sources: {} });
    const running = await startRoute({
      adapter: microsoftAdapter(),
      authorize: vi.fn(async () =>
        authorization({ role: { read: ["distill"], write: [], promote: false, ratify: false } }),
      ),
    });
    try {
      const response = await fetch(`${running.base}/integrations/microsoft/enrollments/preview`, {
        method: "POST",
        body: JSON.stringify({ collection: "distill", selection: [] }),
      });
      expect(response.status).toBe(403);
    } finally {
      await running.close();
    }
  });

  it("rejects a cookie session missing its CSRF token but allows a bearer session", async () => {
    writeState({ accessToken: "access", refreshToken: "refresh", sources: {} });
    const resolveEnrollment = vi.fn(async () =>
      ok({
        items: [],
        collection: "distill",
        includeSpeakerNotes: true,
        readersAtEnrollment: ["editor"],
        skipped: [],
      }),
    );
    const estimateEnrollment = vi.fn(async () =>
      ok({
        eligible: 0,
        skipped: [],
        bytes: 0,
        byType: {},
        estimatedCalls: { low: 0, expected: 0, high: 0 },
        collection: "distill",
        readers: ["editor"],
        ratifiers: [],
        warnings: [],
      }),
    );

    const cookieRejected = await startRoute({
      adapter: microsoftAdapter({ resolveEnrollment, estimateEnrollment }),
      authorize: vi.fn(async () => authorization({ cookieAuthenticated: true })),
      checkCsrf: vi.fn(() => "missing CSRF token"),
    });
    try {
      const response = await fetch(
        `${cookieRejected.base}/integrations/microsoft/enrollments/preview`,
        {
          method: "POST",
          body: JSON.stringify({ collection: "distill", selection: [] }),
        },
      );
      expect(response.status).toBe(403);
    } finally {
      await cookieRejected.close();
    }

    const bearerAllowed = await startRoute({
      adapter: microsoftAdapter({ resolveEnrollment, estimateEnrollment }),
    });
    try {
      const response = await fetch(
        `${bearerAllowed.base}/integrations/microsoft/enrollments/preview`,
        {
          method: "POST",
          body: JSON.stringify({ collection: "distill", selection: [] }),
        },
      );
      expect(response.status).toBe(200);
    } finally {
      await bearerAllowed.close();
    }
  });

  it("preview returns the §12 estimate shape without persisting anything", async () => {
    writeState({ accessToken: "access", refreshToken: "refresh", sources: {} });
    const estimate = {
      eligible: 1,
      skipped: [],
      bytes: 100,
      byType: { docx: 100 },
      estimatedCalls: { low: 1, expected: 1, high: 2 },
      collection: "distill",
      readers: ["editor"],
      ratifiers: ["admin"],
      warnings: [],
    };
    const resolveEnrollment = vi.fn(async () =>
      ok({
        items: [
          {
            driveId: "drive-a",
            remoteId: "item-1",
            kind: "item" as const,
            label: "a.docx",
            size: 100,
          },
        ],
        collection: "distill",
        includeSpeakerNotes: true,
        readersAtEnrollment: ["editor"],
        skipped: [],
      }),
    );
    const estimateEnrollment = vi.fn(async () => ok(estimate));
    const running = await startRoute({
      adapter: microsoftAdapter({ resolveEnrollment, estimateEnrollment }),
    });
    try {
      const response = await fetch(`${running.base}/integrations/microsoft/enrollments/preview`, {
        method: "POST",
        body: JSON.stringify({
          collection: "distill",
          selection: [{ driveId: "drive-a", itemId: "item-1" }],
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(estimate);
      const persisted = readIntegrationState(vault, KEY2);
      expect(persisted.ok && persisted.value.providers.microsoft?.enrollments).toBeUndefined();
    } finally {
      await running.close();
    }
  });

  it("refuses to enroll without the audience acknowledgement (R33)", async () => {
    writeState({ accessToken: "access", refreshToken: "refresh", sources: {} });
    const running = await startRoute({ adapter: microsoftAdapter() });
    try {
      const response = await fetch(`${running.base}/integrations/microsoft/enrollments`, {
        method: "POST",
        body: JSON.stringify({ collection: "distill", selection: [] }),
      });
      expect(response.status).toBe(422);
    } finally {
      await running.close();
    }
  });

  it("enrolls with the acknowledgement, persisting an EnrollmentRecord with enrolledBy/audienceAckAt/collection", async () => {
    writeState({ accessToken: "access", refreshToken: "refresh", sources: {} });
    const resolveEnrollment = vi.fn(async () =>
      ok({
        items: [
          {
            driveId: "drive-a",
            remoteId: "item-1",
            kind: "item" as const,
            label: "a.docx",
            size: 100,
          },
        ],
        collection: "distill",
        includeSpeakerNotes: true,
        readersAtEnrollment: ["editor"],
        skipped: [],
      }),
    );
    const running = await startRoute({ adapter: microsoftAdapter({ resolveEnrollment }) });
    try {
      const response = await fetch(`${running.base}/integrations/microsoft/enrollments`, {
        method: "POST",
        body: JSON.stringify({
          collection: "distill",
          selection: [{ driveId: "drive-a", itemId: "item-1" }],
          acknowledged: true,
        }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { enrollmentIds: string[] };
      expect(body.enrollmentIds).toHaveLength(1);
      const persisted = readIntegrationState(vault, KEY2);
      expect(persisted.ok).toBe(true);
      if (!persisted.ok) return;
      const record = persisted.value.providers.microsoft?.enrollments?.[body.enrollmentIds[0]];
      expect(record).toMatchObject({
        collection: "distill",
        includeSpeakerNotes: true,
        enrolledBy: "alice",
        enrolledAt: "2026-09-01T00:00:00.000Z",
        audienceAckAt: "2026-09-01T00:00:00.000Z",
        driveId: "drive-a",
        remoteId: "item-1",
        cursorKey: "drive:drive-a",
      });
      expect(running.wake).toHaveBeenCalledTimes(1);
    } finally {
      await running.close();
    }
  });

  it("status merges the §13 shape with the runtime's last-cycle summary", async () => {
    writeState({ accessToken: "access", refreshToken: "refresh", sources: {} });
    const status = {
      connection: { kind: "connected" as const, account: { id: "acct-1", tenantId: "tenant-id" } },
      webhook: { kind: "off" as const },
      enrollments: [],
      sources: [],
      sensitivityLabels: "not checked (V1)" as const,
    };
    const describeStatus = vi.fn(() => status);
    const running = await startRoute({
      adapter: microsoftAdapter({ describeStatus }),
      lastOutcome: () => ({
        at: "2026-09-01T00:00:00.000Z",
        outcome: {
          distilledSourceIds: ["a"],
          unchangedSourceIds: [],
          failedSourceIds: ["b"],
          unavailableSourceIds: [],
        },
      }),
    });
    try {
      const response = await fetch(`${running.base}/integrations/microsoft/status`, {
        method: "GET",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ...status,
        lastCycle: {
          at: "2026-09-01T00:00:00.000Z",
          distilled: 1,
          unchanged: 0,
          failed: 1,
          unavailable: 0,
        },
      });
    } finally {
      await running.close();
    }
  });

  it("deletes an enrollment, appends an unenrolled review event per source, and retains source metadata", async () => {
    writeState({
      accessToken: "access",
      refreshToken: "refresh",
      sources: {
        "item-1": {
          id: "item-1",
          revision: "rev-1",
          contentHash: "hash-1",
          available: true,
          lastSeenAt: "2026-08-31T00:00:00.000Z",
          enrollmentId: "enr-1",
        },
      },
      enrollments: {
        "enr-1": {
          id: "enr-1",
          kind: "item",
          driveId: "drive-a",
          remoteId: "item-1",
          label: "a.docx",
          collection: "distill",
          includeSpeakerNotes: true,
          enrolledBy: "alice",
          enrolledAt: "2026-08-31T00:00:00.000Z",
          audienceAckAt: "2026-08-31T00:00:00.000Z",
          readersAtEnrollment: ["editor"],
          cursorKey: "drive:drive-a",
        },
      },
    });
    const running = await startRoute({ adapter: microsoftAdapter() });
    try {
      const response = await fetch(`${running.base}/integrations/microsoft/enrollments/enr-1`, {
        method: "DELETE",
      });
      expect(response.status).toBe(204);

      const persisted = readIntegrationState(vault, KEY2);
      expect(persisted.ok).toBe(true);
      if (!persisted.ok) return;
      expect(persisted.value.providers.microsoft?.enrollments?.["enr-1"]).toBeUndefined();
      // R38: source metadata is retained, never deleted.
      expect(persisted.value.providers.microsoft?.sources["item-1"]).toEqual({
        id: "item-1",
        revision: "rev-1",
        contentHash: "hash-1",
        available: true,
        lastSeenAt: "2026-08-31T00:00:00.000Z",
        enrollmentId: "enr-1",
      });

      const reviewLines = readFileSync(integrationReviewPath(vault), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { providerSourceId: string; reason: string });
      expect(reviewLines).toEqual(
        [{ providerSourceId: "item-1", reason: "unenrolled" }].map((e) =>
          expect.objectContaining(e),
        ),
      );
      expect(running.wake).toHaveBeenCalledTimes(1);
    } finally {
      await running.close();
    }
  });

  it("rejects deleting an enrollment the caller cannot write, and 404s an unknown id", async () => {
    writeState({
      accessToken: "access",
      refreshToken: "refresh",
      sources: {},
      enrollments: {
        "enr-1": {
          id: "enr-1",
          kind: "item",
          driveId: "drive-a",
          remoteId: "item-1",
          label: "a.docx",
          collection: "distill",
          includeSpeakerNotes: true,
          enrolledBy: "alice",
          enrolledAt: "2026-08-31T00:00:00.000Z",
          audienceAckAt: "2026-08-31T00:00:00.000Z",
          readersAtEnrollment: ["editor"],
          cursorKey: "drive:drive-a",
        },
      },
    });
    const forbidden = await startRoute({
      adapter: microsoftAdapter(),
      authorize: vi.fn(async () =>
        authorization({ role: { read: ["distill"], write: [], promote: false, ratify: false } }),
      ),
    });
    try {
      const response = await fetch(`${forbidden.base}/integrations/microsoft/enrollments/enr-1`, {
        method: "DELETE",
      });
      expect(response.status).toBe(403);
    } finally {
      await forbidden.close();
    }

    const notFound = await startRoute({ adapter: microsoftAdapter() });
    try {
      const response = await fetch(`${notFound.base}/integrations/microsoft/enrollments/nope`, {
        method: "DELETE",
      });
      expect(response.status).toBe(404);
    } finally {
      await notFound.close();
    }
  });
});
