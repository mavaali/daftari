# Graph-Augmented Retrieval (off.1 / MAV-154) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After hybrid ranking, inject a bounded, affinity-filtered set of one-hop edge neighbors so multi-hop docs the ranker missed enter results — behind a default-off config flag.

**Architecture:** A new post-pass `applyGraphExpansion(db, vaultRoot, query, ranked, opts)` in `src/search/graph-expansion.ts`, called by the `vault_search` handler right after `applyCoveragePass` — mirroring that pass's shape (resolves its own config gate, returns `ranked` unchanged when off, injected hits flagged and RBAC-filtered). `hybrid.ts` ranking is not modified (only its `HybridHit` type gains a `viaEdge` field). The pure selection core is split out for hermetic unit tests; edge loading, query embedding, and neighbor cosine are the impure shell.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), better-sqlite3 index, sqlite-vec, vitest. Reuses `topicEgoGraphFrom` (`src/canon/topic.ts`), `listEdges`/`listTensions` (`src/curation/`), `getChunksForPath`/`cosineSimilarity`/`embedQuery`/`getProvider` (`src/search/`).

**Spec:** `docs/superpowers/specs/2026-08-17-graph-augmented-retrieval-design.md`
**Gate (banked):** `docs/superpowers/results/2026-08-17-mav154-edge-ceiling.md` — the $0 ceiling arm did not trigger the kill condition; trigger-bearing subset wins.

---

## Deviation note (spec → plan)

The spec described the unit as `graphAugmentedSearch(db, vaultRoot, query, opts)` that *calls* `hybridSearch` for seeds. Reading `src/tools/search.ts:584-643` shows the handler already calls `hybridSearch`, applies RBAC + validity, slices, then runs `applyCoveragePass(db, ranked)` as a **post-pass**. Re-invoking `hybridSearch` inside a wrapper would duplicate that RBAC/validity/slice logic. So this plan implements graph expansion as a **post-pass on the already-ranked hits**, exactly like the coverage pass. Design intent is unchanged: a new isolated, independently-testable unit; `hybrid.ts` ranking untouched; `vault_search` calls it; injected docs flagged and RBAC-filtered. This is a better fit with the codebase, not a scope change.

---

## File Structure

- **Create** `src/search/graph-expansion.ts` — the pass. Public: `applyGraphExpansion(db, vaultRoot, query, ranked, deps?)`. Internal, exported for tests: `selectExpansion(...)` (pure selection core), `maxChunkCosine(db, path, queryEmbedding, provider)` (affinity helper), the `GraphExpandConfig` type re-export.
- **Modify** `src/search/hybrid.ts` — add `viaEdge?: { seed: string; edgeType: "derives_from" | "tension" }` to the `HybridHit` interface (type only, ~line 90).
- **Modify** `src/utils/config.ts` — add `graphExpand` to `SearchTuningConfig` (line 390), `SEARCH_TUNING_DEFAULTS` (400), `RECOGNISED_SEARCH_KEYS` (409), and the `search` block parser (~1668-1705).
- **Modify** `src/tools/search.ts` — after `applyCoveragePass` (line 640), await `applyGraphExpansion(...)` and RBAC-filter the injected (`viaEdge`) hits.
- **Create** `test/search/graph-expansion.test.ts` — hermetic unit tests for `selectExpansion` + the pass with injected deps.
- **Create** `integrations/recall-bench/edge-expansion-runner.mjs` — the validation arm: graph expansion vs rank-extension at matched budget on the synthetic edgehop corpus.

Build/test commands (from worktree root `/Users/mihirwagle/projects/daftari/.worktrees/off1-edge-ceiling`):
- Typecheck: `npx tsc --noEmit`
- Unit tests: `npx vitest run test/search/graph-expansion.test.ts`
- Build dist (for the recall-bench arm): `npm run build`

---

## Task 1: `viaEdge` field on HybridHit

**Files:**
- Modify: `src/search/hybrid.ts` (HybridHit interface, ~line 90)

- [ ] **Step 1: Add the field**

In the `HybridHit` interface, after the `coverageReason` line, add:

