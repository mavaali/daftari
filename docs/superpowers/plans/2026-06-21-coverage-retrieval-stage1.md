# Coverage Retrieval — Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold an entity+date-window coverage pass into `vault_search` so a single call assembles the complete cluster of same-entity docs in the seeds' date window, composed with SP-A suppression — the recall lever from the [design spec](../specs/2026-06-21-edge-aware-coverage-retrieval-design.md).

**Architecture:** A new pure module `src/search/coverage.ts` runs after `vault_search`'s existing relevance ranking + RBAC filter. It detects a shared frontmatter tag among the top-K seeds (≥2 must share it), computes a date window from those seeds' `created` dates, and pulls same-entity docs in that window via a net-new date-range query — capped, recency-ordered, never displacing the caller's relevance top-N. The widened set then flows through the existing SP-A `resolveCurrentSource` loop (suppression) and a deterministic token-cap backstop. When no signal fires (single-fact query / no shared entity), the pass returns the hits unchanged → zero waste. This is **Stage 1** of three; Stage 2 (edge 1-hop expansion) and Stage 3 (measurement harness) are separate plans.

**Tech Stack:** TypeScript, Node, better-sqlite3, vitest. Result<T,Error> returns (no throws from tool handlers). No classes — functions and types. Tests mirror `src/` structure.

---

## Design notes the implementer must respect

- **No value-minting / no synthesis.** Coverage only *adds existing docs* and *annotates*; it never writes content or re-ranks the original order.
- **Signals come from the result set + frontmatter, never the query text** — avoids the SP-A query-conditioning fidelity trap.
- **Never displace the caller's relevance top-N.** Coverage docs are *appended* after the original hits and are the only ones eligible for token-cap eviction.
- **Config-overridable later, not now.** Stage 1 ships module-constant defaults plus an options-injection seam (`opts?: CoverageOptions`). The search path does not load `.daftari/config.yaml` today; wiring config is a deliberate follow-up, not a Stage 1 prerequisite.
- **Determinism.** All ordering ties break alphabetically by path/tag so tests are stable.

## File structure

- **Create** `src/search/coverage.ts` — the coverage pass: options type, entity detection, window computation, candidate gathering, orchestrator, token-cap eviction. One responsibility: "given ranked hits + the index, conditionally widen them."
- **Create** `test/search/coverage.test.ts` — unit tests over an `insertDocument`-populated index (fully deterministic, no embeddings), mirroring `test/search/current-source.test.ts`.
- **Modify** `src/storage/index-db.ts` — add `idx_documents_created` to `SCHEMA`; add `getDocumentsInDateRange`.
- **Modify** `src/search/hybrid.ts` — extend `HybridHit` with `viaCoverage?` / `coverageReason?`.
- **Modify** `src/tools/search.ts` — invoke the coverage pass + token cap inside `vaultSearch`, between the RBAC filter and the return.
- **Modify** `test/tools/search.test.ts` — one wiring test (coverage adds appear; quiet on single-fact).

---

## Task 1: Date-range query in the index

**Files:**
- Modify: `src/storage/index-db.ts` (add index to `SCHEMA` near line 105; add function near `getAllDocuments` at line 613)
- Test: `test/storage/index-db.test.ts` (create if absent, else append)

- [ ] **Step 1: Append the failing test to the existing file**

`test/storage/index-db.test.ts` **already exists** with a `vitest` import block, an import block from `../../src/storage/index-db.js`, and a `sampleDoc` constant (no `doc()` helper). Do NOT paste a standalone file — you will get duplicate-import errors. Instead:

1. Add `getDocumentsInDateRange` to the **existing** `import { … } from "../../src/storage/index-db.js"` block (keep it alphabetical near `getDocument`).
2. Append the `describe` block below to the end of the file. It defines a local `doc()` factory — confirm no `doc` identifier already exists in the file before adding (there is `sampleDoc`, not `doc`, so this is safe). It reuses the already-imported `afterEach`/`beforeEach`/`describe`/`expect`/`it`, `LOCAL_MINILM_DIM`, `IndexDb`, `IndexedDocument`, `insertDocument`, `openIndexDb`, `makeTempVault`, `cleanupVault` — do not re-import any of these.

