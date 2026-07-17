// server.e2e.test.ts — End-to-end test of the built daftari MCP server.
//
// Everything else in test/ exercises modules in-process. This suite is the
// one place the *shipped artifact* is exercised: it spawns `dist/cli.js` as a
// real subprocess, speaks JSON-RPC over stdio through the MCP SDK client, and
// drives the full loop a real agent would — handshake, tool catalog, read,
// write (with the git auto-commit), reindex, search, and RBAC enforcement.
//
// Requires a build: run `npm run build` first (CI runs build before test).
// The regression suite guards ranking quality; this suite guards "the server
// a user installs actually boots and serves".

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI = resolve("dist/cli.js");
const FIXTURE = resolve("test/fixtures/sample-vault");

// Unique per run so repeated local runs never collide on paths.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DRAFT_PATH = `_drafts/e2e-${RUN_ID}.md`;

// Copy the sample vault into a throwaway dir, keeping .daftari/config.yaml
// (the RBAC config is what the e2e is partly about) but dropping ephemeral
// state (index.db, process.lock) and the fixture's own .git. Each server
// gets its own copy: the per-vault process lock SIGTERMs any other daftari
// holding the same vault, so two servers must never share one.
function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "daftari-e2e-"));
  cpSync(FIXTURE, dir, {
    recursive: true,
    filter: (src) => {
      const name = basename(src);
      if (src.includes(`${sep}.git${sep}`) || name === ".git") return false;
      return name !== "index.db" && name !== "process.lock";
    },
  });
  // Writes auto-commit; give the vault a real repo and a committer identity
  // (CI runners have no global git config).
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  git("init", "-q");
  git("config", "user.name", "daftari-e2e");
  git("config", "user.email", "e2e@daftari.local");
  git("add", "-A");
  git("commit", "-qm", "e2e: initial vault state");
  return dir;
}

function spawnServer(vault: string, user: string, role?: string): Promise<Client> {
  const args = [CLI, "--vault", vault, "--user", user];
  if (role) args.push("--role", role);
  const transport = new StdioClientTransport({ command: process.execPath, args });
  const client = new Client({ name: "daftari-e2e", version: "0.0.0" }, { capabilities: {} });
  return client.connect(transport).then(() => client);
}

function textOf(r: Awaited<ReturnType<Client["callTool"]>>): string {
  return (r.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
}

// Poll vault_search until the freshly-spawned server's background reindex is
// past the "still indexing" window. Mirrors the router integration test.
async function waitForIndex(client: Client, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await client.callTool({
      name: "vault_search",
      arguments: { query: "readiness-probe" },
    });
    if (!(r.isError && /still indexing/i.test(textOf(r)))) return;
    if (Date.now() > deadline) throw new Error(`index not ready in ${timeoutMs}ms`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

describe("daftari server e2e (built artifact over stdio)", () => {
  let adminVault: string;
  let guestVault: string;
  let admin: Client;
  let guest: Client;

  beforeAll(async () => {
    if (!existsSync(CLI)) {
      throw new Error("dist/cli.js not found — run `npm run build` before the e2e suite");
    }
    adminVault = makeVault();
    guestVault = makeVault();
    [admin, guest] = await Promise.all([
      spawnServer(adminVault, "e2e-admin", "admin"),
      spawnServer(guestVault, "e2e-guest"), // no role: deny-all guest
    ]);
    await waitForIndex(admin, 60_000);
  }, 90_000);

  afterAll(async () => {
    await Promise.all([admin?.close(), guest?.close()].map((p) => p?.catch(() => {})));
    for (const dir of [adminVault, guestVault]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves the full tool catalog over the MCP handshake", async () => {
    const { tools } = await admin.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["vault_read", "vault_search", "vault_write", "vault_status"]),
    );
    expect(tools.length).toBeGreaterThanOrEqual(13);
    // Every tool must ship a description and an input schema — this is the
    // contract an MCP client's model sees.
    for (const t of tools) {
      expect(t.description, `tool ${t.name} has no description`).toBeTruthy();
      expect(t.inputSchema, `tool ${t.name} has no inputSchema`).toBeTruthy();
    }
  });

  it("vault_status answers against the fixture vault", async () => {
    const r = await admin.callTool({ name: "vault_status", arguments: {} });
    expect(r.isError).toBeFalsy();
  });

  it("vault_read returns a fixture document with frontmatter", async () => {
    const r = await admin.callTool({
      name: "vault_read",
      arguments: { path: "pricing/helios-consumption-pricing.md" },
    });
    expect(r.isError).toBeFalsy();
    const payload = JSON.parse(textOf(r));
    expect(payload.frontmatter?.title).toBeTruthy();
  });

  it("vault_search finds fixture content", async () => {
    const r = await admin.callTool({
      name: "vault_search",
      arguments: { query: "helios pricing" },
    });
    expect(r.isError).toBeFalsy();
    const payload = JSON.parse(textOf(r));
    expect(payload.count).toBeGreaterThan(0);
  });

  it("vault_write persists, auto-commits, and reads back", async () => {
    const before = execFileSync("git", ["-C", adminVault, "rev-list", "--count", "HEAD"])
      .toString()
      .trim();

    const w = await admin.callTool({
      name: "vault_write",
      arguments: {
        path: DRAFT_PATH,
        agent: "agent:e2e",
        body: "End-to-end write through the built server.",
        frontmatter: {
          title: "E2E Write",
          domain: "accumulation",
          collection: "_drafts",
          status: "draft",
          confidence: "low",
          provenance: "direct",
          created: "2026-07-17",
          tags: [],
        },
      },
    });
    expect(w.isError).toBeFalsy();

    const r = await admin.callTool({ name: "vault_read", arguments: { path: DRAFT_PATH } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(textOf(r)).frontmatter.title).toBe("E2E Write");

    // Git is the version layer: the write must have produced a commit.
    const after = execFileSync("git", ["-C", adminVault, "rev-list", "--count", "HEAD"])
      .toString()
      .trim();
    expect(Number(after)).toBeGreaterThan(Number(before));
  });

  it("deny-all guest cannot read or write", async () => {
    const read = await guest.callTool({
      name: "vault_read",
      arguments: { path: "pricing/helios-consumption-pricing.md" },
    });
    expect(read.isError).toBe(true);

    const write = await guest.callTool({
      name: "vault_write",
      arguments: {
        path: `_drafts/e2e-guest-${RUN_ID}.md`,
        agent: "agent:e2e",
        body: "should be denied",
        frontmatter: {
          title: "Denied",
          domain: "accumulation",
          collection: "_drafts",
          status: "draft",
          confidence: "low",
          provenance: "direct",
          created: "2026-07-17",
          tags: [],
        },
      },
    });
    expect(write.isError).toBe(true);
  });
});