```typescript
  // off.1/MAV-154: set when the graph-expansion pass injected this hit (not the
  // ranker, not the coverage pass). `seed` is the ranked doc it was reached from;
  // `edgeType` is which edge kind bridged them. Distinct signal from viaCoverage/
  // coverageReason — an edge-injected hit sets viaEdge and NO coverageReason.
  viaEdge?: { seed: string; edgeType: "derives_from" | "tension" };
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (additive optional field; no consumer breaks).

- [ ] **Step 3: Commit**

```bash
git add src/search/hybrid.ts
git commit -m "feat(search): viaEdge provenance field on HybridHit (off.1)"
```

---

## Task 2: `graph_expand` config

**Files:**
- Modify: `src/utils/config.ts` (lines 390, 400, 409, ~1668-1705)

- [ ] **Step 1: Write the failing test**

Create `test/utils/config-graph-expand.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/utils/config.js";

function vaultWith(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cfg-ge-"));
  writeFileSync(join(dir, "config.yaml"), yaml);
  return dir;
}

describe("search.graph_expand config", () => {
  it("defaults to disabled with sane defaults when absent", () => {
    const res = loadConfig(vaultWith("roles: {}\n"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.search.graphExpand).toEqual({
      enabled: false,
      cap: 10,
      tau: 0.3,
      subset: "trigger",
    });
  });

  it("parses an explicit block", () => {
    const res = loadConfig(
      vaultWith("search:\n  graph_expand:\n    enabled: true\n    cap: 6\n    tau: 0.45\n    subset: all\n"),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.search.graphExpand).toEqual({
      enabled: true,
      cap: 6,
      tau: 0.45,
      subset: "all",
    });
  });

  it("rejects a malformed subset", () => {
    const res = loadConfig(vaultWith("search:\n  graph_expand:\n    subset: sideways\n"));
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/utils/config-graph-expand.test.ts`
Expected: FAIL — `graphExpand` undefined / type error.

- [ ] **Step 3: Implement the config**

In `src/utils/config.ts`:

(a) Add the type above `SearchTuningConfig`:

```typescript
export type GraphExpandSubset = "trigger" | "all" | "tensions";
export interface GraphExpandConfig {
  enabled: boolean;
  cap: number;
  tau: number;
  subset: GraphExpandSubset;
}
```

(b) Add to `SearchTuningConfig` (after `suppressSuperseded`):

```typescript
  // off.1/MAV-154: one-hop edge expansion post-pass in vault_search. Default off
  // — the $0 ceiling arm cleared but wild-alignment is unproven (bead off.6).
  // `subset` picks the edge kinds (trigger = tensions + trigger-bearing
  // derives_from, the ceiling winner). `tau` is the vector-cosine affinity floor;
  // `cap` the fixed global add budget.
  graphExpand: GraphExpandConfig;
```

(c) Add to `SEARCH_TUNING_DEFAULTS`:

```typescript
  graphExpand: { enabled: false, cap: 10, tau: 0.3, subset: "trigger" },
```

(d) Add `"graph_expand"` to `RECOGNISED_SEARCH_KEYS`.

(e) In the `search` block parser (~line 1670, after the `vec_knn_k` branch), add a `graph_expand` branch. Follow the existing malformed-config error style exactly:

```typescript
    if (block.graph_expand !== undefined) {
      const ge = block.graph_expand;
      if (typeof ge !== "object" || ge === null || Array.isArray(ge)) {
        return err(new Error("malformed config: 'search.graph_expand' must be a mapping"));
      }
      const g = { ...SEARCH_TUNING_DEFAULTS.graphExpand };
      if (ge.enabled !== undefined) {
        if (typeof ge.enabled !== "boolean") {
          return err(new Error("malformed config: 'search.graph_expand.enabled' must be true or false"));
        }
        g.enabled = ge.enabled;
      }
      if (ge.cap !== undefined) {
        if (typeof ge.cap !== "number" || !Number.isInteger(ge.cap) || ge.cap < 0) {
          return err(new Error("malformed config: 'search.graph_expand.cap' must be a non-negative integer"));
        }
        g.cap = ge.cap;
      }
      if (ge.tau !== undefined) {
        if (typeof ge.tau !== "number" || ge.tau < -1 || ge.tau > 1) {
          return err(new Error("malformed config: 'search.graph_expand.tau' must be a number in [-1, 1]"));
        }
        g.tau = ge.tau;
      }
      if (ge.subset !== undefined) {
        if (ge.subset !== "trigger" && ge.subset !== "all" && ge.subset !== "tensions") {
          return err(new Error("malformed config: 'search.graph_expand.subset' must be trigger | all | tensions"));
        }
        g.subset = ge.subset;
      }
      search.graphExpand = g;
    }
```

Note: check the exact type of the `block`/`ge` variable — if the parser types the block loosely (e.g. `Record<string, unknown>`), narrow `ge` accordingly before property access (cast to a local `Record<string, unknown>` as the surrounding branches do).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/utils/config-graph-expand.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Full-file typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/utils/config.ts test/utils/config-graph-expand.test.ts
git commit -m "feat(config): search.graph_expand block, default off (off.1)"
```

---

## Task 2b: startup runtime setter (match the coverage/vecKnnK convention)

The handler must NOT `loadConfig(vaultRoot)` per query (re-reads/parses `config.yaml` on every search). The codebase resolves search tuning ONCE at startup via module-level setters — `setCoverageEnabled(...)` / `setVecKnnK(...)` are called from `src/index.ts` (~line 121) and `src/serve/index.ts` (~line 708) with the loaded `config.search.*`. Graph expansion follows the same pattern: a module-level config holder in `graph-expansion.ts`, set at both startup sites, read by the pass at serve time.

**Files:**
- Modify: `src/search/graph-expansion.ts` (add the holder — this task lands it even though the file is created in Task 3; if executing in order, MERGE this into Task 3's file creation and defer the two startup-site edits + this task's commit to here)
- Modify: `src/index.ts` (~line 121, beside the `setCoverageEnabled`/`setVecKnnK` calls)
- Modify: `src/serve/index.ts` (~line 708, same)

- [ ] **Step 1: Add the module-level holder to `graph-expansion.ts`**

```typescript
import { SEARCH_TUNING_DEFAULTS, type GraphExpandConfig } from "../utils/config.js";

let graphExpandCfg: GraphExpandConfig = { ...SEARCH_TUNING_DEFAULTS.graphExpand };
export function setGraphExpandConfig(cfg: GraphExpandConfig): void {
  graphExpandCfg = cfg;
}
export function graphExpandConfig(): GraphExpandConfig {
  return graphExpandCfg;
}
```

- [ ] **Step 2: Wire both startup sites**

In `src/index.ts` next to the existing `setCoverageEnabled(config.search.coverage)` call (~121), add `setGraphExpandConfig(config.search.graphExpand)`. Do the identical addition in `src/serve/index.ts` (~708). Import `setGraphExpandConfig` from `./search/graph-expansion.js` (adjust relative path per file).

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit` → PASS.

```bash
git add src/search/graph-expansion.ts src/index.ts src/serve/index.ts
git commit -m "feat(search): graph-expand runtime config setter, wired at startup (off.1)"
```

Confirm the exact call sites by grepping first: `rg -n "setCoverageEnabled|setVecKnnK" src/index.ts src/serve/index.ts` — place the new setter beside them so it shares the one startup config resolution.

---

## Task 3: pure selection core `selectExpansion`

The heart of the mechanism, with zero I/O so it is hermetically testable. Given seeds, their candidate set, per-seed neighbor lists (with edge type), an affinity score for each neighbor, and `{cap, tau}`, it returns the injected hits in descending-affinity order, deduped against candidates and across seeds, capped.

**Files:**
- Create: `src/search/graph-expansion.ts`
- Test: `test/search/graph-expansion.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/search/graph-expansion.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { selectExpansion, type NeighborCandidate } from "../../src/search/graph-expansion.js";

const cand = (
  path: string,
  seed: string,
  edgeType: "derives_from" | "tension",
  affinity: number,
): NeighborCandidate => ({ path, seed, edgeType, affinity });

describe("selectExpansion", () => {
  it("keeps only neighbors at or above tau, ordered by descending affinity, capped", () => {
    const out = selectExpansion(
      [cand("a", "s1", "derives_from", 0.9), cand("b", "s1", "tension", 0.5), cand("c", "s2", "derives_from", 0.2)],
      new Set(["s1", "s2"]),
      { cap: 5, tau: 0.3 },
    );
    expect(out.map((h) => h.path)).toEqual(["a", "b"]); // c below tau dropped
    expect(out[0]).toMatchObject({ path: "a", viaEdge: { seed: "s1", edgeType: "derives_from" } });
  });

  it("honors the global cap after the floor", () => {
    const out = selectExpansion(
      [cand("a", "s1", "tension", 0.9), cand("b", "s1", "tension", 0.8), cand("c", "s1", "tension", 0.7)],
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
    expect(out[0]).toMatchObject({ path: "x", affinity: 0.8, viaEdge: { seed: "s2", edgeType: "tension" } });
  });

  it("returns empty when cap is 0", () => {
    expect(selectExpansion([cand("a", "s1", "tension", 0.9)], new Set(["s1"]), { cap: 0, tau: 0.3 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/search/graph-expansion.test.ts`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Implement `selectExpansion`**

Create `src/search/graph-expansion.ts` with (only the pure core for now):

```typescript
// off.1/MAV-154 graph-augmented retrieval: a post-pass that injects a bounded,
// affinity-filtered set of one-hop edge neighbors into an already-ranked hit
// list. Mirrors applyCoveragePass (src/tools/search.ts): resolves its own config
// gate, returns `ranked` unchanged when off, flags injected hits (viaEdge) for
// RBAC filtering at the call site. hybrid.ts ranking is not touched.

export interface NeighborCandidate {
  path: string;
  seed: string; // the ranked doc it was reached from
  edgeType: "derives_from" | "tension";
  affinity: number; // max cosine of the neighbor's chunks to the query embedding
}

export interface SelectOptions {
  cap: number; // fixed global add budget
  tau: number; // vector-cosine affinity floor
}

export interface ExpansionHit {
  path: string;
  affinity: number;
  viaEdge: { seed: string; edgeType: "derives_from" | "tension" };
}

// Pure. Floor by tau, dedup against candidates and across seeds (keeping the
// highest-affinity attribution per path), order by descending affinity, cap.
export function selectExpansion(
  candidates: NeighborCandidate[],
  candidateSet: ReadonlySet<string>,
  opts: SelectOptions,
): ExpansionHit[] {
  if (opts.cap <= 0) return [];
  const best = new Map<string, NeighborCandidate>();
  for (const c of candidates) {
    if (c.affinity < opts.tau) continue;
    if (candidateSet.has(c.path)) continue; // already a ranked/seed doc
    const prior = best.get(c.path);
    if (!prior || c.affinity > prior.affinity) best.set(c.path, c);
  }
  return [...best.values()]
    .sort((a, b) => b.affinity - a.affinity || a.path.localeCompare(b.path))
    .slice(0, opts.cap)
    .map((c) => ({ path: c.path, affinity: c.affinity, viaEdge: { seed: c.seed, edgeType: c.edgeType } }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/search/graph-expansion.test.ts`
Expected: PASS (all five).

- [ ] **Step 5: Commit**

```bash
git add src/search/graph-expansion.ts test/search/graph-expansion.test.ts
git commit -m "feat(search): pure selectExpansion core for graph expansion (off.1)"
```

---

## Task 4: affinity helper `maxChunkCosine`

**Files:**
- Modify: `src/search/graph-expansion.ts`
- Test: `test/search/graph-expansion.test.ts` (add an integration-gated block)

- [ ] **Step 1: Write the failing test (integration-gated)**

Add to `test/search/graph-expansion.test.ts`. This one loads the real index + provider, so gate it like the other model-loading tests (`RB_INTEGRATION`). Build the tiny vault with the existing test helpers if present; otherwise use a seeded temp index. Skeleton:

```typescript
import { getProvider } from "../../src/search/vector.js";

const itIntegration = process.env.RB_INTEGRATION ? it : it.skip;

describe("maxChunkCosine (integration)", () => {
  itIntegration("returns a doc's best chunk cosine to a query embedding, 0 for an unindexed path", async () => {
    // Arrange: reindex a 2-doc temp vault; embed a query near doc A.
    // (Reuse whatever seeded-index helper the repo's search tests already use —
    //  search test/search/*.test.ts for the established fixture before hand-rolling.)
    // Assert: cosine(A) > cosine(B); maxChunkCosine(db, "missing.md", q, provider) === 0.
  });
});
```

Note to implementer: check `test/search/` for an existing reindex-a-temp-vault fixture and reuse it rather than inventing one. The affinity helper's contract is the assertion; the fixture is incidental.

- [ ] **Step 2: Run to verify it fails / skips**

Run: `RB_INTEGRATION=1 npx vitest run test/search/graph-expansion.test.ts`
Expected: FAIL — `maxChunkCosine` not exported.

- [ ] **Step 3: Implement `maxChunkCosine`**

Add to `src/search/graph-expansion.ts`:

```typescript
import { getChunksForPath, type IndexDb } from "../storage/index-db.js";
import type { EmbeddingProvider } from "./embedding-provider.js"; // NOT re-exported by vector.js
import { cosineSimilarity } from "./vector.js";

// Max cosine of any of a document's chunk embeddings to the query embedding.
// Reads the plain `embeddings` rows via getChunksForPath — NOT the KNN virtual
// table; a known neighbor set does not need the global scan. 0 when the path is
// unindexed or has no embeddings (never a false floor pass).
export function maxChunkCosine(
  db: IndexDb,
  path: string,
  queryEmbedding: Float32Array,
  provider: Pick<EmbeddingProvider, "id" | "dim">,
): number {
  let best = 0;
  for (const chunk of getChunksForPath(db, path, provider.id, provider.dim)) {
    if (!chunk.embedding) continue;
    const c = cosineSimilarity(chunk.embedding, queryEmbedding);
    if (c > best) best = c;
  }
  return best;
}
```

`EmbeddingProvider` lives in `src/search/embedding-provider.js` (vector.ts imports it type-only and does not re-export it). `getProvider()` returns exactly that type, so `Pick<EmbeddingProvider,"id"|"dim">` is valid with the corrected import path.

- [ ] **Step 4: Run to verify it passes**

Run: `RB_INTEGRATION=1 npx vitest run test/search/graph-expansion.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/search/graph-expansion.ts test/search/graph-expansion.test.ts
git commit -m "feat(search): maxChunkCosine affinity helper (off.1)"
```

---

## Task 5: the pass `applyGraphExpansion`

Wires the shell around the pure core: gate → load edges/tensions for the subset → embed query → gather one-hop neighbors per seed → score affinity → `selectExpansion` → append flagged hits. Dependency-injectable so the wiring is unit-tested without a live index.

**Files:**
- Modify: `src/search/graph-expansion.ts`
- Test: `test/search/graph-expansion.test.ts`

- [ ] **Step 1: Write the failing test (hermetic, injected deps)**

Add a `describe("applyGraphExpansion")` block. Inject fakes for edge loading, query embedding, and affinity so it stays hermetic:

```typescript
import { applyGraphExpansion } from "../../src/search/graph-expansion.js";

const hit = (path: string) => ({ path, title: path, collection: "c", status: "canonical", score: 1, bm25Score: 1, vectorScore: 0, snippet: "", decay: null }) as any;

const deps = (over: Partial<any> = {}) => ({
  loadGraph: async () => ({
    tensions: [{ sourceA: "s1", sourceB: "n_tension" }],
    edges: [{ fromPath: "s1", toPath: "n_edge", status: "trigger-bearing" }],
  }),
  embedQuery: async () => new Float32Array([1, 0, 0]),
  affinity: (path: string) => (path === "n_edge" ? 0.9 : path === "n_tension" ? 0.1 : 0),
  ...over,
});

describe("applyGraphExpansion", () => {
  it("returns ranked unchanged when disabled", async () => {
    const ranked = [hit("s1")];
    const out = await applyGraphExpansion({} as any, "/v", "q", ranked, {
      config: { enabled: false, cap: 5, tau: 0.3, subset: "trigger" },
      ...deps(),
    });
    expect(out).toBe(ranked);
  });

  it("appends affinity-passing neighbors flagged viaEdge, drops below-tau", async () => {
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
    const out = await applyGraphExpansion({} as any, "/v", "q", ranked, {
      config: { enabled: true, cap: 5, tau: 0.3, subset: "trigger" },
      ...deps({ loadGraph: async () => ({ tensions: [], edges: [] }) }),
    });
    expect(out).toEqual(ranked);
  });

  it("no-ops (returns ranked) when the query cannot be embedded", async () => {
    const ranked = [hit("s1")];
    const out = await applyGraphExpansion({} as any, "/v", "q", ranked, {
      config: { enabled: true, cap: 5, tau: 0.3, subset: "trigger" },
      ...deps({ embedQuery: async () => null }),
    });
    expect(out).toBe(ranked);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/search/graph-expansion.test.ts`
Expected: FAIL — `applyGraphExpansion` not exported.

- [ ] **Step 3: Implement `applyGraphExpansion`**

Add to `src/search/graph-expansion.ts`. The default (non-test) deps load the real graph, embed with `embedQuery`, and score with `maxChunkCosine`; tests inject fakes. Seeds are the current `ranked` paths.

```typescript
import { topicEgoGraphFrom } from "../canon/topic.js";
import { listEdges } from "../curation/edges.js";
import { listTensions } from "../curation/tension.js";
import type { HybridHit } from "./hybrid.js";
import { embedQuery as embedQueryReal, getProvider } from "./vector.js";
import type { GraphExpandConfig } from "../utils/config.js";

interface Graph {
  tensions: { sourceA: string; sourceB: string }[];
  edges: { fromPath: string; toPath: string; status: string }[];
}

export interface GraphExpansionDeps {
  config: GraphExpandConfig;
  loadGraph: (vaultRoot: string, subset: GraphExpandConfig["subset"]) => Promise<Graph>;
  embedQuery: (query: string) => Promise<Float32Array | null>;
  affinity: (path: string) => number; // db + query embedding already closed over
}

// Default graph loader: the subset gates which edge kinds are traversed.
// tensions kept for "trigger" and "all"; empty for "tensions"? No — "tensions"
// keeps tensions only. Edges: "trigger" = trigger-bearing only; "all" =
// candidate + trigger-bearing (non-revoked); "tensions" = none. Revoked never
// included (listEdges status filter excludes it).
export async function loadGraphForSubset(
  vaultRoot: string,
  subset: GraphExpandConfig["subset"],
): Promise<Graph> {
  const tensionsRes = await listTensions(vaultRoot);
  const tensions = tensionsRes.ok
    ? tensionsRes.value.map((t) => ({ sourceA: t.sourceA, sourceB: t.sourceB }))
    : [];
  let edges: Graph["edges"] = [];
  if (subset !== "tensions") {
    const status = subset === "trigger" ? "trigger-bearing" : undefined; // "all" => both live statuses
    const edgesRes = await listEdges(vaultRoot, status ? { status } : {});
    if (edgesRes.ok) {
      edges = edgesRes.value
        .filter((e) => e.status !== "revoked")
        .map((e) => ({ fromPath: e.fromPath, toPath: e.toPath, status: e.status }));
    }
  }
  return { tensions, edges };
}

// The pass. Returns `ranked` UNCHANGED (same reference) when disabled or when no
// neighbor clears the floor, so the call site's identity check is meaningful.
export async function applyGraphExpansion(
  db: IndexDb,
  vaultRoot: string,
  query: string,
  ranked: HybridHit[],
  deps: GraphExpansionDeps,
): Promise<HybridHit[]> {
  const { config } = deps;
  if (!config.enabled || config.cap <= 0 || ranked.length === 0) return ranked;

  const graph = await deps.loadGraph(vaultRoot, config.subset);
  if (graph.tensions.length === 0 && graph.edges.length === 0) return ranked;

  const qEmb = await deps.embedQuery(query);
  if (!qEmb) return ranked; // no vector signal ⇒ no affinity floor ⇒ do not inject blind

  const seedPaths = ranked.map((h) => h.path);
  const candidateSet = new Set(seedPaths);

  // Which edge kind bridged seed→neighbor? Build lookups so each injected hit is
  // attributed. topicEgoGraphFrom is undirected over the union; we recompute the
  // per-seed neighbor set and classify by membership in the tension vs edge maps.
  const tensionNbrs = adjacency(graph.tensions.map((t) => [t.sourceA, t.sourceB] as const));
  const edgeNbrs = adjacency(graph.edges.map((e) => [e.fromPath, e.toPath] as const));

  const candidates: NeighborCandidate[] = [];
  for (const seed of seedPaths) {
    for (const nbr of topicEgoGraphFrom(graph.tensions, graph.edges, seed, 1)) {
      if (nbr === seed || candidateSet.has(nbr)) continue;
      const edgeType: "derives_from" | "tension" =
        edgeNbrs.get(seed)?.has(nbr) ? "derives_from" : tensionNbrs.get(seed)?.has(nbr) ? "tension" : "derives_from";
      candidates.push({ path: nbr, seed, edgeType, affinity: deps.affinity(nbr) });
    }
  }

  const chosen = selectExpansion(candidates, candidateSet, { cap: config.cap, tau: config.tau });
  if (chosen.length === 0) return ranked;

  const injected: HybridHit[] = chosen.map((c) => {
    const doc = getDocumentsByPaths(db, [c.path])[0]; // materialize title/collection/status/snippet
    return {
      path: c.path,
      title: doc?.title ?? c.path,
      collection: doc?.collection ?? "",
      status: doc?.status ?? "",
      score: 0,
      bm25Score: 0,
      vectorScore: c.affinity,
      snippet: doc ? makeSnippet(doc.content, tokenize(query)) : "",
      decay: null,
      viaEdge: c.viaEdge,
    };
  });
  return [...ranked, ...injected];
}

function adjacency(pairs: readonly (readonly [string, string])[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b);
  };
  for (const [a, b] of pairs) { add(a, b); add(b, a); }
  return m;
}
```

Implementer notes:
- Import `getDocumentsByPaths` from `../storage/index-db.js`, `makeSnippet` + `tokenize` from the modules `hybrid.ts` uses (`makeSnippet` may be local to hybrid — if it is not exported, either export it or set `snippet: ""` for injected hits; injected hits are recall-recovery and a snippet is not load-bearing, prefer `""` over exporting internals if the export widens surface).
- The injected `HybridHit` sets `score: 0` and `vectorScore: affinity` so it sorts to the tail if any later stage re-sorts by score; it is appended after `ranked` regardless.
- Do NOT set `coverageReason` on injected hits (the transparency contract: viaEdge xor coverageReason).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/search/graph-expansion.test.ts`
Expected: PASS (hermetic block). Fix `adjacency`'s terse map-init if the linter objects; correctness over cleverness.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` → PASS.

```bash
git add src/search/graph-expansion.ts test/search/graph-expansion.test.ts
git commit -m "feat(search): applyGraphExpansion pass with injectable deps (off.1)"
```

---

## Task 6: wire into the `vault_search` handler

**Files:**
- Modify: `src/tools/search.ts` (after line 640, the `applyCoveragePass` call)

- [ ] **Step 1: Write the failing test**

Add a handler-level test asserting that with `graph_expand.enabled: true` on a seeded vault holding a trigger-bearing edge from a top hit to an off-query doc, that doc appears in results flagged `viaEdge`, and with the default (off) config it does not. Gate with `RB_INTEGRATION` (loads the model). Reuse the handler test fixtures in `test/tools/` (search for the existing `vault_search` handler test and extend it rather than starting fresh).

- [ ] **Step 2: Run to verify it fails**

Run: `RB_INTEGRATION=1 npx vitest run test/tools/<search-handler-test>.ts`
Expected: FAIL — expansion not wired.

- [ ] **Step 3: Wire the call**

After the coverage pass + its RBAC filter (search.ts:640-643, where `permitted` is defined), add the graph-expansion pass. Config comes from the startup runtime setter (Task 2b), NOT a per-query `loadConfig`. Embed the query ONCE and share it between the pass's gate and the affinity closure.

New imports to add to `src/tools/search.ts` (only `getProvider` is already imported, line 61):
`embedQuery` from `../search/vector.js`; `applyGraphExpansion`, `maxChunkCosine`, `loadGraphForSubset`, `graphExpandConfig` from `../search/graph-expansion.js`.

```typescript
    // off.1/MAV-154: one-hop edge-expansion post-pass (default off). Same shape
    // as the coverage pass — gated by the startup-resolved config, returns
    // `permitted` unchanged when off, injected hits flagged viaEdge + RBAC-filtered.
    const geCfg = graphExpandConfig();
    let permittedExpanded = permitted;
    if (geCfg.enabled) {
      const provider = getProvider();
      const qEmbRes = await embedQuery(query);
      const qEmb = qEmbRes.ok ? qEmbRes.value : null;
      const expanded = await applyGraphExpansion(db, vaultRoot, query, permitted, {
        config: geCfg,
        loadGraph: loadGraphForSubset,
        embedQuery: async () => qEmb, // embedded once, shared
        affinity: (path) => (qEmb ? maxChunkCosine(db, path, qEmb, provider) : 0),
      });
      permittedExpanded = access
        ? expanded.filter((h) => (h.viaEdge ? canRead(access.role, h.collection) : true))
        : expanded;
    }
```

Then continue the handler with `permittedExpanded` wherever it currently continues with `permitted` (the enrichment seam — contested/structural/rerank/slice). Grep to confirm the single downstream consumer of `permitted` and swap it there: `rg -n "permitted" src/tools/search.ts`. The `if (geCfg.enabled)` guard keeps the entire pass — including the extra query embed — out of the hot path for the default-off case (zero added cost for callers who do not opt in).

- [ ] **Step 4: Run to verify it passes**

Run: `RB_INTEGRATION=1 npx vitest run test/tools/<search-handler-test>.ts`
Expected: PASS.

- [ ] **Step 5: Guard against regressions**

Run: `npx vitest run test/search/ test/tools/ test/utils/config-graph-expand.test.ts` and `npx tsc --noEmit`.
Expected: PASS (default-off means zero behavior change for existing callers — verify the pre-existing handler tests are green).

- [ ] **Step 6: Commit**

```bash
git add src/tools/search.ts test/tools/<search-handler-test>.ts
git commit -m "feat(search): wire graph-expansion pass into vault_search, default off (off.1)"
```

---

## Task 7: recall-bench validation arm

Proves the *selective* mechanism (not just the inject-all ceiling) beats rank-extension at matched budget on the synthetic edgehop corpus, reporting recall AND distractor load.

**Files:**
- Create: `integrations/recall-bench/edge-expansion-runner.mjs`
- Create (results): `docs/superpowers/results/2026-08-17-mav154-edge-expansion.md`

- [ ] **Step 1: Build dist**

Run: `npm run build`
Expected: dist emitted (the runner imports `dist/search/graph-expansion.js`).

- [ ] **Step 2: Write the runner**

Model it on `edge-ceiling.mjs` (same vault open, same queries, same recall math), but instead of the inject-ALL ceiling, run the REAL selection: for each question, get top-10 seeds via `hybridSearch`, run `applyGraphExpansion` (or `selectExpansion` fed by the real `maxChunkCosine`) at `subset=trigger`, sweep `cap ∈ {5,10,20}` and a small `tau` grid, and compare recall to rank-extension at the SAME realized add budget (`|injected|`). Emit per-type (hub-hop / cross-tension / lex-reachable) `expansionRecall` vs `rankExtRecall`, `addedRelevant`, `addedDistractor`, `precision`. Reuse `EDGEHOP_VAULT`/`EDGEHOP_QUERIES`/`EDGEHOP_NOW` env like the ceiling.

- [ ] **Step 3: Regenerate the vault and run**

```bash
node integrations/recall-bench/gen-edgehop-vault.mjs
node integrations/recall-bench/edge-expansion-runner.mjs
```
Expected: JSON summary. Read: does selective expansion beat rank-extension at matched budget on hub-hop / cross-tension? (The ceiling headroom says it can; this measures how much of it the tau-floored selection realizes.)

- [ ] **Step 4: Write the results note**

Record the sweep, the chosen `cap`/`tau` defaults justified by the numbers (update `SEARCH_TUNING_DEFAULTS` if the sweep points elsewhere than the seeded 10/0.3), and the honest read: this is the synthetic corpus; wild-alignment remains `off.6`.

- [ ] **Step 5: Commit**

```bash
git add integrations/recall-bench/edge-expansion-runner.mjs docs/superpowers/results/2026-08-17-mav154-edge-expansion.md
git commit -m "test(recall-bench): selective edge-expansion vs rank-extension arm (off.1)"
```

---

## Task 8: finish

- [ ] **Step 1: Full typecheck + focused suites**

Run: `npx tsc --noEmit && npx vitest run test/search/ test/tools/ test/utils/config-graph-expand.test.ts`
Expected: all PASS.

- [ ] **Step 2: Verify default-off invariant**

Confirm no existing search/handler test changed behavior — graph expansion is inert unless `search.graph_expand.enabled: true`. This is the ship-safety property.

- [ ] **Step 3: Update the bead + request review**

Use superpowers:requesting-code-review to verify the diff implements this plan's tasks, then superpowers:finishing-a-development-branch for the merge/PR decision. Close `mavaali-beads-off.1` on merge; `off.6` (wild-alignment) remains open by design.

---

## Notes for the executor

- **Default-off is the ship-safety contract.** Every task preserves it; Task 8 verifies it. A reviewer should be able to confirm zero behavior change for any caller who does not opt in.
- **Purity discipline:** `selectExpansion` and the `adjacency` helper are pure and hermetically tested; only `loadGraphForSubset`, `maxChunkCosine`, and the real `embedQuery` touch I/O, and the pass injects them so its wiring is tested without a live index.
- **Do not modify `hybrid.ts` ranking.** Only its `HybridHit` type gains `viaEdge`.
- **Edge subset semantics** come straight from `topicEgoGraphFrom` + `listEdges` (revoked excluded; resolved tensions still linked; `trigger` = trigger-bearing derives_from + tensions).
- **YAGNI:** no per-seed fan-out cap, no depth>1, no `all`-subset default. Deferred by the spec.
