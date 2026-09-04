import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compileFieldFilterCandidateSql,
  parseFieldFilters,
} from "../../src/search/field-filters.js";
import { filterOnlySearch, hybridSearch } from "../../src/search/hybrid.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import { reindexVault } from "../../src/search/reindex.js";
import { type IndexDb, openIndexDb } from "../../src/storage/index-db.js";
import { clearConfigCache, loadConfig } from "../../src/utils/config.js";

function document(title: string, updated: string, fields: string): string {
  return [
    "---",
    `title: ${title}`,
    "domain: accumulation",
    "collection: projects",
    "status: canonical",
    "confidence: high",
    "created: 2026-09-01",
    `updated: ${updated}`,
    "updated_by: agent:test",
    "provenance: direct",
    "tags: []",
    fields,
    "---",
    "",
    "Shared needle for structured retrieval.",
    "",
  ].join("\n");
}

describe("indexed field retrieval", () => {
  let vault: string;
  let db: IndexDb;

  beforeAll(async () => {
    vault = mkdtempSync(join(tmpdir(), "daftari-indexed-search-"));
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(
      join(vault, ".daftari", "config.yaml"),
      [
        "schema_extensions:",
        "  priority:",
        "    type: number",
        "  due_date:",
        "    type: date",
        "  owner:",
        "    type: string",
        "indexed_fields: [priority, due_date, owner]",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(vault, "a.md"),
      document("A", "2026-09-01", "priority: 1\ndue_date: 2026-09-10\nowner: human:a"),
    );
    writeFileSync(
      join(vault, "b.md"),
      document("B", "2026-09-03", "priority: 2\ndue_date: 2026-09-20\nowner: human:b"),
    );
    writeFileSync(
      join(vault, "c.md"),
      document("C", "2026-09-02", "priority: 3\ndue_date: 2026-10-01\nowner: human:c"),
    );
    clearConfigCache();
    const reindexed = await reindexVault(vault);
    if (!reindexed.ok) throw reindexed.error;
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!opened.ok) throw opened.error;
    db = opened.value;
  }, 60_000);

  afterAll(() => {
    db.close();
    clearConfigCache();
    rmSync(vault, { recursive: true, force: true });
  });

  function filters(raw: unknown) {
    const config = loadConfig(vault);
    if (!config.ok) throw config.error;
    const parsed = parseFieldFilters(raw, config.value.indexedFields);
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  }

  it("filters both chunk- and document-granularity lexical ranking before limit", async () => {
    const compiled = filters([{ field: "priority", op: "gte", value: 2 }]);
    for (const lexicalGranularity of ["chunk", "document"] as const) {
      const result = await hybridSearch(db, "shared needle", {
        weights: { bm25: 1, vector: 0 },
        lexicalGranularity,
        filters: compiled,
        limit: 10,
      });
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.value.hits.map((hit) => hit.path).sort()).toEqual(["b.md", "c.md"]);
    }
  });

  it("keeps unfiltered lexical behavior unchanged", async () => {
    const absent = await hybridSearch(db, "shared needle", {
      weights: { bm25: 1, vector: 0 },
    });
    const empty = await hybridSearch(db, "shared needle", {
      weights: { bm25: 1, vector: 0 },
      filters: [],
    });
    expect(absent).toEqual(empty);
    if (absent.ok) expect(absent.value.hits).toHaveLength(3);
  });

  it("runs filtered vector ranking against durable embeddings rather than the empty KNN mirror", async () => {
    const semanticQuery = "structured project record";
    const initialUnfiltered = await hybridSearch(db, semanticQuery, {
      weights: { bm25: 0, vector: 1 },
    });
    expect(initialUnfiltered.ok).toBe(true);
    if (initialUnfiltered.ok) expect(initialUnfiltered.value.vectorUsed).toBe(true);

    db.exec("DELETE FROM embeddings_vec");
    const filtered = await hybridSearch(db, semanticQuery, {
      weights: { bm25: 0, vector: 1 },
      filters: filters([{ field: "owner", op: "eq", value: "human:b" }]),
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.value.vectorUsed).toBe(true);
    expect(filtered.value.hits.map((hit) => hit.path)).toEqual(["b.md"]);

    const unreadable = await hybridSearch(db, semanticQuery, {
      weights: { bm25: 0, vector: 1 },
      filters: filters([{ field: "owner", op: "eq", value: "human:b" }]),
      readableCollections: ["other"],
    });
    expect(unreadable.ok).toBe(true);
    if (unreadable.ok) {
      expect(unreadable.value.vectorUsed).toBe(false);
      expect(unreadable.value.hits.every((hit) => hit.vectorScore === 0)).toBe(true);
    }

    const unfiltered = await hybridSearch(db, semanticQuery, {
      weights: { bm25: 0, vector: 1 },
    });
    expect(unfiltered.ok).toBe(true);
    if (unfiltered.ok) expect(unfiltered.value.vectorUsed).toBe(false);

    db.exec("DELETE FROM embeddings");
    const lexicalFallback = await hybridSearch(db, "shared needle", {
      weights: { bm25: 0.8, vector: 0.2 },
      filters: filters([{ field: "owner", op: "eq", value: "human:b" }]),
    });
    expect(lexicalFallback.ok).toBe(true);
    if (!lexicalFallback.ok) return;
    expect(lexicalFallback.value.vectorUsed).toBe(false);
    expect(lexicalFallback.value.hits.map((hit) => hit.path)).toEqual(["b.md"]);
  });

  it("uses a typed document_fields index to seed eligible paths", () => {
    const candidate = compileFieldFilterCandidateSql(
      filters([{ field: "priority", op: "gte", value: 2 }]),
    );
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${candidate.sql}`).all(...candidate.params) as {
      detail: string;
    }[];
    expect(plan.some((row) => row.detail.includes("idx_document_fields_number"))).toBe(true);
  });

  it("returns deterministic zero-score filter-only hits", () => {
    const result = filterOnlySearch(
      db,
      filters([
        { field: "priority", op: "gte", value: 2 },
        { field: "due_date", op: "lte", value: "2026-10-01" },
      ]),
      { limit: 10 },
    );
    expect(result.hits.map((hit) => hit.path)).toEqual(["b.md", "c.md"]);
    expect(result.vectorUsed).toBe(false);
    expect(result.hits.every((hit) => hit.score === 0)).toBe(true);
    expect(result.hits.every((hit) => hit.bm25Score === 0 && hit.vectorScore === 0)).toBe(true);
  });

  it("applies valid-only before the filter-only limit", () => {
    db.prepare("UPDATE documents SET valid_from = ?, valid_until = ? WHERE path = ?").run(
      "2026-01-01",
      "2026-09-01",
      "b.md",
    );
    db.prepare("UPDATE documents SET valid_from = ?, valid_until = ? WHERE path = ?").run(
      "2026-09-01",
      null,
      "c.md",
    );
    try {
      const result = filterOnlySearch(db, filters([{ field: "priority", op: "gte", value: 2 }]), {
        limit: 1,
        validOnlyAt: "2026-09-15",
      });
      expect(result.hits.map((hit) => hit.path)).toEqual(["c.md"]);
    } finally {
      db.prepare(
        "UPDATE documents SET valid_from = NULL, valid_until = NULL WHERE path IN (?, ?)",
      ).run("b.md", "c.md");
    }
  });

  it("bounds a broad filter before materializing a small valid-only page", () => {
    const insertDocument = db.prepare(
      `INSERT INTO documents
         (path, title, collection, domain, status, confidence, updated, tags, content, tokens,
          ttl_days, created, superseded_by, valid_from, valid_until)
       VALUES (?, ?, 'projects', 'accumulation', 'canonical', 'high', ?, '[]', 'broad filter',
               '[]', NULL, '2026-01-01', NULL, ?, ?)`,
    );
    const insertField = db.prepare(
      `INSERT INTO document_fields
         (path, field, kind, text_value, number_value, bool_value)
       VALUES (?, 'priority', 'number', NULL, 9, NULL)`,
    );
    db.transaction(() => {
      for (let i = 0; i < 1_200; i++) {
        const path = `bulk/expired-${i.toString().padStart(4, "0")}.md`;
        insertDocument.run(path, path, "2026-12-01", "2026-01-01", "2026-08-01");
        insertField.run(path);
      }
      insertDocument.run("bulk/valid.md", "Valid", "2026-01-01", "2026-01-01", null);
      insertField.run("bulk/valid.md");
    })();
    try {
      const result = filterOnlySearch(db, filters([{ field: "priority", op: "eq", value: 9 }]), {
        limit: 1,
        validOnlyAt: "2026-09-15",
      });
      expect(result.hits.map((hit) => hit.path)).toEqual(["bulk/valid.md"]);
    } finally {
      db.exec(
        "DELETE FROM document_fields WHERE path LIKE 'bulk/%'; DELETE FROM documents WHERE path LIKE 'bulk/%';",
      );
    }
  });
});
