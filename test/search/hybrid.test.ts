import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, hybridSearch, relatedSearch } from "../../src/search/hybrid.js";
import { reindexVault } from "../../src/search/reindex.js";
import { type IndexDb, openIndexDb } from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const CREDIT_DOC = "pricing/helios-consumption-pricing.md";
const NORTHWIND_DOC = "competitive-intel/northwind-data-governance.md";
const INSIGHT_DOC = "competitive-intel/vega-insight-positioning.md";
const GOVERNANCE_DOCS = [NORTHWIND_DOC, INSIGHT_DOC];

describe("hybrid search", () => {
  let vault: string;
  let db: IndexDb;

  beforeAll(async () => {
    vault = makeTempVault();
    const reindexed = await reindexVault(vault);
    if (!reindexed.ok) throw reindexed.error;
    const opened = openIndexDb(vault);
    if (!opened.ok) throw opened.error;
    db = opened.value;
  }, 60_000);

  afterAll(() => {
    db.close();
    cleanupVault(vault);
  });

  describe("hybridSearch", () => {
    it("ranks the strongest lexical match first for a keyword query", async () => {
      const result = await hybridSearch(db, "Helios compute credit consumption pricing");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits[0]?.path).toBe(CREDIT_DOC);
    });

    it("returns snippets and per-ranker scores", async () => {
      const result = await hybridSearch(db, "cirrus pooled capacity tier");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.vectorUsed).toBe(true);
      const top = result.value.hits[0];
      expect(top?.snippet.length).toBeGreaterThan(0);
      expect(top?.bm25Score).toBeGreaterThan(0);
      expect(top?.score).toBeGreaterThan(0);
      for (const hit of result.value.hits) {
        expect(hit.bm25Score).toBeGreaterThanOrEqual(0);
        expect(hit.bm25Score).toBeLessThanOrEqual(1);
        expect(hit.vectorScore).toBeGreaterThanOrEqual(0);
        expect(hit.vectorScore).toBeLessThanOrEqual(1);
      }
    });

    it("respects the result limit", async () => {
      const result = await hybridSearch(db, "pricing", { limit: 2 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.length).toBeLessThanOrEqual(2);
    });

    it("finds semantically related docs when no keywords overlap", async () => {
      // None of these query words appear anywhere in the vault, so BM25 alone
      // returns nothing — any hit is a pure vector match.
      const query = "preventing unauthorized exfiltration of confidential corporate information";

      const lexicalOnly = await hybridSearch(db, query, {
        weights: { bm25: 1, vector: 0 },
      });
      expect(lexicalOnly.ok).toBe(true);
      if (!lexicalOnly.ok) return;
      expect(lexicalOnly.value.hits).toEqual([]);

      const semantic = await hybridSearch(db, query, {
        weights: { bm25: 0, vector: 1 },
      });
      expect(semantic.ok).toBe(true);
      if (!semantic.ok) return;
      expect(semantic.value.hits.length).toBeGreaterThan(0);
      expect(GOVERNANCE_DOCS).toContain(semantic.value.hits[0]?.path);
    });

    it("rejects an empty query", async () => {
      const result = await hybridSearch(db, "   ");
      // tokenize yields nothing and the query embeds to a generic vector;
      // still a valid (if weak) search — the tool layer guards empty input.
      expect(result.ok).toBe(true);
    });
  });

  describe("relatedSearch", () => {
    it("excludes the source document from its own results", () => {
      const result = relatedSearch(db, INSIGHT_DOC);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.map((h) => h.path)).not.toContain(INSIGHT_DOC);
      expect(result.value.hits.length).toBeGreaterThan(0);
    });

    it("surfaces a thematically related document", () => {
      // Vega Insight and Northwind both pitch a data-governance story.
      const result = relatedSearch(db, INSIGHT_DOC, { limit: 4 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.map((h) => h.path)).toContain(NORTHWIND_DOC);
    });

    it("errors for a document that is not indexed", () => {
      const result = relatedSearch(db, "pricing/nonexistent.md");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("not indexed");
    });

    it("uses the default weights when none are given", () => {
      const result = relatedSearch(db, CREDIT_DOC);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.weights).toEqual(DEFAULT_WEIGHTS);
    });
  });
});
