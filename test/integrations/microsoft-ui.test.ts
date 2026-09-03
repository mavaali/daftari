// Task U20 (Requirement R9): the Microsoft picker `/ui` page — auth + CSP +
// no-inline-script HTML, the vendored-asset route (serving + path-traversal
// rejection), and the payload-serializer's no-token property. No live
// Microsoft/File-Picker calls here (§17) — the real popup round-trip is a
// manual smoke (probe 5), out of scope for this suite.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "../../src/frontmatter/types.js";
import type { EngineDeps, ProviderAdapter } from "../../src/integrations/engine.js";
import { serializePickerSelection } from "../../src/integrations/microsoft/assets/picker-serializer.js";
import { createIntegrationQueue } from "../../src/integrations/queue.js";
import {
  handleIntegrationRoute,
  type IntegrationRouteAuthorization,
} from "../../src/integrations/routes.js";
import type { IntegrationConfig } from "../../src/integrations/types.js";
import { microsoftProviderConfig } from "./microsoft-fixtures.js";

const config: IntegrationConfig = {
  encryptionKeyEnv: "INTEGRATION_KEY",
  pollingIntervalMinutes: 15,
  microsoft: microsoftProviderConfig({
    collections: ["distill", "research"],
    tenantId: "contoso-tenant",
    pickerHost: "https://contoso.sharepoint.com",
  }),
};

const environment = {
  INTEGRATION_KEY: Buffer.alloc(32, 4).toString("base64"),
  MICROSOFT_CLIENT_ID: "test-client-id",
  MICROSOFT_CLIENT_SECRET: "test-client-secret",
};

function microsoftAdapter(): ProviderAdapter {
  return {
    name: "microsoft",
    authorizationUrl: ({ state }) => `https://login.microsoftonline.com/authorize?state=${state}`,
    exchangeCode: async () => ok({ accessToken: "access", refreshToken: "refresh" }),
    discover: async () => ok([]),
    fetch: async () => err(new Error("not used")),
  };
}

