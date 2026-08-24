// `daftari serve` (#5): startup gating, token auth, and per-request RBAC
// vantage over the stateless 2026-07-28 revision (spec 2026-07-26,
// Decision 1). The server runs IN-PROCESS on an ephemeral loopback port and
// is driven by the SDK's own client transport — no spawn, no network flake
// surface (spec 2026-07-20, test posture).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ok } from "../../src/frontmatter/types.js";
import type { IntegrationRuntime } from "../../src/integrations/runtime.js";
import {
  matchToken,
  prepareStorageSync,
  runServe,
  type ServeHandle,
  startHttpServer,
  startPeriodicSync,
  validateServeStartup,
} from "../../src/serve/index.js";
import type { StorageBackend } from "../../src/storage/backend.js";
import { vaultReindex } from "../../src/tools/search.js";
import { type DaftariConfig, loadConfig } from "../../src/utils/config.js";

const HEAVY = "zephyr protocol calibration zephyr protocol calibration zephyr protocol calibration";
const LIGHT = "zephyr overview note";

// A vault with a restricted collection ranked on top (the RBAC leak vector)
// plus a config declaring two roles and two token entries.
function buildVault(withTokens: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "daftari-serve-"));
  mkdirSync(join(dir, "notes"), { recursive: true });
  const notes = [
    { name: "s1.md", collection: "secret", tags: ["t1"], body: HEAVY },
    { name: "s2.md", collection: "secret", tags: ["t2"], body: HEAVY },
    { name: "p1.md", collection: "public", tags: ["t3"], body: LIGHT },
    { name: "p2.md", collection: "public", tags: ["t4"], body: LIGHT },
  ];
  for (const n of notes) {
    writeFileSync(
      join(dir, "notes", n.name),
      `---\ntitle: ${n.name}\ncollection: ${n.collection}\ndomain: accumulation\nstatus: canonical\nconfidence: high\ncreated: 2026-03-01\nupdated: 2026-03-01\ntags: [${n.tags.join(", ")}]\n---\n\n${n.body}\n`,
    );
  }
  mkdirSync(join(dir, ".daftari"), { recursive: true });
  const tokensBlock = withTokens
    ? `server:
  auth:
    tokens:
      - env: DAFTARI_TEST_TOKEN_ANALYST
        user: human:analyst
        role: analyst
      - env: DAFTARI_TEST_TOKEN_ADMIN
        user: human:admin
        role: admin
`
    : "";
  writeFileSync(
    join(dir, ".daftari", "config.yaml"),
    `version: 1
roles:
  analyst:
    read: [public]
    write: []
  admin:
    read: ["*"]
    write: ["*"]
${tokensBlock}`,
  );
  return dir;
}

function loadedConfig(vault: string): DaftariConfig {
  const c = loadConfig(vault);
  if (!c.ok) throw c.error;
  return c.value;
}