```ts
function doc(over: Partial<IndexedDocument> & { path: string }): IndexedDocument {
  return {
    path: over.path, title: over.title ?? over.path, collection: over.collection ?? "notes",
    domain: "accumulation", status: over.status ?? "canonical", confidence: "high",
    updated: over.updated ?? "2026-05-01", tags: over.tags ?? [], content: over.content ?? "body",
    tokens: [], ttlDays: null, created: over.created ?? "2026-01-01",
    supersededBy: over.supersededBy ?? null,
  };
}

describe("getDocumentsInDateRange", () => {
  let vault: string; let db: IndexDb;
  beforeEach(() => { vault = makeTempVault(); const o = openIndexDb(vault, LOCAL_MINILM_DIM); if (!o.ok) throw o.error; db = o.value; });
  afterEach(() => { db.close(); cleanupVault(vault); });

  it("returns docs whose created date is within [start,end] inclusive", () => {
    insertDocument(db, doc({ path: "a.md", created: "2026-03-01" }));
    insertDocument(db, doc({ path: "b.md", created: "2026-03-15" }));
    insertDocument(db, doc({ path: "c.md", created: "2026-04-10" }));
    const got = getDocumentsInDateRange(db, "2026-03-01", "2026-03-31").map((d) => d.path).sort();
    expect(got).toEqual(["a.md", "b.md"]);
  });

  it("excludes docs with an empty created date", () => {
    insertDocument(db, doc({ path: "a.md", created: "" }));
    expect(getDocumentsInDateRange(db, "2025-01-01", "2027-01-01")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/storage/index-db.test.ts -t getDocumentsInDateRange`
Expected: FAIL — `getDocumentsInDateRange` is not exported.

- [ ] **Step 3: Add the index to `SCHEMA`**

In `src/storage/index-db.ts`, inside the `SCHEMA` template literal, immediately after the `documents` table's closing `);` (currently around line 106), add:

```sql
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created);
```

(`openIndexDb` runs `db.exec(SCHEMA)` at line 384, so this applies on next open — the index.db is an ephemeral rebuildable cache, no migration needed.)

- [ ] **Step 4: Add the query function**

Near `getAllDocuments` (line 613), add. ISO `YYYY-MM-DD` strings sort lexically, so a string `BETWEEN` is a correct date range. The empty-string `created` default sorts below any real date, so the `created != ''` guard drops undateable docs:

```ts
// Documents whose `created` date falls within [start, end] inclusive, ordered
// most-recent first (ties by path for determinism). Undateable docs (empty
// `created`) are excluded. ISO dates sort lexically so string comparison is a
// valid date range. Backs the coverage pass's date-window pull.
export function getDocumentsInDateRange(
  db: IndexDb,
  start: string,
  end: string,
): IndexedDocument[] {
  const rows = db
    .prepare(
      `SELECT * FROM documents
        WHERE created != '' AND created >= ? AND created <= ?
        ORDER BY created DESC, path ASC`,
    )
    .all(start, end) as DocumentRow[];
  return rows.map(rowToDocument);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/storage/index-db.test.ts -t getDocumentsInDateRange`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add src/storage/index-db.ts test/storage/index-db.test.ts
