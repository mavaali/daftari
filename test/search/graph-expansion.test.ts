import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyGraphExpansion,
  maxChunkCosine,
  type NeighborCandidate,
  selectExpansion,
} from "../../src/search/graph-expansion.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import { reindexVault } from "../../src/search/reindex.js";
import { embedQuery, getProvider } from "../../src/search/vector.js";
import { type IndexDb, openIndexDb } from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const cand = (
  path: string,
  seed: string,
  edgeType: "derives_from" | "tension",
  affinity: number,
): NeighborCandidate => ({ path, seed, edgeType, affinity });

describe("selectExpansion", () => {
  it("keeps only neighbors at or above tau, ordered by descending affinity, capped", () => {
    const out = selectExpansion(
      [
        cand("a", "s1", "derives_from", 0.9),
        cand("b", "s1", "tension", 0.5),
        cand("c", "s2", "derives_from", 0.2),
      ],
      new Set(["s1", "s2"]),
      { cap: 5, tau: 0.3 },
    );
    expect(out.map((h) => h.path)).toEqual(["a", "b"]); // c below tau dropped
    expect(out[0]).toMatchObject({ path: "a", viaEdge: { seed: "s1", edgeType: "derives_from" } });
  });

  it("honors the global cap after the floor", () => {
    const out = selectExpansion(
      [
        cand("a", "s1", "tension", 0.9),
        cand("b", "s1", "tension", 0.8),
        cand("c", "s1", "tension", 0.7),
      ],
      new Set(["s1"]),
      { cap: 2, tau: 0.3 },
    );
    expect(out.map((h) => h.path)).toEqual(["a", "b"]);
  });

  it("dedups a neighbor already in the candidate (seed) set", () => {
    const out = selectExpansion(
      [cand("s2", "s1", "derives_from", 0.99), cand("d", "s1", "tension", 0.6)],
      new Set(["s1", "s2"]),
      { cap: 5, tau: 0.3 },
    );
    expect(out.map((h) => h.path)).toEqual(["d"]); // s2 is already a seed
  });

  it("dedups a neighbor reachable from two seeds, keeping the higher-affinity attribution", () => {
    const out = selectExpansion(
      [cand("x", "s1", "derives_from", 0.6), cand("x", "s2", "tension", 0.8)],
      new Set(["s1", "s2"]),
      { cap: 5, tau: 0.3 },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      path: "x",
      affinity: 0.8,
      viaEdge: { seed: "s2", edgeType: "tension" },
    });
  });

  it("returns empty when cap is 0", () => {
    expect(
      selectExpansion([cand("a", "s1", "tension", 0.9)], new Set(["s1"]), { cap: 0, tau: 0.3 }),
    ).toEqual([]);
  });
});

const hit = (path: string) =>
  ({
    path,
    title: path,
    collection: "c",
    status: "canonical",
    score: 1,
    bm25Score: 1,
    vectorScore: 0,
    snippet: "",
    decay: null,
    // biome-ignore lint/suspicious/noExplicitAny: test-only cast
  }) as any;

// biome-ignore lint/suspicious/noExplicitAny: partial-deps override helper
const deps = (over: Partial<any> = {}) => ({
  loadGraph: async () => ({
    tensions: [{ sourceA: "s1", sourceB: "n_tension" }],
    edges: [{ fromPath: "s1", toPath: "n_edge", status: "trigger-bearing" }],
  }),
  embedQuery: async () => new Float32Array([1, 0, 0]),
  affinity: (path: string) => (path === "n_edge" ? 0.9 : path === "n_tension" ? 0.1 : 0),
  materialize: (paths: string[]) =>
    paths.map((p) => ({ path: p, title: p, collection: "c", status: "canonical" })),
  ...over,
});

describe("applyGraphExpansion", () => {
  it("returns ranked unchanged when disabled", async () => {
    const ranked = [hit("s1")];
    // biome-ignore lint/suspicious/noExplicitAny: hermetic
    const out = await applyGraphExpansion({} as any, "/v", "q", ranked, {
      config: { enabled: false, cap: 5, tau: 0.3, subset: "trigger" },
      ...deps(),
    });
    expect(out).toBe(ranked);
  });

  it("appends affinity-passing neighbors flagged viaEdge, drops below-tau", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: hermetic
    const out = await applyGraphExpansion({} as any, "/v", "q", [hit("s1")], {
      config: { enabled: true, cap: 5, tau: 0.3, subset: "trigger" },
      ...deps(),
    });
    expect(out.map((h) => h.path)).toEqual(["s1", "n_edge"]); // n_tension 0.1 < tau dropped
    expect(out[1].viaEdge).toEqual({ seed: "s1", edgeType: "derives_from" });
    expect(out[1].coverageReason).toBeUndefined();
  });

  it("no-ops on an empty graph", async () => {
    const ranked = [hit("s1")];
    // biome-ignore lint/suspicious/noExplicitAny: hermetic
    const out = await applyGraphExpansion({} as any, "/v", "q", ranked, {
      config: { enabled: true, cap: 5, tau: 0.3, subset: "trigger" },
      ...deps({ loadGraph: async () => ({ tensions: [], edges: [] }) }),
    });
    expect(out).toBe(ranked);
  });

  it("no-ops (returns ranked) when the query cannot be embedded", async () => {
    const ranked = [hit("s1")];
    // biome-ignore lint/suspicious/noExplicitAny: hermetic
    const out = await applyGraphExpansion({} as any, "/v", "q", ranked, {
      config: { enabled: true, cap: 5, tau: 0.3, subset: "trigger" },
      ...deps({ embedQuery: async () => null }),
    });
    expect(out).toBe(ranked);
  });
});

const itIntegration = process.env.RB_INTEGRATION ? it : it.skip;

describe("maxChunkCosine (integration)", () => {
  let vault: string;
  let db: IndexDb;

  beforeEach(async () => {
    vault = makeTempVault();
    const r = await reindexVault(vault);
    if (!r.ok) throw r.error;
    const o = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!o.ok) throw o.error;
    db = o.value;
  });

  afterEach(() => {
    db.close();
    cleanupVault(vault);
  });

  itIntegration(
    "returns a real doc's best chunk cosine (0,1] and 0 for an unindexed path",
    async () => {
      const provider = getProvider();
      const q = await embedQuery("data governance and pipeline lineage");
      expect(q.ok).toBe(true);
      if (!q.ok) return;

      const real = maxChunkCosine(
        db,
        "competitive-intel/northwind-data-governance.md",
        q.value,
        provider,
      );
      expect(real).toBeGreaterThan(0);
      expect(real).toBeLessThanOrEqual(1);

      const missing = maxChunkCosine(db, "does/not/exist.md", q.value, provider);
      expect(missing).toBe(0);
    },
    120_000,
  );
});