async function start(
  authorize = vi.fn(
    async (): Promise<IntegrationRouteAuthorization> => ({
      cookieAuthenticated: false,
      canManageIntegrations: true,
      user: "alice",
      role: null,
      roleName: "admin",
    }),
  ),
  csrf = vi.fn(() => null),
) {
  const queue = createIntegrationQueue("/tmp/daftari-ui-test-vault", () => new Date());
  const engineDeps: EngineDeps = {
    config,
    environment,
    adapters: { microsoft: microsoftAdapter() },
    distill: async () => ok({ runId: "run" }),
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleIntegrationRoute(req, res, url, {
      vaultRoot: "/tmp/daftari-ui-test-vault",
      config,
      environment,
      adapters: { microsoft: microsoftAdapter() },
      engineDeps,
      queue,
      authorize,
      admitPublic: vi.fn(() => () => undefined),
      checkCsrf: csrf,
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("GET /integrations/microsoft/ui", () => {
  it("returns 200 HTML with the exact §5.1 CSP header when authorized", async () => {
    const harness = await start();
    try {
      const res = await fetch(`${harness.base}/integrations/microsoft/ui`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("content-security-policy")).toBe(
        "default-src 'self'; script-src 'self'; " +
          "connect-src 'self' https://login.microsoftonline.com https://*.sharepoint.com; " +
          "form-action 'self' https://*.sharepoint.com; " +
          "frame-src https://login.microsoftonline.com",
      );
      const body = await res.text();
      expect(body).toContain("<!doctype html>");
    } finally {
      await harness.close();
    }
  });

  it("returns 403 when the caller lacks manage_integrations", async () => {
    const authorize = vi.fn(
      async (): Promise<IntegrationRouteAuthorization> => ({
        cookieAuthenticated: false,
        canManageIntegrations: false,
        user: "bob",
        role: null,
        roleName: "member",
      }),
    );
    const harness = await start(authorize);
    try {
      const res = await fetch(`${harness.base}/integrations/microsoft/ui`);
      expect(res.status).toBe(403);
    } finally {
      await harness.close();
    }
  });

  it("returns 401 when authorize itself rejects (e.g. unauthenticated)", async () => {
    // Mirrors the real contract (serve/index.ts's `authorize`): a null return
    // means the callback already wrote the rejection response itself — the
    // route must not write a second response on top of it.
    const authorize = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return null;
    });
    const harness = await start(authorize as never);
    try {
      const res = await fetch(`${harness.base}/integrations/microsoft/ui`);
      expect(res.status).toBe(401);
    } finally {
      await harness.close();
    }
  });

  it("has no inline <script> with executable code — only an external module reference", async () => {
    const harness = await start();
    try {
      const res = await fetch(`${harness.base}/integrations/microsoft/ui`);
      const body = await res.text();
      // Any <script> tag present must carry a src= (external) and no text
      // content between its tags.
      const scriptTags = [...body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
      expect(scriptTags.length).toBeGreaterThan(0);
      for (const match of scriptTags) {
        const [full, inner] = match;
        expect(full).toMatch(/\ssrc=/);
        expect(inner.trim()).toBe("");
      }
      expect(body).toContain('src="/integrations/microsoft/ui/assets/glue.js"');
    } finally {
      await harness.close();
    }
  });

  it("lists the config's collections in the dropdown and disables Enroll by default", async () => {
    const harness = await start();
    try {
      const res = await fetch(`${harness.base}/integrations/microsoft/ui`);
      const body = await res.text();
      expect(body).toContain('value="distill"');
      expect(body).toContain('value="research"');
      expect(body).toMatch(/<select id="collection-select">/);
      // Enroll is disabled markup by default; the ack-checkbox gating hook
      // (#audience-ack) exists for the client glue to wire up.
      expect(body).toMatch(/<button[^>]*id="enroll-button"[^>]*disabled[^>]*>/);
      expect(body).toContain('id="audience-ack"');
    } finally {
      await harness.close();
    }
  });

  it("404s for a provider with no microsoft config (e.g. google)", async () => {
    const harness = await start();
    try {
      const res = await fetch(`${harness.base}/integrations/google/ui`);
      expect(res.status).toBe(404);
    } finally {
      await harness.close();
    }
  });
});

describe("GET /integrations/microsoft/ui/assets/{file}", () => {
  it("serves the vendored msal-browser entry as JS", async () => {
    const harness = await start();
    try {
      const res = await fetch(
        `${harness.base}/integrations/microsoft/ui/assets/vendor/msal-browser/index.mjs`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/javascript");
      const body = await res.text();
      expect(body).toContain("PublicClientApplication");
    } finally {
      await harness.close();
    }
  });

  it("serves the glue script and the picker-serializer as JS", async () => {
    const harness = await start();
    try {
      const glue = await fetch(`${harness.base}/integrations/microsoft/ui/assets/glue.js`);
      expect(glue.status).toBe(200);
      expect(glue.headers.get("content-type")).toContain("text/javascript");

      const serializer = await fetch(
        `${harness.base}/integrations/microsoft/ui/assets/picker-serializer.js`,
      );
      expect(serializer.status).toBe(200);
      expect(serializer.headers.get("content-type")).toContain("text/javascript");
    } finally {
      await harness.close();
    }
  });

  it("rejects a literal .. path-traversal attempt", async () => {
    const harness = await start();
    try {
      const res = await fetch(
        `${harness.base}/integrations/microsoft/ui/assets/../../../../../../etc/passwd`,
        { redirect: "manual" },
      );
      // Node's http URL parsing itself normalizes/collapses ".." within the
      // pathname before our handler ever sees it, so this can legitimately
      // resolve to a totally different (404) route rather than reaching our
      // asset handler at all — either way, 200 must never happen and the
      // response must never be /etc/passwd's contents.
      expect(res.status).not.toBe(200);
    } finally {
      await harness.close();
    }
  });

  it("rejects an encoded .. path-traversal attempt via the asset handler directly", async () => {
    const harness = await start();
    try {
      // %2e%2e survives Node's URL normalization (only a literal ".." segment
      // gets collapsed), so this exercises resolveMicrosoftUiAssetPath's own
      // traversal check end-to-end.
      const res = await fetch(
        `${harness.base}/integrations/microsoft/ui/assets/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd`,
      );
      expect(res.status).toBe(404);
    } finally {
      await harness.close();
    }
  });

  it("rejects an absolute-path asset request", async () => {
    const harness = await start();
    try {
      const res = await fetch(`${harness.base}/integrations/microsoft/ui/assets/%2Fetc%2Fpasswd`);
      expect(res.status).toBe(404);
    } finally {
      await harness.close();
    }
  });

  it("404s for an unknown extension", async () => {
    const harness = await start();
    try {
      const res = await fetch(
        `${harness.base}/integrations/microsoft/ui/assets/vendor/msal-browser/package.json`,
      );
      expect(res.status).toBe(404);
    } finally {
      await harness.close();
    }
  });
});

describe("serializePickerSelection (the no-token property)", () => {
  it("strips an accessToken field from an item and returns only item refs", () => {
    const pickResult = {
      command: "pick",
      items: [
        {
          id: "item-1",
          driveId: "drive-1",
          name: "Q3 plan.docx",
          accessToken: "eyJ0eXAiOiJKV1QiLCJhbGciOi...SECRET",
          sharepointIds: { listId: "list-1", listItemId: "5", siteId: "site-1", webId: "web-1" },
        },
      ],
    };
    const result = serializePickerSelection(pickResult);
    expect(result).toEqual({
      items: [
        {
          driveId: "drive-1",
          itemId: "item-1",
          name: "Q3 plan.docx",
          sharepointIds: { listId: "list-1", listItemId: "5", siteId: "site-1", webId: "web-1" },
        },
      ],
    });
    // The no-token property, asserted directly against the serialized JSON:
    // no field anywhere in the output contains the token string or a "token"
    // key.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET");
    expect(serialized.toLowerCase()).not.toContain("token");
  });

  it("strips a nested authentication/token field carried alongside the pick result", () => {
    const pickResult = {
      command: "pick",
      authentication: { token: "top-level-secret-token" },
      items: [{ id: "item-2", driveId: "drive-2" }],
    };
    const result = serializePickerSelection(pickResult);
    expect(result).toEqual({ items: [{ driveId: "drive-2", itemId: "item-2" }] });
    expect(JSON.stringify(result)).not.toContain("top-level-secret-token");
  });

  it("drops an item missing driveId/itemId rather than guessing", () => {
    const pickResult = { items: [{ name: "no ids", accessToken: "x" }] };
    expect(serializePickerSelection(pickResult)).toEqual({ items: [] });
  });

  it("tolerates a malformed/empty pick result", () => {
    expect(serializePickerSelection(null)).toEqual({ items: [] });
    expect(serializePickerSelection(undefined)).toEqual({ items: [] });
    expect(serializePickerSelection({})).toEqual({ items: [] });
  });

  it("reads items from a nested value.items shape (an alternate SDK result envelope)", () => {
    const pickResult = { value: { items: [{ id: "i1", driveId: "d1", accessToken: "sekret" }] } };
    const result = serializePickerSelection(pickResult);
    expect(result).toEqual({ items: [{ driveId: "d1", itemId: "i1" }] });
    expect(JSON.stringify(result)).not.toContain("sekret");
  });
});