git commit -m "feat(index): date-range document query + created index (coverage stage 1)"
```

---

## Task 2: Extend HybridHit with coverage annotations

**Files:**
- Modify: `src/search/hybrid.ts:40-50` (the `HybridHit` interface)

- [ ] **Step 1: Add the optional fields**

In `src/search/hybrid.ts`, extend the `HybridHit` interface (after `currentSource?` at line 48):

```ts
export interface HybridHit {
  path: string;
  title: string;
  collection: string;
  status: string;
  score: number;
  bm25Score: number;
  vectorScore: number;
  snippet: string;
  decay: DecayState | null;
  currentSource?: CurrentSource; // populated by the tool handler, not the ranker
  viaCoverage?: boolean; // true when added by the coverage pass, not the ranker
  coverageReason?: "edge" | "entity-window"; // why it was added (stage 1 sets entity-window)
}
```

- [ ] **Step 2: Verify the build still compiles**

Run: `npm run build`
Expected: PASS (purely additive optional fields — no existing code breaks).

- [ ] **Step 3: Commit**

```bash
git add src/search/hybrid.ts
git commit -m "feat(search): HybridHit coverage annotations (coverage stage 1)"
```

---

## Task 3: Coverage options + shared-entity detection

**Files:**
- Create: `src/search/coverage.ts`
- Test: `test/search/coverage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/search/coverage.test.ts` (reuse the `doc()` + fixture pattern from Task 1 / `current-source.test.ts`; add a `hit()` helper):

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COVERAGE_OPTIONS, detectSharedEntity } from "../../src/search/coverage.js";
import type { HybridHit } from "../../src/search/hybrid.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import {
  type IndexDb, type IndexedDocument, insertDocument, openIndexDb,
} from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

function doc(over: Partial<IndexedDocument> & { path: string }): IndexedDocument {
  return {
    path: over.path, title: over.title ?? over.path, collection: over.collection ?? "notes",
    domain: "accumulation", status: over.status ?? "canonical", confidence: "high",
    updated: over.updated ?? "2026-05-01", tags: over.tags ?? [], content: over.content ?? "body",
    tokens: [], ttlDays: null, created: over.created ?? "2026-01-01",
    supersededBy: over.supersededBy ?? null,
  };
}
function hit(path: string): HybridHit {
  return { path, title: path, collection: "notes", status: "canonical", score: 1,
    bm25Score: 1, vectorScore: 0, snippet: "", decay: null };
}

describe("detectSharedEntity", () => {
  let vault: string; let db: IndexDb;
  beforeEach(() => { vault = makeTempVault(); const o = openIndexDb(vault, LOCAL_MINILM_DIM); if (!o.ok) throw o.error; db = o.value; });
  afterEach(() => { db.close(); cleanupVault(vault); });

  it("returns the tag shared by >=2 of the top-K seeds", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["spectral", "muon"] }));
    insertDocument(db, doc({ path: "b.md", tags: ["spectral", "optimizer"] }));
    insertDocument(db, doc({ path: "c.md", tags: ["unrelated"] }));
    expect(detectSharedEntity(db, [hit("a.md"), hit("b.md"), hit("c.md")], DEFAULT_COVERAGE_OPTIONS.seedK)).toBe("spectral");
  });

  it("returns null when no tag appears in >=2 seeds", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["x"] }));
    insertDocument(db, doc({ path: "b.md", tags: ["y"] }));
    expect(detectSharedEntity(db, [hit("a.md"), hit("b.md")], DEFAULT_COVERAGE_OPTIONS.seedK)).toBeNull();
  });

  it("breaks count ties alphabetically for determinism", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["zeta", "alpha"] }));
    insertDocument(db, doc({ path: "b.md", tags: ["zeta", "alpha"] }));
    expect(detectSharedEntity(db, [hit("a.md"), hit("b.md")], DEFAULT_COVERAGE_OPTIONS.seedK)).toBe("alpha");
  });

  it("only considers the top seedK hits", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["shared"] }));
    insertDocument(db, doc({ path: "b.md", tags: ["nope1"] })); // distinct tags so the
    insertDocument(db, doc({ path: "c.md", tags: ["nope2"] })); // top-3 form NO pair
    insertDocument(db, doc({ path: "d.md", tags: ["shared"] })); // 4th — outside seedK=3
    // Only `shared` could pair (a+d), but d is beyond seedK=3 → no >=2-seed tag → null.
    expect(detectSharedEntity(db, [hit("a.md"), hit("b.md"), hit("c.md"), hit("d.md")], 3)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/search/coverage.test.ts -t detectSharedEntity`
Expected: FAIL — module `src/search/coverage.js` does not exist.

- [ ] **Step 3: Create the module with options + detection**

Create `src/search/coverage.ts`:

```ts
// Coverage pass (Stage 1): conditionally widen vault_search results with
// same-entity docs in the seeds' date window. Pure over the index; never
// throws. Signals derive from the result set + frontmatter, never the query
// text (avoids the query-conditioning fidelity trap). Returns the hits
// unchanged when no signal fires.

import { getDocument, getDocumentsInDateRange, type IndexDb, type IndexedDocument } from "../storage/index-db.js";
import type { HybridHit } from "./hybrid.js";

export interface CoverageOptions {
  enabled: boolean;
  seedK: number; // how many top hits are seeds
  maxAdd: number; // max docs the pass may add
  padDays: number; // window pad on each side of the seed date span
  maxSpanDays: number; // hard cap on window span
  tokenCapChars: number; // backstop on combined snippet chars of added docs
}

export const DEFAULT_COVERAGE_OPTIONS: CoverageOptions = {
  enabled: true,
  seedK: 3,
  maxAdd: 5,
  padDays: 7,
  maxSpanDays: 90, // matches EDGE_HALF_LIFE_DAYS in curation/edges.ts
  tokenCapChars: 6000,
};

// The dominant frontmatter tag shared by >=2 of the top-seedK hits. Reads tags
// from the index (HybridHit carries none). Highest seed-count wins; ties break
// alphabetically. Returns null when no tag is shared by >=2 seeds — that is the
// "this is a single-fact query, stay quiet" signal.
export function detectSharedEntity(db: IndexDb, hits: HybridHit[], seedK: number): string | null {
  const counts = new Map<string, number>();
  for (const h of hits.slice(0, seedK)) {
    const d = getDocument(db, h.path);
    if (!d) continue;
    for (const tag of new Set(d.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 1; // require >=2
  for (const [tag, n] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n >= 2 && n > bestN) {
      best = tag;
      bestN = n;
    }
  }
  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/search/coverage.test.ts -t detectSharedEntity`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add src/search/coverage.ts test/search/coverage.test.ts
