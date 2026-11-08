// Scoped addressing on the read side (2026-11-08 spec): `scope` (exact) and
// `scope_prefix` filters on vault_index and vault_search, scope indexed by
// default with no indexed_fields config, and the vault_lint check that flags
// hand edits whose scope/key no longer match their path.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { LINT_CHECKS, runLint } from "../../src/curation/lint.js";
import { reindexVault } from "../../src/search/reindex.js";
import { readTools, vaultIndex } from "../../src/tools/read.js";
import { searchTools, vaultSearch } from "../../src/tools/search.js";
import { clearConfigCache } from "../../src/utils/config.js";

function doc(opts: { title: string; collection: string; scope?: string; key?: string }): string {
  return [
    "---",
    `title: ${opts.title}`,
    "domain: accumulation",
    `collection: ${opts.collection}`,
    "status: canonical",
    "confidence: high",
    "created: 2026-11-01",
    "updated: 2026-11-01",
    "updated_by: agent:test",
    "provenance: direct",
    ...(opts.scope ? [`scope: "${opts.scope}"`] : []),
    ...(opts.key ? [`key: ${opts.key}`] : []),
    "tags: []",
    "---",
    "",
    "Shared marker zanzibarquill for search.",
    "",
  ].join("\n");
}

const CHECKOUT = "scopes/repo/github.com/acme/checkout/postgres.md";
const WEB = "scopes/repo/github.com/acme/web/node-version.md";
const OTHER = "scopes/repo/github.com/acmesoft/api/lint.md";
const MISMATCH = "scopes/repo/github.com/acme/checkout/renamed-by-hand.md";
const SQUAT = "scopes/repo/github.com/acme/squat.md";
const PLAIN = "public/plain.md";

function names(paths: { path: string }[]): string[] {
  return paths.map((p) => p.path).sort();
}

