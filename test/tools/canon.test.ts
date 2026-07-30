// Integration test for vault_canon MCP tool.
//
// Uses the same writeDoc pattern as test/tools/receipt.test.ts: full-featured
// frontmatter so loadDocuments picks up every file cleanly. The tension is
// added via addTension so the ego-graph traversal and contested detection run
// exactly as they would in production.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTension } from "../../src/curation/tension.js";
import { canonTools } from "../../src/tools/canon.js";

const tool = canonTools.find((t) => t.name === "vault_canon");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const TODAY = new Date().toISOString().slice(0, 10);

function writeDoc(vault: string, relPath: string, overrides: Record<string, string | null> = {}) {
  const fm: Record<string, string | null> = {
    title: `Doc ${relPath}`,
    domain: "accumulation",
    collection: relPath.split("/")[0] ?? "",
    status: "canonical",
    confidence: "medium",
    created: TODAY,
    updated: TODAY,
    updated_by: "human:alice",
    provenance: "direct",
    superseded_by: null,
    ttl_days: "120",
    valid_from: null,
    valid_until: null,
    ...overrides,
  };
  const lines = Object.entries(fm).map(([k, v]) => {
    if (v === null) return `${k}: null`;
    return k === "ttl_days" ? `${k}: ${v}` : `${k}: "${v}"`;
  });
  const body = `---\n${lines.join("\n")}\nsources: []\ntags: []\n---\n\nBody of ${relPath}.\n`;
  mkdirSync(join(vault, relPath.split("/")[0] ?? ""), { recursive: true });
  writeFileSync(join(vault, relPath), body, "utf-8");
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("vault_canon tool", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-canon-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("is registered as a read-only tool named vault_canon", () => {
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.inputSchema).toMatchObject({ required: ["seed"] });
  });

  it("reports contested when two holders' valid docs are tensioned", async () => {
    // alice's doc has the more-recent valid_from (2026-06-01)
    writeDoc(vault, "x/a.md", {
      updated_by: "human:alice",
      updated: "2026-06-01",
      valid_from: "2026-06-01",
    });
    // bob's doc has an earlier valid_from (2026-01-01)
    writeDoc(vault, "x/b.md", {
      updated_by: "human:bob",
      updated: "2026-01-01",
      valid_from: "2026-01-01",
    });

    const logged = await addTension(vault, {
      title: "t",
      kind: "factual",
      sourceA: "x/a.md",
      claimA: "P",
      sourceB: "x/b.md",
      claimB: "not P",
      loggedBy: "test",
    });
    expect(logged.ok).toBe(true);

    const res = await tool?.handler(vault, { seed: "x/a.md", as_of: "2026-07-01" });
    expect(res.ok).toBe(true);
    const v = res.ok ? res.value : null;
    expect(v).not.toBeNull();
    expect((v as { contested: unknown[] }).contested).toHaveLength(1);
    expect((v as { flags: { graph_completeness: string } }).flags.graph_completeness).toBe(
      "curated",
    );
  });

  it("returns ok with empty contested when no tensions exist", async () => {
    writeDoc(vault, "x/a.md", { updated_by: "human:alice" });

    const res = await tool?.handler(vault, { seed: "x/a.md" });
    expect(res.ok).toBe(true);
    const v = res.ok ? res.value : null;
    expect((v as { contested: unknown[] }).contested).toHaveLength(0);
  });

  it("summarize produces a compact one-line string", () => {
    expect(tool?.summarize).toBeDefined();
    const value = {
      settled: [{ holder: "human:alice", citations: ["x/a.md"] }],
      contested: [],
      flags: {
        graph_completeness: "curated",
        partial_visibility: false,
        hidden_tension_count: 0,
        unindexed: false,
        unindexed_paths: [],
      },
      receipt: null,
    };
    const summary = tool?.summarize?.(value);
    expect(summary).toContain("1");
    expect(summary).toContain("0");
  });

  it("summarize flags partial visibility", () => {
    expect(tool?.summarize).toBeDefined();
    const value = {
      settled: [],
      contested: [{ trajectory: [], hint_ordering: "by_valid_from" }],
      flags: {
        graph_completeness: "curated",
        partial_visibility: true,
        hidden_tension_count: 1,
        unindexed: false,
        unindexed_paths: [],
      },
      receipt: null,
    };
    const summary = tool?.summarize?.(value);
    expect(summary).toContain("partial visibility");
  });
});