async function connect(port: number, token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  // The client SDK still defaults to legacy negotiation; serve is
  // 2026-07-28-only (Decision 1), so pin the modern revision.
  const client = new Client(
    { name: "serve-test", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(transport);
  return client;
}

// A genuine 2025-era client: mode "legacy" speaks only the initialize
// handshake wire, never the 2026-07-28 envelope.
async function connectLegacy(port: number, token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  const client = new Client(
    { name: "serve-test-legacy", version: "0.0.0" },
    { versionNegotiation: { mode: "legacy" } },
  );
  await client.connect(transport);
  return client;
}

// The typed result rides `structuredContent` (spec 2026-07-26, Decision 3);
// `content` carries the compact model-facing summary, not JSON.
async function searchPaths(client: Client, query: string): Promise<string[]> {
  const res = (await client.callTool({
    name: "vault_search",
    arguments: { query, limit: 10, weights: { bm25: 1, vector: 0 } },
  })) as { structuredContent?: { hits?: { path: string }[] } };
  return (res.structuredContent?.hits ?? []).map((h) => h.path);
}

describe("validateServeStartup (pure gating)", () => {
  let vault: string;
  beforeAll(() => {
    vault = buildVault(true);
    process.env.DAFTARI_TEST_TOKEN_ANALYST = "analyst-secret";
    process.env.DAFTARI_TEST_TOKEN_ADMIN = "admin-secret";
  });
  afterAll(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("refuses a non-loopback bind with no auth configured", () => {
    const bare = buildVault(false);
    try {
      const r = validateServeStartup(loadedConfig(bare), "0.0.0.0", process.env);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toContain("no authentication configured");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("refuses a non-loopback bind without the transport_security declaration", () => {
    const r = validateServeStartup(loadedConfig(vault), "0.0.0.0", process.env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("transport_security");
  });

  it("refuses a set-but-unusable DAFTARI_ATTEST_KEY (#298)", () => {
    const r = validateServeStartup(loadedConfig(vault), "127.0.0.1", {
      ...process.env,
      DAFTARI_ATTEST_KEY: "/nonexistent/attest.key",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("DAFTARI_ATTEST_KEY");
  });

  it("refuses when a token env var is unset or a role is undeclared", () => {
    const cfg = loadedConfig(vault);
    const r = validateServeStartup(cfg, "127.0.0.1", { DAFTARI_TEST_TOKEN_ADMIN: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("DAFTARI_TEST_TOKEN_ANALYST");

    const badRole = {
      ...cfg,
      server: { tokens: [{ env: "DAFTARI_TEST_TOKEN_ADMIN", user: "x", role: "nope" }] },
    };
    const r2 = validateServeStartup(badRole, "127.0.0.1", process.env);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error).toContain("role 'nope'");
  });

  it("resolves tokens on a loopback bind with auth configured", () => {
    const r = validateServeStartup(loadedConfig(vault), "127.0.0.1", process.env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens).toHaveLength(2);
  });
});

describe("matchToken", () => {
  const tokens = [
    { secret: Buffer.from("alpha-secret"), user: "a", roleName: "r" },
    { secret: Buffer.from("beta"), user: "b", roleName: "r" },
  ];
  it("matches the right entry and rejects near-misses and length mismatches", () => {
    expect(matchToken("alpha-secret", tokens)?.user).toBe("a");
    expect(matchToken("beta", tokens)?.user).toBe("b");
    expect(matchToken("alpha-secreT", tokens)).toBeNull();
    expect(matchToken("alpha", tokens)).toBeNull();
    expect(matchToken("", tokens)).toBeNull();
  });
});

describe("serve over Streamable HTTP (in-process, loopback)", () => {
  let vault: string;
  let handle: ServeHandle;

  beforeAll(async () => {
    vault = buildVault(true);
    process.env.DAFTARI_TEST_TOKEN_ANALYST = "analyst-secret";
    process.env.DAFTARI_TEST_TOKEN_ADMIN = "admin-secret";
    const reindexed = await vaultReindex(vault);
    if (!reindexed.ok) throw reindexed.error;
    const cfg = loadedConfig(vault);
    const gate = validateServeStartup(cfg, "127.0.0.1", process.env);
    if (!gate.ok) throw new Error(gate.error);
    handle = await startHttpServer(vault, cfg, gate.tokens, "127.0.0.1", 0);
  }, 60_000);

  afterAll(async () => {
    await handle.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it("two clients with different tokens see different RBAC vantages", async () => {
    const analyst = await connect(handle.port, "analyst-secret");
    const admin = await connect(handle.port, "admin-secret");
    try {
      const analystPaths = await searchPaths(analyst, "zephyr protocol calibration");
      expect(analystPaths.length).toBeGreaterThan(0);
      expect(analystPaths.every((p) => p.startsWith("notes/p"))).toBe(true);

      const adminPaths = await searchPaths(admin, "zephyr protocol calibration");
      expect(adminPaths.some((p) => p.startsWith("notes/s"))).toBe(true);
    } finally {
      await analyst.close();
      await admin.close();
    }
  }, 30_000);

  it("rejects a missing or unmatched token on every request (401)", async () => {
    await expect(connect(handle.port)).rejects.toThrow(/unauthorized|HTTP 401/i);
    await expect(connect(handle.port, "wrong-secret")).rejects.toThrow(/unauthorized|HTTP 401/i);
  });

  it("speaks 2026-07-28 only — a 2025-era initialize is refused, and no session id is ever issued", async () => {
    // Decision 1: no dual-stacking. A legacy `initialize` (the session-open
    // ceremony the 2026-07-28 revision deleted) gets the
    // unsupported-protocol-version rejection, not a session. Lagging clients
    // use stdio, which serves both eras.
    const init = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer analyst-secret",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "raw", version: "0" },
        },
      }),
    });
    expect(init.headers.get("mcp-session-id")).toBeNull();
    const body = await init.text();
    expect(body).toMatch(/protocol/i);
    expect(body).not.toMatch(/"result"\s*:\s*\{[^}]*serverInfo/);
  });

  it("non-/mcp paths are 404", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/other`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  // DNS-rebinding guard (MCP Streamable HTTP security guidance): a rebinded
  // page reaches 127.0.0.1 with the attacker's Host/Origin — both must be
  // rejected before routing, auth, or any body is served.
  it("rejects a non-loopback Host header on a loopback bind (403)", async () => {
    // fetch forbids overriding Host, so drive a raw http request — which is
    // exactly what a rebinded connection delivers.
    const status = await new Promise<number>((resolveStatus, rejectStatus) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: handle.port,
          path: "/mcp",
          method: "POST",
          headers: {
            host: "evil.example:80",
            authorization: "Bearer admin-secret",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
        },
        (res) => {
          res.resume();
          resolveStatus(res.statusCode ?? 0);
        },
      );
      req.on("error", rejectStatus);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    });
    expect(status).toBe(403);
  });

  it("rejects a present non-loopback Origin (403) but allows a loopback one", async () => {
    const evil = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: {
        origin: "http://evil.example",
        authorization: "Bearer admin-secret",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(evil.status).toBe(403);

    // A loopback Origin for the bound port passes the guard (the bare
    // legacy-shaped request is then refused further in by the protocol
    // router, which is the point — it got past the rebinding gate).
    const okOrigin = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: {
        origin: `http://127.0.0.1:${handle.port}`,
        authorization: "Bearer admin-secret",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(okOrigin.status).not.toBe(403);
  });
});

describe("serve with no auth declared (loopback guest mode)", () => {
  let vault: string;
  let handle: ServeHandle;

  beforeAll(async () => {
    vault = buildVault(false);
    const reindexed = await vaultReindex(vault);
    if (!reindexed.ok) throw reindexed.error;
    const cfg = loadedConfig(vault);
    const gate = validateServeStartup(cfg, "127.0.0.1", process.env);
    if (!gate.ok) throw new Error(gate.error);
    handle = await startHttpServer(vault, cfg, gate.tokens, "127.0.0.1", 0);
  }, 60_000);

  afterAll(async () => {
    await handle.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it("requests without a token run as the deny-all guest", async () => {
    const guest = await connect(handle.port);
    try {
      const paths = await searchPaths(guest, "zephyr protocol calibration");
      expect(paths).toEqual([]);
    } finally {
      await guest.close();
    }
  }, 30_000);
});

describe("prepareStorageSync gates periodic sync before the listener (#6)", () => {
  it("no configured cadence is ok(null); an uncreatable backend refuses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daftari-serve-sync-"));
    try {
      mkdirSync(join(dir, ".daftari"), { recursive: true });
      writeFileSync(
        join(dir, ".daftari", "config.yaml"),
        "version: 1\nstorage:\n  backend: s3\n  bucket: b\n",
      );
      const noCadence = loadConfig(dir);
      if (!noCadence.ok) throw noCadence.error;
      const idle = await prepareStorageSync(noCadence.value);
      expect(idle.ok).toBe(true);
      if (idle.ok) expect(idle.value).toBeNull();

      writeFileSync(
        join(dir, ".daftari", "config.yaml"),
        "version: 1\nstorage:\n  backend: s3\n  bucket: b\n  sync_interval_minutes: 5\n",
      );
      const withCadence = loadConfig(dir);
      if (!withCadence.ok) throw withCadence.error;
      // The optional SDK is never installed in the test environment, so the
      // gate must refuse — this is the branch that must fire BEFORE the
      // server binds, not after.
      const refused = await prepareStorageSync(withCadence.value);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.message).toContain("npm install @aws-sdk/client-s3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("startPeriodicSync drives the interval push (#6)", () => {
  it("ticks call the sync fn, overlapping ticks are skipped, failures never throw", async () => {
    vi.useFakeTimers();
    try {
      const calls: number[] = [];
      let release: (() => void) | undefined;
      const backend = { id: "fs:test" } as StorageBackend;

      // First tick blocks until released; later ticks resolve immediately.
      const syncFn = vi.fn(async () => {
        calls.push(calls.length);
        if (calls.length === 1) {
          await new Promise<void>((r) => {
            release = r;
          });
        }
        return { ok: true as const, value: {} as never };
      });

      const stop = startPeriodicSync("/vault", backend, 1, syncFn as never);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(syncFn).toHaveBeenCalledTimes(1);

      // Two more intervals pass while the first push is still running — the
      // overlap guard must skip both.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(syncFn).toHaveBeenCalledTimes(1);

      release?.();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(syncFn).toHaveBeenCalledTimes(2);

      // A failing push logs and keeps the loop alive.
      syncFn.mockImplementationOnce(async () => ({
        ok: false as const,
        error: new Error("backing offline"),
      }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(syncFn).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(syncFn).toHaveBeenCalledTimes(4);

      stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(syncFn).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --legacy-http (#366): an opt-in escape hatch amending the Decision 1
// strict-reject posture — the SDK's stateless legacy fallback answers
// 2025-era traffic from the same factory, same process, no session table.
describe("legacy HTTP compatibility (--legacy-http, #366)", () => {
  let vault: string;
  let cfg: DaftariConfig;
  let tokens: Parameters<typeof startHttpServer>[2];
  let handle: ServeHandle;

  beforeAll(async () => {
    vault = buildVault(true);
    process.env.DAFTARI_TEST_TOKEN_ANALYST = "analyst-secret";
    process.env.DAFTARI_TEST_TOKEN_ADMIN = "admin-secret";
    const reindexed = await vaultReindex(vault);
    if (!reindexed.ok) throw reindexed.error;
    cfg = loadedConfig(vault);
    const gate = validateServeStartup(cfg, "127.0.0.1", process.env);
    if (!gate.ok) throw new Error(gate.error);
    tokens = gate.tokens;
    handle = await startHttpServer(vault, cfg, tokens, "127.0.0.1", 0, { legacyHttp: true });
  }, 60_000);

  afterAll(async () => {
    await handle.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it("a 2025-era client can initialize, list tools, and search under its RBAC vantage", async () => {
    const legacy = await connectLegacy(handle.port, "analyst-secret");
    try {
      const tools = await legacy.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("vault_search");
      const paths = await searchPaths(legacy, "zephyr protocol calibration");
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.every((p) => p.startsWith("notes/p"))).toBe(true);
    } finally {
      await legacy.close();
    }
  }, 30_000);

  it("mixed traffic: a modern client works on the same legacy-enabled server, per-client RBAC intact", async () => {
    const modern = await connect(handle.port, "admin-secret");
    const legacy = await connectLegacy(handle.port, "analyst-secret");
    try {
      const [adminPaths, analystPaths] = await Promise.all([
        searchPaths(modern, "zephyr protocol calibration"),
        searchPaths(legacy, "zephyr protocol calibration"),
      ]);
      expect(adminPaths.some((p) => p.startsWith("notes/s"))).toBe(true);
      expect(analystPaths.every((p) => p.startsWith("notes/p"))).toBe(true);
    } finally {
      await modern.close();
      await legacy.close();
    }
  }, 30_000);

  it("the legacy path enforces auth: missing or wrong bearer is 401, never guest", async () => {
    await expect(connectLegacy(handle.port)).rejects.toThrow(/unauthorized|401/i);
    await expect(connectLegacy(handle.port, "wrong-secret")).rejects.toThrow(/unauthorized|401/i);
  });

  it("the same 2025-era client is refused when the flag is off", async () => {
    const strict = await startHttpServer(vault, cfg, tokens, "127.0.0.1", 0);
    try {
      await expect(connectLegacy(strict.port, "analyst-secret")).rejects.toThrow(
        /-32022|unsupported protocol/i,
      );
    } finally {
      await strict.close();
    }
  }, 30_000);

  // The SDK's stateless fallback owns these semantics (its default posture,
  // upstream-controlled) — pin them locally so an SDK upgrade that quietly
  // grows a session map fails here, not in production (#366 acceptance
  // criteria; the repo invariant that Mcp-Session-Id is never a credential).
  it("legacy session operations stay 405 and no session id is ever issued", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method,
        headers: {
          authorization: "Bearer analyst-secret",
          accept: "application/json, text/event-stream",
          "mcp-session-id": "forged-session-id",
        },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get("mcp-session-id")).toBeNull();
      await res.text();
    }
  });

  it("a spoofed Mcp-Session-Id never alters identity — the bearer decides the vantage", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      {
        requestInit: {
          headers: {
            Authorization: "Bearer analyst-secret",
            "mcp-session-id": "forged-session-id",
          },
        },
      },
    );
    const legacy = new Client(
      { name: "serve-test-legacy-spoof", version: "0.0.0" },
      { versionNegotiation: { mode: "legacy" } },
    );
    await legacy.connect(transport);
    try {
      const paths = await searchPaths(legacy, "zephyr protocol calibration");
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.every((p) => p.startsWith("notes/p"))).toBe(true);
    } finally {
      await legacy.close();
    }
  }, 30_000);
});

describe("serve integration runtime wiring", () => {
  it("starts, routes, and closes an injected provider-neutral runtime", async () => {
    const vault = buildVault(false);
    const cfg = loadedConfig(vault);
    const started: string[] = [];
    let closed = false;
    const runtime: IntegrationRuntime = {
      start: async (localBaseUrl) => {
        started.push(localBaseUrl);
        return ok(undefined);
      },
      handle: async (_request, response, url) => {
        if (url.pathname !== "/integrations/test") return false;
        response.writeHead(204);
        response.end();
        return true;
      },
      runOnce: async () => undefined,
      close: async () => {
        closed = true;
      },
    };
    const handle = await startHttpServer(vault, cfg, [], "127.0.0.1", 0, {
      integrationRuntime: runtime,
    });
    try {
      expect(started).toEqual([`http://127.0.0.1:${handle.port}`]);
      const response = await fetch(`http://127.0.0.1:${handle.port}/integrations/test`);
      expect(response.status).toBe(204);
    } finally {
      await handle.close();
      rmSync(vault, { recursive: true, force: true });
    }
    expect(closed).toBe(true);
  });
});

describe("runServe --help", () => {
  it("documents --legacy-http", async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      chunks.push(String(s));
      return true;
    });
    try {
      const code = await runServe(["--help"]);
      expect(code).toBe(0);
      expect(chunks.join("")).toContain("--legacy-http");
    } finally {
      spy.mockRestore();
    }
  });
});
