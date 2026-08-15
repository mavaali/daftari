// The operator-only auth audit log: append-only JSONL under .daftari/,
// mirroring read-log.ts — best-effort, timestamp stamped at append, never
// exposed through any MCP surface.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAuthEvent, authLogPath, tokenHint } from "../../src/serve/auth-log.js";
import { VAULT_GITIGNORE } from "../../src/utils/vault-gitignore.js";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-authlog-"));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("auth log", () => {
  it("appends records with a stamped timestamp and only the declared fields", async () => {
    const r1 = await appendAuthEvent(vault, {
      outcome: "allow",
      principal: "human:alice",
      remote: "127.0.0.1",
      method: "POST",
      path: "/mcp",
    });
    expect(r1.ok).toBe(true);
    const r2 = await appendAuthEvent(vault, {
      outcome: "deny-401",
      token_hint: tokenHint("some-presented-bearer"),
      remote: "203.0.113.9",
      method: "POST",
      path: "/mcp",
    });
    expect(r2.ok).toBe(true);

    const lines = readFileSync(authLogPath(vault), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "{}");
    expect(first.outcome).toBe("allow");
    expect(first.principal).toBe("human:alice");
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const second = JSON.parse(lines[1] ?? "{}");
    expect(second.outcome).toBe("deny-401");
    expect(second.principal).toBeUndefined();
  });

  it("token_hint is 8 hex of a SALTED hash — never a substring of the bearer", async () => {
    const bearer = "super-secret-token-value";
    const hint = tokenHint(bearer);
    expect(hint).toMatch(/^[0-9a-f]{8}$/);
    expect(bearer).not.toContain(hint);
    // Stable within one server run: the same bad token correlates.
    expect(tokenHint(bearer)).toBe(hint);
    expect(tokenHint("other-token")).not.toBe(hint);
    // Salted per process: a leaked log must not allow OFFLINE confirmation
    // of token guesses via plain sha256(candidate).
    const { createHash } = await import("node:crypto");
    expect(hint).not.toBe(createHash("sha256").update(bearer).digest("hex").slice(0, 8));
  });

  it("the gitignore block covers auth-log.jsonl", () => {
    expect(VAULT_GITIGNORE).toContain(".daftari/auth-log.jsonl");
  });

  it("no MCP tool surface imports the auth log (operator-only guard)", () => {
    // The Tension Court precedent: operator surfaces take no access context.
    // A tool reading this log would create a per-principal activity
    // disclosure surface the 2026-07-14 spec never designed.
    const toolsDir = join(__dirname, "..", "..", "src", "tools");
    for (const f of readdirSync(toolsDir)) {
      const src = readFileSync(join(toolsDir, f), "utf-8");
      expect(src.includes("auth-log"), `${f} must not import serve/auth-log`).toBe(false);
    }
    const resources = join(__dirname, "..", "..", "src", "resources.ts");
    if (existsSync(resources)) {
      expect(readFileSync(resources, "utf-8").includes("auth-log")).toBe(false);
    }
  });
});