describe("scoped queries and lint", () => {
  let vault: string;

  beforeAll(async () => {
    vault = mkdtempSync(join(tmpdir(), "daftari-scoped-query-"));
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    // No indexed_fields: scope must be filterable without config.
    writeFileSync(join(vault, ".daftari", "config.yaml"), "version: 1\n");
    const files: Record<string, string> = {
      [CHECKOUT]: doc({
        title: "Checkout Postgres",
        collection: "scopes",
        scope: "repo::github.com/acme/checkout",
        key: "postgres",
      }),
      [WEB]: doc({
        title: "Web Node",
        collection: "scopes",
        scope: "repo::github.com/acme/web",
        key: "node-version",
      }),
      [OTHER]: doc({
        title: "Acmesoft Lint",
        collection: "scopes",
        scope: "repo::github.com/acmesoft/api",
        key: "lint",
      }),
      // Hand edit: file renamed without updating key.
      [MISMATCH]: doc({
        title: "Renamed",
        collection: "scopes",
        scope: "repo::github.com/acme/checkout",
        key: "original-key",
      }),
      [SQUAT]: doc({ title: "Squat", collection: "scopes" }),
      [PLAIN]: doc({ title: "Plain", collection: "public" }),
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(vault, rel)), { recursive: true });
      writeFileSync(join(vault, rel), text);
    }
    clearConfigCache();
    const indexed = await reindexVault(vault);
    if (!indexed.ok) throw indexed.error;
  }, 60_000);

  afterAll(() => {
    clearConfigCache();
    rmSync(vault, { recursive: true, force: true });
  });

  describe("vault_index", () => {
    it("filters by exact scope", async () => {
      const r = await vaultIndex(vault, { scope: "repo::github.com/acme/checkout" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(names(r.value.entries)).toEqual([CHECKOUT, MISMATCH].sort());
      const entry = r.value.entries.find((e) => e.path === CHECKOUT);
      expect(entry?.scope).toBe("repo::github.com/acme/checkout");
      expect(entry?.key).toBe("postgres");
    });

    it("filters by scope_prefix as a plain string prefix", async () => {
      const r = await vaultIndex(vault, { scopePrefix: "repo::github.com/acme/" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // acmesoft does not match "acme/" — the trailing slash is the caller's choice.
      expect(names(r.value.entries)).toEqual([CHECKOUT, MISMATCH, WEB].sort());
    });

    it("exposes scope and scope_prefix in the tool schema and handler", async () => {
      const tool = readTools.find((t) => t.name === "vault_index");
      const props =
        (tool?.inputSchema as { properties: Record<string, unknown> } | undefined)?.properties ??
        {};
      expect(props.scope).toBeDefined();
      expect(props.scope_prefix).toBeDefined();
      const r = await tool?.handler(vault, { scope_prefix: "repo::github.com/acmesoft/" });
      expect(r?.ok).toBe(true);
      if (r?.ok) {
        expect(names((r.value as { entries: { path: string }[] }).entries)).toEqual([OTHER]);
      }
    });

    it("omits scoped docs from a role that cannot read 'scopes'", async () => {
      const access: AccessContext = {
        user: "u",
        roleName: "public-only",
        role: { read: ["public"], write: [], promote: false, ratify: false },
      };
      const r = await vaultIndex(vault, { scopePrefix: "repo::" }, access);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.entries).toEqual([]);
    });
  });

  describe("vault_search", () => {
    it("filters by exact scope without a query and without indexed_fields config", async () => {
      const r = await vaultSearch(vault, { scope: "repo::github.com/acme/web" });
      expect(r.ok, r.ok ? "" : r.error.message).toBe(true);
      if (!r.ok) return;
      expect(names(r.value.hits)).toEqual([WEB]);
    });

    it("filters by scope_prefix alongside a text query", async () => {
      const r = await vaultSearch(vault, {
        query: "zanzibarquill",
        scope_prefix: "repo::github.com/acme/",
      });
      expect(r.ok, r.ok ? "" : r.error.message).toBe(true);
      if (!r.ok) return;
      expect(names(r.value.hits)).toEqual([CHECKOUT, MISMATCH, WEB].sort());
    });

    it("ANDs scope with scope_prefix", async () => {
      const r = await vaultSearch(vault, {
        scope: "repo::github.com/acme/web",
        scope_prefix: "repo::github.com/acmesoft/",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.hits).toEqual([]);
    });

    it("treats prefix wildcard characters literally", async () => {
      const r = await vaultSearch(vault, { scope_prefix: "repo::github.com/%" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.hits).toEqual([]);
    });

    it("rejects a non-string scope or an empty scope_prefix", async () => {
      expect((await vaultSearch(vault, { scope: 5 })).ok).toBe(false);
      expect((await vaultSearch(vault, { scope_prefix: "" })).ok).toBe(false);
    });

    it("omits scoped docs from a role that cannot read 'scopes'", async () => {
      const access: AccessContext = {
        user: "u",
        roleName: "public-only",
        role: { read: ["public"], write: [], promote: false, ratify: false },
      };
      const r = await vaultSearch(vault, { scope_prefix: "repo::" }, access);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.hits).toEqual([]);
    });

    it("exposes scope and scope_prefix in the tool schema", () => {
      const tool = searchTools.find((t) => t.name === "vault_search");
      const props =
        (tool?.inputSchema as { properties: Record<string, unknown> } | undefined)?.properties ??
        {};
      expect(props.scope).toBeDefined();
      expect(props.scope_prefix).toBeDefined();
    });
  });

  describe("vault_lint scopedPathMismatch", () => {
    it("is a registered lint check", () => {
      expect(LINT_CHECKS).toContain("scopedPathMismatch");
    });

    it("flags docs whose scope/key do not derive to their path, and unscoped docs in scopes/", async () => {
      const r = await runLint(vault);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const flagged = r.value.checks.scopedPathMismatch.map((f) => f.path).sort();
      expect(flagged).toEqual([MISMATCH, SQUAT].sort());
      const detail = r.value.checks.scopedPathMismatch.find((f) => f.path === MISMATCH)?.detail;
      expect(detail).toContain("scopes/repo/github.com/acme/checkout/original-key.md");
    });
  });
});
