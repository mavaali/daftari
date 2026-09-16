import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { reindexVault } from "../../src/search/reindex.js";
import { searchTools, vaultSearch } from "../../src/tools/search.js";
import { clearConfigCache } from "../../src/utils/config.js";

function document(title: string, collection: string, updated: string, priority?: number): string {
  return [
    "---",
    `title: ${title}`,
    "domain: accumulation",
    `collection: ${collection}`,
    "status: canonical",
    "confidence: high",
    "created: 2026-09-01",
    `updated: ${updated}`,
    "updated_by: agent:test",
    "provenance: direct",
    "tags: []",
    ...(priority === undefined ? [] : [`priority: ${priority}`]),
    "---",
    "",
    "Common needle for tool-level filtering.",
    "",
  ].join("\n");
}

describe("vault_search field filters", () => {
  let vault: string;

  beforeAll(async () => {
    vault = mkdtempSync(join(tmpdir(), "daftari-tool-filters-"));
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    mkdirSync(join(vault, "public"));
    mkdirSync(join(vault, "secret"));
    writeFileSync(
      join(vault, ".daftari", "config.yaml"),
      "schema_extensions:\n  priority:\n    type: number\nindexed_fields: [priority]\n",
    );
    writeFileSync(join(vault, "public", "a.md"), document("A", "public", "2026-09-03", 3));
    writeFileSync(join(vault, "public", "b.md"), document("B", "public", "2026-09-02", 2));
    writeFileSync(join(vault, "public", "missing.md"), document("Missing", "public", "2026-09-05"));
    writeFileSync(join(vault, "secret", "s.md"), document("Secret", "secret", "2026-09-04", 5));
    clearConfigCache();
    const indexed = await reindexVault(vault);
    if (!indexed.ok) throw indexed.error;
  }, 60_000);

  afterAll(() => {
    clearConfigCache();
    rmSync(vault, { recursive: true, force: true });
  });

  it("supports filter-only retrieval with deterministic ordering and zero scores", async () => {
    const result = await vaultSearch(vault, {
      filters: [{ field: "priority", op: "gte", value: 2 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.query).toBe("");
    expect(result.value.vectorUsed).toBe(false);
    expect(result.value.weights).toEqual({ bm25: 1, vector: 0 });
    expect(result.value.hits.map((hit) => hit.path)).toEqual([
      "secret/s.md",
      "public/a.md",
      "public/b.md",
    ]);
    expect(
      result.value.hits.every(
        (hit) => hit.score === 0 && hit.bm25Score === 0 && hit.vectorScore === 0,
      ),
    ).toBe(true);
  });

  it("ANDs filters with free-text retrieval and omits missing fields", async () => {
    const result = await vaultSearch(vault, {
      query: "common needle",
      filters: [
        { field: "priority", op: "gte", value: 2 },
        { field: "priority", op: "lt", value: 5 },
      ],
      weights: { bm25: 1, vector: 0 },
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.hits.map((hit) => hit.path).sort()).toEqual([
        "public/a.md",
        "public/b.md",
      ]);
  });

  it("pushes readable collections before the filter-only limit", async () => {
    const access: AccessContext = {
      user: "human:reader",
      roleName: "public-reader",
      role: { read: ["public"], write: [], promote: false, ratify: false },
    };
    const result = await vaultSearch(
      vault,
      { filters: [{ field: "priority", op: "gte", value: 2 }], limit: 2 },
      access,
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.hits.map((hit) => hit.path)).toEqual(["public/a.md", "public/b.md"]);
  });

  it("requires a non-empty query or a non-empty filter list", async () => {
    expect((await vaultSearch(vault, {})).ok).toBe(false);
    expect((await vaultSearch(vault, { query: "  " })).ok).toBe(false);
    expect((await vaultSearch(vault, { filters: [] })).ok).toBe(false);
    const wrongQuery = await vaultSearch(vault, { query: 3 });
    expect(wrongQuery.ok).toBe(false);
    if (!wrongQuery.ok) expect(wrongQuery.error.message).toContain("query");
  });

  it("rejects undeclared filters before search", async () => {
    const result = await vaultSearch(vault, {
      filters: [{ field: "cost", op: "eq", value: 4 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("field 'cost' is not indexed");
  });

  it("publishes optional query and filters in the tool schema and structured summary", async () => {
    const tool = searchTools.find((candidate) => candidate.name === "vault_search");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toBeUndefined();
    expect(tool?.inputSchema.properties).toHaveProperty("filters");
    const result = await vaultSearch(vault, {
      filters: [{ field: "priority", op: "eq", value: 3 }],
    });
    if (!result.ok) throw result.error;
    expect(tool?.summarize?.(result.value)).toContain("filtered result");
  });
});