git commit -m "feat(coverage): options + shared-entity detection (stage 1)"
```

---

## Task 4: Date-window computation

**Files:**
- Modify: `src/search/coverage.ts`
- Test: `test/search/coverage.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/search/coverage.test.ts` (add `computeWindow` to the import):

```ts
describe("computeWindow", () => {
  let vault: string; let db: IndexDb;
  beforeEach(() => { vault = makeTempVault(); const o = openIndexDb(vault, LOCAL_MINILM_DIM); if (!o.ok) throw o.error; db = o.value; });
  afterEach(() => { db.close(); cleanupVault(vault); });

  it("spans the entity-bearing seeds' created dates padded by padDays", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["e"], created: "2026-03-10" }));
    insertDocument(db, doc({ path: "b.md", tags: ["e"], created: "2026-03-20" }));
    const w = computeWindow(db, [hit("a.md"), hit("b.md")], "e", { ...DEFAULT_COVERAGE_OPTIONS, padDays: 5 });
    expect(w).toEqual({ start: "2026-03-05", end: "2026-03-25" });
  });

  it("ignores seeds that lack the entity or a created date", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["e"], created: "2026-03-10" }));
    insertDocument(db, doc({ path: "b.md", tags: ["other"], created: "2026-09-01" }));
    const w = computeWindow(db, [hit("a.md"), hit("b.md")], "e", { ...DEFAULT_COVERAGE_OPTIONS, padDays: 0 });
    expect(w).toEqual({ start: "2026-03-10", end: "2026-03-10" });
  });

  it("clamps the window end to maxSpanDays from the start", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["e"], created: "2026-01-01" }));
    insertDocument(db, doc({ path: "b.md", tags: ["e"], created: "2026-12-01" }));
    const w = computeWindow(db, [hit("a.md"), hit("b.md")], "e", { ...DEFAULT_COVERAGE_OPTIONS, padDays: 0, maxSpanDays: 90 });
    expect(w?.start).toBe("2026-01-01");
    expect(w?.end).toBe("2026-04-01"); // 2026-01-01 + 90 days
  });

  it("returns null when no entity-bearing seed has a date", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["e"], created: "" }));
    expect(computeWindow(db, [hit("a.md")], "e", DEFAULT_COVERAGE_OPTIONS)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/search/coverage.test.ts -t computeWindow`
Expected: FAIL — `computeWindow` not exported.

- [ ] **Step 3: Implement window computation**

Append to `src/search/coverage.ts`:

```ts
export interface DateWindow {
  start: string;
  end: string;
}

// Shifts an ISO YYYY-MM-DD date by `days` (may be negative). UTC-anchored so it
// is timezone-stable.
function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The date window to gather over: the created-date span of the entity-bearing
// seeds, padded by padDays, with the end clamped to maxSpanDays from the start.
// Returns null when no entity-bearing seed carries a date.
export function computeWindow(
  db: IndexDb,
  hits: HybridHit[],
  entity: string,
  opts: CoverageOptions,
): DateWindow | null {
  const dates: string[] = [];
  for (const h of hits.slice(0, opts.seedK)) {
    const d = getDocument(db, h.path);
    if (d && d.tags.includes(entity) && d.created) dates.push(d.created);
  }
  if (dates.length === 0) return null;
  dates.sort();
  const start = shiftDays(dates[0], -opts.padDays);
  let end = shiftDays(dates[dates.length - 1], opts.padDays);
  const maxEnd = shiftDays(start, opts.maxSpanDays);
  if (end > maxEnd) end = maxEnd;
  return { start, end };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/search/coverage.test.ts -t computeWindow`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add src/search/coverage.ts test/search/coverage.test.ts
git commit -m "feat(coverage): date-window computation (stage 1)"
```

---

## Task 5: Candidate gathering + the orchestrator

**Files:**
- Modify: `src/search/coverage.ts`
- Test: `test/search/coverage.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/search/coverage.test.ts` (add `applyCoveragePass` to the import):

```ts
describe("applyCoveragePass", () => {
  let vault: string; let db: IndexDb;
  beforeEach(() => { vault = makeTempVault(); const o = openIndexDb(vault, LOCAL_MINILM_DIM); if (!o.ok) throw o.error; db = o.value; });
  afterEach(() => { db.close(); cleanupVault(vault); });

  it("returns hits unchanged when no tag is shared by >=2 seeds (quiet)", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["x"], created: "2026-03-01" }));
    insertDocument(db, doc({ path: "b.md", tags: ["y"], created: "2026-03-02" }));
    const hits = [hit("a.md"), hit("b.md")];
    expect(applyCoveragePass(db, hits, DEFAULT_COVERAGE_OPTIONS)).toEqual(hits);
  });

  it("appends same-entity in-window docs not already present, flagged viaCoverage", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["spectral"], created: "2026-03-10" }));
    insertDocument(db, doc({ path: "b.md", tags: ["spectral"], created: "2026-03-12" }));
    insertDocument(db, doc({ path: "c.md", tags: ["spectral"], created: "2026-03-11", content: "missed cluster member" }));
    const hits = [hit("a.md"), hit("b.md")];
    const out = applyCoveragePass(db, hits, DEFAULT_COVERAGE_OPTIONS);
    expect(out.map((h) => h.path)).toEqual(["a.md", "b.md", "c.md"]);
    const added = out[2];
    expect(added.viaCoverage).toBe(true);
    expect(added.coverageReason).toBe("entity-window");
    expect(added.snippet).toContain("missed cluster member");
  });

  it("excludes docs already in the result set", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["e"], created: "2026-03-10" }));
    insertDocument(db, doc({ path: "b.md", tags: ["e"], created: "2026-03-11" }));
    const out = applyCoveragePass(db, [hit("a.md"), hit("b.md")], DEFAULT_COVERAGE_OPTIONS);
    expect(out.map((h) => h.path)).toEqual(["a.md", "b.md"]); // nothing new to add → quiet
  });

  it("caps additions at maxAdd, recency-first", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["e"], created: "2026-03-01" }));
    insertDocument(db, doc({ path: "b.md", tags: ["e"], created: "2026-03-02" }));
    for (let i = 0; i < 5; i++) insertDocument(db, doc({ path: `extra-${i}.md`, tags: ["e"], created: `2026-03-1${i}` }));
    const out = applyCoveragePass(db, [hit("a.md"), hit("b.md")], { ...DEFAULT_COVERAGE_OPTIONS, maxAdd: 2 });
    const addedPaths = out.filter((h) => h.viaCoverage).map((h) => h.path);
    expect(addedPaths).toEqual(["extra-4.md", "extra-3.md"]); // two most recent
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/search/coverage.test.ts -t applyCoveragePass`
Expected: FAIL — `applyCoveragePass` not exported.

- [ ] **Step 3: Implement gathering + orchestrator + the coverage-hit builder**

Append to `src/search/coverage.ts`:

```ts
const COVERAGE_SNIPPET_MAX = 280; // mirrors current-source.ts previewSnippet

function coverageSnippet(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  return collapsed.length > COVERAGE_SNIPPET_MAX
    ? `${collapsed.slice(0, COVERAGE_SNIPPET_MAX)}…`
    : collapsed;
}

// Same-entity docs in the window, excluding ones already present, recency-first
// (current state matters), capped at maxAdd. The getDocumentsInDateRange call is
// the net-new date-range query.
function gatherCandidates(
  db: IndexDb,
  entity: string,
  window: DateWindow,
  excludePaths: Set<string>,
  opts: CoverageOptions,
): IndexedDocument[] {
  return getDocumentsInDateRange(db, window.start, window.end)
    .filter((d) => d.tags.includes(entity) && !excludePaths.has(d.path))
    .slice(0, opts.maxAdd); // already created-DESC, path-ASC from the query
}

// Builds an appended coverage hit. score 0 keeps it below ranked hits; the
// caller never re-sorts, so original relevance order is preserved.
function coverageHit(d: IndexedDocument): HybridHit {
  return {
    path: d.path,
    title: d.title,
    collection: d.collection,
    status: d.status,
    score: 0,
    bm25Score: 0,
    vectorScore: 0,
    snippet: coverageSnippet(d.content),
    decay: null,
    viaCoverage: true,
    coverageReason: "entity-window",
  };
}

// The Stage 1 coverage pass. Returns hits unchanged unless a shared entity (>=2
// seeds) + a date window + at least one new in-window same-entity doc all hold.
export function applyCoveragePass(
  db: IndexDb,
  hits: HybridHit[],
  opts: CoverageOptions = DEFAULT_COVERAGE_OPTIONS,
): HybridHit[] {
  if (!opts.enabled || hits.length < 2) return hits;
  const entity = detectSharedEntity(db, hits, opts.seedK);
  if (!entity) return hits;
  const window = computeWindow(db, hits, entity, opts);
  if (!window) return hits;
  const exclude = new Set(hits.map((h) => h.path));
  const added = gatherCandidates(db, entity, window, exclude, opts);
  if (added.length === 0) return hits;
  return [...hits, ...added.map(coverageHit)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/search/coverage.test.ts -t applyCoveragePass`
Expected: PASS (all four cases).

- [ ] **Step 5: Run the whole coverage suite + build**

Run: `npx vitest run test/search/coverage.test.ts && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/search/coverage.ts test/search/coverage.test.ts
git commit -m "feat(coverage): candidate gathering + orchestrator (stage 1)"
```

---

## Task 6: Token-cap eviction (deterministic backstop)

**Files:**
- Modify: `src/search/coverage.ts`
- Test: `test/search/coverage.test.ts`

The cap protects context if many large coverage docs are added. v1 eviction order is **stale coverage docs first** (those carrying a `currentSource` pointer, set by SP-A), **then ascending recency** (oldest coverage doc next). Original ranked hits are never evicted.

- [ ] **Step 1: Write the failing test**

Append to `test/search/coverage.test.ts` (add `enforceTokenCap` to the import; `CurrentSource` is structural so a cast is fine):

```ts
import type { CurrentSource } from "../../src/search/current-source.js";

describe("enforceTokenCap", () => {
  const STALE: CurrentSource = { kind: "resolved", path: "x.md", title: "x", snippet: "", hops: 1 };

  function cov(path: string, snippet: string, stale = false): HybridHit {
    return { path, title: path, collection: "notes", status: "canonical", score: 0,
      bm25Score: 0, vectorScore: 0, snippet, decay: null, viaCoverage: true,
      coverageReason: "entity-window", ...(stale ? { currentSource: STALE } : {}) };
  }

  it("never drops original (non-coverage) hits even over budget", () => {
    const original = { ...hit("a.md"), snippet: "x".repeat(100) };
    const out = enforceTokenCap([original], { ...DEFAULT_COVERAGE_OPTIONS, tokenCapChars: 0 });
    expect(out).toEqual([original]);
  });

  it("evicts stale coverage docs before fresh ones when over budget", () => {
    const fresh = cov("fresh.md", "y".repeat(50));
    const stale = cov("stale.md", "z".repeat(50), true);
    // budget fits only one coverage doc
    const out = enforceTokenCap([hit("a.md"), stale, fresh], { ...DEFAULT_COVERAGE_OPTIONS, tokenCapChars: 60 });
    expect(out.map((h) => h.path)).toEqual(["a.md", "fresh.md"]);
  });

  it("returns the list unchanged when under budget", () => {
    const fresh = cov("fresh.md", "short");
    const list = [hit("a.md"), fresh];
    expect(enforceTokenCap(list, DEFAULT_COVERAGE_OPTIONS)).toEqual(list);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/search/coverage.test.ts -t enforceTokenCap`
Expected: FAIL — `enforceTokenCap` not exported.

- [ ] **Step 3: Implement the cap**

Append to `src/search/coverage.ts`:

```ts
// Deterministic backstop on the combined snippet size of coverage-added docs.
// Original ranked hits are never evicted (we never displace the caller's
// top-N). Among coverage docs, evict stale first (those SP-A flagged with a
// currentSource), then oldest, until the added snippet chars fit tokenCapChars.
export function enforceTokenCap(hits: HybridHit[], opts: CoverageOptions): HybridHit[] {
  const original = hits.filter((h) => !h.viaCoverage);
  const coverage = hits.filter((h) => h.viaCoverage);
  if (coverage.length === 0) return hits;

  // Eviction priority: stale before fresh, then oldest first. The survivors are
  // taken from the opposite end. Coverage docs arrive recency-first, so index
  // order is newest→oldest; a stable sort by (fresh?0:1) puts stale last for the
  // "drop from the end" loop below.
  const ordered = [...coverage].sort((a, b) => {
    const aStale = a.currentSource ? 1 : 0;
    const bStale = b.currentSource ? 1 : 0;
    return aStale - bStale; // fresh first, stale last; stable keeps recency within group
  });

  let used = ordered.reduce((n, h) => n + h.snippet.length, 0);
  while (used > opts.tokenCapChars && ordered.length > 0) {
    const dropped = ordered.pop(); // removes the last = stalest/oldest survivor
    used -= dropped?.snippet.length ?? 0;
  }

  // Re-emit in the original arrival order, minus evicted coverage docs.
  const keep = new Set(ordered.map((h) => h.path));
  return [...original, ...coverage.filter((h) => keep.has(h.path))];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/search/coverage.test.ts -t enforceTokenCap`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add src/search/coverage.ts test/search/coverage.test.ts
git commit -m "feat(coverage): deterministic token-cap eviction (stage 1)"
```

---

## Task 7: Wire the coverage pass into vault_search

**Files:**
- Modify: `src/tools/search.ts:130-157` (inside `vaultSearch`)
- Test: `test/tools/search.test.ts`

Ordering inside `vaultSearch`: rank → RBAC filter → **coverage pass** → **RBAC filter the added docs** → currentSource enrich (suppression, runs on the widened set) → **token cap** → return.

- [ ] **Step 1: Write the failing wiring test**

Append a `describe` to `test/tools/search.test.ts`. **Do not use `makeTempVault`** here — it copies the 10-doc `sample-vault` fixture whose overlapping `pricing`/`helios` tags would make coverage fire on the quiet query and would pollute the ranked set. Build **isolated bare vaults** containing only the docs each test needs.

Two determinism guards: (1) the positive test uses `limit: 2` so only the two strong content-matches (`muon-a`, `muon-b`) are in the ranked set — `muon-c` is genuinely *outside* it, so its presence proves the coverage pass added it (in a 3-doc vault with a large limit, everything is returned and coverage would have nothing to add); (2) `muon-c`'s body deliberately does **not** contain the query terms, so the ranker won't surface it on its own.

Add these imports at the top of the file (merge with the existing `node:fs`/`node:path` imports if present):

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

Then the describe block:

```ts
// Builds a bare (non-sample) vault with only the given notes. reindex does not
// require a git repo (makeTempVault strips .git for the same reason).
function bareVault(notes: { name: string; tags: string[]; created: string; body: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "daftari-cov-"));
  mkdirSync(join(dir, "notes"), { recursive: true });
  for (const n of notes) {
    writeFileSync(
      join(dir, "notes", n.name),
      `---\ntitle: ${n.name}\ncollection: notes\ndomain: accumulation\nstatus: canonical\nconfidence: high\ncreated: ${n.created}\nupdated: ${n.created}\ntags: [${n.tags.join(", ")}]\n---\n\n${n.body}\n`,
    );
  }
  return dir;
}

describe("vault_search coverage pass", () => {
  let posVault: string; // muon-a/b match the query; muon-c shares the tag but not the terms
  let quietVault: string; // three docs, all-distinct tags → no >=2-seed pair
  beforeAll(async () => {
    posVault = bareVault([
      { name: "muon-a.md", tags: ["muon"], created: "2026-03-10", body: "muon spectral scaling laws result one" },
      { name: "muon-b.md", tags: ["muon"], created: "2026-03-12", body: "muon spectral scaling laws result two" },
      { name: "muon-c.md", tags: ["muon"], created: "2026-03-11", body: "gardening notes about tomatoes and soil" },
    ]);
    quietVault = bareVault([
      { name: "x.md", tags: ["alpha"], created: "2026-03-10", body: "research note about alpha topic" },
      { name: "y.md", tags: ["beta"], created: "2026-03-11", body: "research note about beta topic" },
      { name: "z.md", tags: ["gamma"], created: "2026-03-12", body: "research note about gamma topic" },
    ]);
    const r1 = await vaultReindex(posVault);
    if (!r1.ok) throw r1.error;
    const r2 = await vaultReindex(quietVault);
    if (!r2.ok) throw r2.error;
  }, 60_000);
  afterAll(() => { cleanupVault(posVault); cleanupVault(quietVault); });

  it("adds the same-tag in-window doc that ranking missed, flagged viaCoverage", async () => {
    // limit:2 → ranked = [muon-a, muon-b]; muon-c (same tag, in window) is added by coverage.
    const res = await vaultSearch(posVault, { query: "muon spectral scaling laws", limit: 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const added = res.value.hits.find((h) => h.path === "notes/muon-c.md");
    expect(added).toBeDefined();
    expect(added?.viaCoverage).toBe(true);
    expect(added?.coverageReason).toBe("entity-window");
  });

  it("stays quiet when the top seeds share no tag (no >=2-seed pair)", async () => {
    const res = await vaultSearch(quietVault, { query: "research note topic" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.hits.some((h) => h.viaCoverage)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools/search.test.ts -t "coverage pass"`
Expected: FAIL — added doc not present / `viaCoverage` undefined (coverage not wired yet).

- [ ] **Step 3: Wire into `vaultSearch`**

In `src/tools/search.ts`, add the import near line 11:

```ts
import { applyCoveragePass, DEFAULT_COVERAGE_OPTIONS, enforceTokenCap } from "../search/coverage.js";
```

Replace the body from the RBAC filter through the return (currently lines 139–154) with:

```ts
    // RBAC: drop hits in collections the role cannot read (only when an access
    // context is present). Enrichment then runs on the surviving hits.
    const ranked = access
      ? result.value.hits.filter((h) => canRead(access.role, h.collection))
      : result.value.hits;

    // Coverage pass: conditionally widen the ranked set with same-entity docs in
    // the seeds' date window. Quiet (returns `ranked` unchanged) when no signal
    // fires. RBAC-filter the added docs identically — a coverage pull must never
    // surface a doc the caller could not retrieve directly.
    const widened = applyCoveragePass(db, ranked, DEFAULT_COVERAGE_OPTIONS);
    const hits = access
      ? widened.filter((h) => h.viaCoverage ? canRead(access.role, h.collection) : true)
      : widened;

    // Foreground the current source for any hit (ranked OR coverage-added) that
    // points at a successor. Additive and lossless — see note below. This is the
    // suppression lever composing with the coverage recall lever.
    for (const hit of hits) {
      const cs = resolveCurrentSource(db, hit.path, access);
      if (cs) hit.currentSource = cs;
    }

    // Token-cap backstop: evict coverage-added docs (stale first, then oldest) if
    // their combined snippets exceed the budget. Never drops ranked hits.
    const capped = enforceTokenCap(hits, DEFAULT_COVERAGE_OPTIONS);

    return ok({ ...result.value, count: capped.length, hits: capped });
```

(Keep the existing `// Do NOT gate this on hit.status...` rationale comment from lines 143–148 adjacent to the `resolveCurrentSource` loop.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tools/search.test.ts -t "coverage pass"`
Expected: PASS (both cases).

- [ ] **Step 5: Run the full search + tools suites**

Run: `npx vitest run test/tools/search.test.ts test/search/coverage.test.ts`
Expected: PASS. The pre-existing `vault_search` / SP-A tests must remain green. Note: coverage may now **append** `viaCoverage` hits on the sample-vault queries (its docs share tags like `pricing`) — that is fine and the existing assertions survive it by design: coverage hits carry `score: 0` so they sort last (the `paths === sortedByScore` stable-sort assertion still holds), the pass never reorders (`hits[0]` is unchanged), and canonical coverage adds are not enriched (so the `currentSource`→status-filter assertions are unaffected). The `limit: 1` test is also safe — `applyCoveragePass` returns early when fewer than 2 seeds. If any of these unexpectedly fail, do NOT loosen them; investigate whether the append/score-0/no-reorder invariants actually hold.

- [ ] **Step 6: Commit**

```bash
git add src/tools/search.ts test/tools/search.test.ts
git commit -m "feat(search): wire coverage pass + token cap into vault_search (stage 1)"
```

---

## Task 8: Full suite + native sanity check

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS. Note: `test/search/` embedding-model tests can flake on one Node job (see `reference_ci_embedding_model_flake`); re-run `--failed` before assuming a regression.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Native sanity against the real vault (manual, advisory)**

Against `inverse-problem-vault` (the live vault; `spectral-scaling` = 7 docs):
- A multi-doc entity query (e.g. "spectral scaling") should return added hits flagged `viaCoverage: true` whose paths are the same-tag cluster members.
- A single-fact query should return NO `viaCoverage` hits (the pass stays quiet).

This is a real-corpus confirmation of the two behaviors the unit tests assert; record the observation in the eventual PR description. (Not a blocking automated test — the vault is external to the repo.)

- [ ] **Step 4: Invoke the requesting-code-review skill**

Per project convention (`feedback_adversarial_review`), run an adversarial review of the Stage 1 change before calling it done: use the superpowers:requesting-code-review skill, then address findings.

---

## Out of scope for Stage 1 (separate plans)

- **Stage 2 — edge 1-hop expansion.** Read `derives_from_edges` via `idx_edges_from`/`idx_edges_to` (a small net-new SQLite lookup — `index-db.ts` has no single-hop edge query today; do not mistake it for existing). 1-hop only, `trigger-bearing` floor, sets `coverageReason: "edge"`. Near-silent on real vaults today (2 edges), which is why it is deferred.
- **Stage 3 — measurement harness.** Offline recall@k / span-coverage on RB `questions.jsonl`; oracle re-run (`/tmp/oracle-recall.mjs`) substituting the feature's retrieval; hallucination drop toward the ~1% ceiling.
- **Config wiring.** Surface `CoverageOptions` through `.daftari/config.yaml` (`DaftariConfig` in `src/utils/config.ts`); the search path does not load config today. Stage 1 ships the options-injection seam; config plumbing is a small follow-up once defaults are validated.
