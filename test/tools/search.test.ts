import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vaultReindex, vaultSearch, vaultSearchRelated } from "../../src/tools/search.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const INSIGHT_DOC = "competitive-intel/vega-insight-positioning.md";

describe("search tools", () => {
  let vault: string;

  // Build the index once up front so individual search tests don't pay the
  // embedding cost inside a default-timeout test.
  beforeAll(async () => {
    vault = makeTempVault();
    const result = await vaultReindex(vault);
    if (!result.ok) throw result.error;
  }, 60_000);

  afterAll(() => {
    cleanupVault(vault);
  });

  describe("vault_reindex", () => {
    it("rebuilds the index and reports counts", async () => {
      const result = await vaultReindex(vault);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.documentCount).toBe(10);
      expect(result.value.vault).toBe(vault);
    });
  });

  describe("vault_search", () => {
    it("returns ranked hits for a query", async () => {
      const result = await vaultSearch(vault, {
        query: "Helios compute credit consumption pricing",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.length).toBeGreaterThan(0);
      expect(result.value.hits[0]?.path).toBe("pricing/helios-consumption-pricing.md");
    });

    it("rejects a missing or empty query", async () => {
      const empty = await vaultSearch(vault, { query: "  " });
      expect(empty.ok).toBe(false);
      const missing = await vaultSearch(vault, {});
      expect(missing.ok).toBe(false);
    });

    it("honors a custom limit", async () => {
      const result = await vaultSearch(vault, { query: "pricing", limit: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.length).toBeLessThanOrEqual(1);
    });

    it("accepts custom ranking weights", async () => {
      const result = await vaultSearch(vault, {
        query: "cirrus capacity",
        weights: { bm25: 1, vector: 0 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.weights).toEqual({ bm25: 1, vector: 0 });
    });

    it("every hit carries a decay field that is null or an object", async () => {
      const result = await vaultSearch(vault, { query: "pricing" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.length).toBeGreaterThan(0);
      for (const hit of result.value.hits) {
        expect(Object.hasOwn(hit, "decay")).toBe(true);
        expect(hit.decay === null || typeof hit.decay === "object").toBe(true);
      }
    });
  });

  describe("vault_search_related", () => {
    it("returns related documents for a valid path", async () => {
      const result = await vaultSearchRelated(vault, { path: INSIGHT_DOC });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.length).toBeGreaterThan(0);
      expect(result.value.hits.map((h) => h.path)).not.toContain(INSIGHT_DOC);
    });

    it("rejects a missing or empty path", async () => {
      const result = await vaultSearchRelated(vault, { path: "" });
      expect(result.ok).toBe(false);
    });

    it("errors for a path that is not in the vault", async () => {
      const result = await vaultSearchRelated(vault, {
        path: "pricing/ghost.md",
      });
      expect(result.ok).toBe(false);
    });
  });
});
