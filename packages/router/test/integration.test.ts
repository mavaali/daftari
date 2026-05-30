// integration.test.ts — End-to-end test against two real daftari child processes.
//
// Boots vault-a and vault-b from test/fixtures/ as real daftari subprocesses,
// then exercises the router via InMemoryTransport (no network, no extra port).

import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChildPool } from "../src/children.js";
import { startPool } from "../src/children.js";
import { wrapChildClient } from "../src/client.js";
import type { VaultConfig } from "../src/config.js";
import { parseConfig } from "../src/config.js";
import { createRouterServer } from "../src/server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Unique identifiers per test run so repeated runs always exercise the success
// path and never accumulate state in the fixture vaults.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_DRAFT_PATH = `_drafts/router-test-${RUN_ID}.md`;
const TEST_READ_PATH = `_drafts/router-read-${RUN_ID}.md`;

// The daftari binary in this worktree.
// DAFTARI_BIN env may point to the built cli.js; we always exec via `node`.
const DAFTARI_CLI = process.env.DAFTARI_BIN ?? resolve(__dirname, "../../../dist/cli.js");

// Use node as the spawner command so we don't need the executable bit on cli.js.
// The `_bin` param is ignored — we always use process.execPath + DAFTARI_CLI.
async function spawnViaNode(
  vault: VaultConfig,
  _bin: string,
): Promise<ReturnType<typeof wrapChildClient>> {
  const transport = new StdioClientTransport({
    command: process.execPath, // node binary path — no executable-bit required
    args: [DAFTARI_CLI, "--vault", vault.path, "--user", vault.user, "--role", vault.role],
  });
  const mcp = new Client({ name: "daftari-router-test", version: "0.0.0" }, { capabilities: {} });
  await withTimeout(
    mcp.connect(transport),
    20_000,
    () => mcp.close().catch(() => {}),
    `vault '${vault.name}' did not complete MCP handshake in 20s`,
  );
  return wrapChildClient(vault.name, mcp);
}

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  onTimeout: () => unknown,
  msg: string,
): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => {
      if (t) clearTimeout(t);
    }),
    new Promise<T>((_, reject) => {
      t = setTimeout(() => {
        try {
          onTimeout();
        } catch {
          /* ignore */
        }
        reject(new Error(msg));
      }, ms);
    }),
  ]);
}

describe("router integration", () => {
  let pool: ChildPool;
  let client: Client;

  beforeAll(async () => {
    const cfgPath = resolve(__dirname, "fixtures/vaults.yaml");
    const raw = readFileSync(cfgPath, "utf-8");

    // Rewrite relative vault paths to absolute so they resolve regardless
    // of where vitest is invoked from.
    const cfg = parseConfig(raw);
    for (const v of cfg.vaults) {
      if (!v.path.startsWith("/")) {
        v.path = resolve(__dirname, "fixtures", v.name);
      }
    }

    // Start the child pool using our node-based spawner.
    pool = await startPool(cfg, process.execPath, spawnViaNode);

    // Build the router using tools from the first child.
    const first = pool.all()[0];
    const { tools } = await first.listTools();
    const { mcp } = createRouterServer(pool, tools as never);

    // Wire router ↔ test client via InMemoryTransport.
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientSide);

    // Daftari runs its index build in the background after `initialize` returns.
    // On a fresh checkout (no persisted .daftari/index.db) the search test would
    // race the background indexer. Calling vault_reindex synchronously here
    // blocks until both indexes are fully built and queryable — deterministic
    // across local re-runs AND fresh CI runs.
    await client.callTool({ name: "vault_reindex", arguments: {} });
  }, 90_000);

  afterAll(async () => {
    if (client) await client.close().catch(() => {});
    if (pool) await pool.close().catch(() => {});
    // Best-effort cleanup of per-run test artifacts.
    for (const p of [
      resolve(__dirname, "fixtures/vault-a", TEST_DRAFT_PATH),
      resolve(__dirname, "fixtures/vault-a", TEST_READ_PATH),
    ]) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it("lists the daftari tool catalog", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["vault_read", "vault_search", "vault_write"]));
    // Daftari ships at least 13 tools; router wraps them all.
    expect(tools.length).toBeGreaterThanOrEqual(13);
  });

  it("vault_search fan-out returns hits with vault prefix in paths", async () => {
    const r = await client.callTool({
      name: "vault_search",
      arguments: { query: "aurora" },
    });
    const text = (r.content?.[0] as { text: string }).text;
    const payload = JSON.parse(text);
    expect(payload.count).toBeGreaterThan(0);
    // Every hit must carry a vault-prefixed path like "vault-a:..." or "vault-b:..."
    for (const hit of payload.hits) {
      expect(hit.path).toMatch(/^vault-[ab]:/);
    }
    // Both vaults should contribute hits since "aurora" appears in both.
    const vaultNames = new Set(
      (payload.hits as { path: string }[]).map((h) => h.path.split(":")[0]),
    );
    expect(vaultNames.has("vault-a")).toBe(true);
    expect(vaultNames.has("vault-b")).toBe(true);
  });

  it("vault_write without a vault is an error", async () => {
    const r = await client.callTool({
      name: "vault_write",
      arguments: {
        path: "_drafts/router-test.md",
        agent: "test-agent",
        body: "Hello router",
        frontmatter: {
          title: "Router Test",
          collection: "_drafts",
          domain: "accumulation",
          status: "draft",
          confidence: "low",
          provenance: "direct",
          created: "2026-05-30",
          tags: [],
        },
      },
    });
    expect(r.isError).toBe(true);
    expect((r.content?.[0] as { text: string }).text).toMatch(/requires a vault/i);
  });

  it("vault_write with explicit vault succeeds", async () => {
    const r = await client.callTool({
      name: "vault_write",
      arguments: {
        vault: "vault-a",
        path: TEST_DRAFT_PATH,
        frontmatter: {
          title: "Router Test",
          domain: "accumulation",
          collection: "_drafts",
          status: "draft",
          confidence: "low",
          provenance: "direct",
          created: "2026-05-30",
          tags: [],
        },
        body: "# Hi",
        agent: "test-agent",
      },
    });
    expect(r.isError).toBeFalsy();
  });

  it("vault_read uses a vault-prefixed path", async () => {
    // Write a unique file for this run, then read it back.
    const writeResult = await client.callTool({
      name: "vault_write",
      arguments: {
        vault: "vault-a",
        path: TEST_READ_PATH,
        frontmatter: {
          title: "Router Read Test",
          domain: "accumulation",
          collection: "_drafts",
          status: "draft",
          confidence: "low",
          provenance: "direct",
          created: "2026-05-30",
          tags: [],
        },
        body: "Hello router read test",
        agent: "test-agent",
      },
    });
    expect(writeResult.isError).toBeFalsy();

    const r = await client.callTool({
      name: "vault_read",
      arguments: { path: `vault-a:${TEST_READ_PATH}` },
    });
    expect(r.isError).toBeFalsy();
    const text = (r.content?.[0] as { text: string }).text;
    const payload = JSON.parse(text);
    // vault_read returns { content: string (body), frontmatter: {...} }
    expect(payload.frontmatter.title).toBe("Router Read Test");
  });
});
