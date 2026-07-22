// `daftari serve` (#5): startup gating, token auth, and per-session RBAC
// vantage over Streamable HTTP. The server runs IN-PROCESS on an ephemeral
// loopback port and is driven by the SDK's own client transport — no spawn,
// no network flake surface (spec 2026-07-20, test posture).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  matchToken,
  type ServeHandle,
  startHttpServer,
  validateServeStartup,
} from "../../src/serve/index.js";
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
  const client = new Client({ name: "serve-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function searchPaths(client: Client, query: string): Promise<string[]> {
  const res = (await client.callTool({
    name: "vault_search",
    arguments: { query, limit: 10, weights: { bm25: 1, vector: 0 } },
  })) as { content: { type: string; text: string }[] };
  const text = res.content[0]?.text ?? "{}";
  const parsed = JSON.parse(text) as { hits?: { path: string }[] };
  return (parsed.hits ?? []).map((h) => h.path);
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

  it("two sessions with different tokens see different RBAC vantages", async () => {
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

  it("rejects a missing or unmatched token at session open (401)", async () => {
    await expect(connect(handle.port)).rejects.toThrow(/unauthorized/);
    await expect(connect(handle.port, "wrong-secret")).rejects.toThrow(/unauthorized/);
  });

  it("a session id is not a credential — mismatched identity is 401", async () => {
    // Open a session as the analyst via raw fetch so the session id header
    // is observable, then replay it with the admin's token.
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
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await init.body?.cancel();

    const hijack = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer admin-secret",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId as string,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(hijack.status).toBe(401);
  });

  it("non-/mcp paths are 404", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/other`, { method: "POST" });
    expect(res.status).toBe(404);
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

  it("sessions open without a token and run as the deny-all guest", async () => {
    const guest = await connect(handle.port);
    try {
      const paths = await searchPaths(guest, "zephyr protocol calibration");
      expect(paths).toEqual([]);
    } finally {
      await guest.close();
    }
  }, 30_000);
});
