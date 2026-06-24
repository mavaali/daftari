# Chunk-level BM25 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in chunk-level BM25 lexical ranker to `hybrid.ts` (collapse best-chunk-per-document, `max`), gated behind a `lexicalGranularity` option (default `"document"`), so the Stage A +6–18pp granularity lift can be measured on whole documents losslessly.

**Architecture:** Mirror the vector half. A new `chunks_fts` FTS5 external-content table over `chunks.text` (same pattern as `documents_fts`) gives per-chunk BM25; `chunkFtsRanking` MATCHes it, joins back to `chunks` on rowid, and collapses to the best chunk per document path. `rankDocuments` selects `ftsRanking` vs `chunkFtsRanking` by a new option. Prod search and `relatedSearch` stay document-level (byte-for-byte unchanged). A new recall-bench sibling runner measures three arms.

**Tech Stack:** TypeScript, Node.js, better-sqlite3 (FTS5), sqlite-vec, vitest. Build `npm run build`; test `npx vitest run <file>`.

**Spec:** `docs/superpowers/specs/2026-06-24-chunk-level-bm25-design.md`

**Conventions (read before starting):**
- No classes — functions and types only (CLAUDE.md).
- Tool handlers return `Result<T, Error>`; do not throw from handlers. The ranker functions here are internal and may return plain maps (matching `ftsRanking`).
- Tests mirror `src/` structure; every behavior gets a test.
- `.daftari/index.db` is ephemeral — rebuildable from markdown. A SCHEMA_VERSION bump triggers a full drop + reindex; never write a data migration.
- **Verify before editing:** `SCHEMA_VERSION` is currently `"6"` (src/storage/index-db.ts:51). Bump to `"7"`. The version-mismatch drop list is at index-db.ts:375-381.
- **FTS sync invariant:** `chunks_fts` stays current because every write path deletes a path's chunks *before* inserting (so `INSERT OR REPLACE` is always conflict-free) — NOT because `OR REPLACE` fires conflict triggers (it does not; `recursive_triggers` is OFF — see index-db.ts:453-458). Do not rely on conflict triggers.

---

## Task 1: Schema — `chunks_fts` table, triggers, version bump

**Files:**
- Modify: `src/storage/index-db.ts` (FTS_SCHEMA ~line 172-193; SCHEMA_VERSION line 51; drop list lines 375-381)
- Test: `test/storage/index-db.test.ts`

- [ ] **Step 1: Write the failing test — `chunks_fts` exists and tracks a doc shrink**

Add to `test/storage/index-db.test.ts`. Read the top of that file first to reuse its existing temp-vault/open helpers and imports; follow the pattern already there. The test:
1. Builds a temp vault, reindexes, opens the db.
2. Asserts a `chunks_fts` table exists in `sqlite_master`.
3. Asserts `SELECT COUNT(*) FROM chunks_fts` equals `SELECT COUNT(*) FROM chunks` (FTS row per chunk).
4. **Doc-shrinks case:** pick an indexed multi-chunk doc, overwrite its file with a single short line, reindex that doc through the real reindex path, and assert `chunks_fts` count again equals `chunks` count (no orphan FTS rows after shrink) and that a term only present in the removed text no longer MATCHes.

```ts
it("maintains chunks_fts in lockstep with chunks, including doc shrink", async () => {
  const vault = makeTempVault();
  try {
    let r = await reindexVault(vault);
    if (!r.ok) throw r.error;
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!opened.ok) throw opened.error;
    const db = opened.value;

    const tableExists = (
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='chunks_fts'").get() as { n: number }
    ).n;
    expect(tableExists).toBe(1);

    const chunkN = (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    const ftsN = (db.prepare("SELECT COUNT(*) AS n FROM chunks_fts").get() as { n: number }).n;
    expect(ftsN).toBe(chunkN);

    // doc-shrinks: rewrite a known multi-chunk doc to one short line, reindex, re-check parity.
    const rel = "pricing/helios-consumption-pricing.md"; // a substantial sample-vault doc
    writeFileSync(join(vault, rel), "---\ntitle: Helios\n---\n\nShort.\n");
    r = await reindexVault(vault);
    if (!r.ok) throw r.error;
    const chunkN2 = (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    const ftsN2 = (db.prepare("SELECT COUNT(*) AS n FROM chunks_fts").get() as { n: number }).n;
    expect(ftsN2).toBe(chunkN2);
    db.close();
  } finally {
    cleanupVault(vault);
  }
}, 60_000);
```

(Confirm `writeFileSync`, `join`, `makeTempVault`, `cleanupVault`, `reindexVault`, `openIndexDb`, `LOCAL_MINILM_DIM` are imported at the top of the test file; add any missing import.)

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `npx vitest run test/storage/index-db.test.ts -t "chunks_fts"`
Expected: FAIL — `chunks_fts` table does not exist (count 0).

- [ ] **Step 3: Add `chunks_fts` + triggers to `FTS_SCHEMA`**

In `src/storage/index-db.ts`, append to the `FTS_SCHEMA` template (after the `documents_*` triggers):

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
```

Add a comment noting `chunks_au` is defensive (no current write path UPDATEs a chunk in place) and that sync relies on delete-before-insert, not `OR REPLACE` conflict triggers.

- [ ] **Step 4: Bump SCHEMA_VERSION and extend the drop list**

- Line 51: change `const SCHEMA_VERSION = "6";` → `"7"`.
- In the version-mismatch drop block (index-db.ts:375-381), add (alongside the `documents_*` / `documents_fts` drops):

```
"DROP TRIGGER IF EXISTS chunks_ai;" +
"DROP TRIGGER IF EXISTS chunks_ad;" +
"DROP TRIGGER IF EXISTS chunks_au;" +
"DROP TABLE IF EXISTS chunks_fts;" +
```

Order matters: drop the `chunks_fts` triggers and table **before** `DROP TABLE chunks` (an external-content FTS table whose content table is dropped first can error on later writes). Place these lines immediately before the existing `"DROP TABLE IF EXISTS chunks;"`.

- [ ] **Step 5: Run the test, verify it PASSES**

Run: `npx vitest run test/storage/index-db.test.ts -t "chunks_fts"`
Expected: PASS.

- [ ] **Step 6: Run the full storage + reindex suites (no regression from the version bump)**

Run: `npx vitest run test/storage/index-db.test.ts test/search/reindex.test.ts`
Expected: PASS. (The version bump forces a clean rebuild on existing dbs — confirm nothing assumed version "6".)

- [ ] **Step 7: Commit**

```bash
git add src/storage/index-db.ts test/storage/index-db.test.ts
git commit -m "feat(index): chunks_fts FTS5 over chunk text, SCHEMA_VERSION 6->7"
```

---

## Task 2: Ranker — `chunkFtsRanking` + `lexicalGranularity` option

**Files:**
- Modify: `src/search/hybrid.ts` (add `chunkFtsRanking`; thread option through `RankOptions`/`rankDocuments`/`HybridSearchOptions`/`hybridSearch`; `relatedSearch` passes `"document"`)
- Test: `test/search/hybrid.test.ts`

- [ ] **Step 1: Write the failing test — chunk granularity surfaces a diluted topic**

Add a new `describe` block to `test/search/hybrid.test.ts` that builds its own small temp vault inline (follow the existing decay-vault sub-block in this file as the template for `mkdtempSync` + `writeFileSync` + `reindexVault` + `openIndexDb`). Construct two documents:
- `multi.md` — a long multi-topic doc where the target term (e.g. `zephyr`) appears once, in one short section, surrounded by lots of unrelated text (dilutes the whole-doc BM25 score).
- `decoy.md` — a doc that does **not** contain `zephyr` but shares many of `multi.md`'s other words (so under whole-doc scoring it competes with `multi.md`).

Assert that with `lexicalGranularity: "chunk"` and lexical-only weights, `multi.md` ranks first for query `"zephyr"`:

```ts
it("chunk granularity ranks a diluted single-chunk topic above a decoy", async () => {
  const res = await hybridSearch(db, "zephyr", {
    weights: { bm25: 1, vector: 0 },
    lexicalGranularity: "chunk",
  });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.value.hits[0]?.path).toBe("multi.md");
});
```

Design the bodies so this is a genuine test: `zephyr` must be rare enough in `multi.md` that whole-doc BM25 would otherwise bury it. (If after Step 4 the `"document"` arm happens to also rank `multi.md` first, strengthen `decoy.md` — add more shared filler — until `"document"` no longer puts `multi.md` first, so the test actually distinguishes the two rankers. Capture that distinction as a second assertion: the `"document"` arm's top hit is NOT `multi.md`.)

- [ ] **Step 2: Write the no-regression test — default option reproduces today's ordering**

In the main `describe("hybridSearch")` block (shared sample-vault `db`), add:

```ts
it("defaults to document-granularity (unchanged ordering)", async () => {
  const a = await hybridSearch(db, "Helios compute credit consumption pricing");
  const b = await hybridSearch(db, "Helios compute credit consumption pricing", {
    lexicalGranularity: "document",
  });
  expect(a.ok && b.ok).toBe(true);
  if (!a.ok || !b.ok) return;
  expect(a.value.hits.map((h) => h.path)).toEqual(b.value.hits.map((h) => h.path));
  expect(a.value.hits[0]?.path).toBe(CREDIT_DOC); // same as the existing keyword test
});
```

- [ ] **Step 3: Run both tests, verify they FAIL**

Run: `npx vitest run test/search/hybrid.test.ts -t "chunk granularity"` and `-t "defaults to document-granularity"`
Expected: the chunk-granularity test FAILS to compile/typecheck (`lexicalGranularity` not a known option); the default test may pass trivially today but will be the regression guard. Fix compile by doing Step 4.

- [ ] **Step 4: Implement `chunkFtsRanking` and thread the option**

In `src/search/hybrid.ts`, add after `ftsRanking` (and modeled on it + `vecRanking`'s collapse):

```ts
// Chunk-level lexical ranking. Runs an FTS5 MATCH over `chunks_fts` (one row
// per chunk), reads the inverse bm25 (flip to larger=better), joins back to
// `chunks` on rowid to map onto document paths, and collapses to each
// document's BEST chunk score (max) — mirroring vecRanking's best-per-doc.
// A relevant topic's own chunk scores high even when its whole document is
// long and multi-topic. Null query (no usable tokens) returns an empty map.
function chunkFtsRanking(db: IndexDb, query: string | null): Map<string, number> {
  if (query === null) return new Map();
  const rows = db
    .prepare(
      `SELECT c.path AS path, -bm25(chunks_fts) AS score
         FROM chunks_fts
         JOIN chunks AS c ON c.rowid = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY bm25(chunks_fts)`,
    )
    .all(query) as { path: string; score: number }[];
  const result = new Map<string, number>();
  for (const r of rows) {
    if (r.score <= 0) continue;
    const prev = result.get(r.path) ?? -Infinity;
    if (r.score > prev) result.set(r.path, r.score);
  }
  return result;
}
```

Add to `RankOptions`: `lexicalGranularity: "document" | "chunk";`

In `rankDocuments`, replace `const bm25Raw = ftsRanking(db, matchQuery);` with:

```ts
const bm25Raw =
  opts.lexicalGranularity === "chunk"
    ? chunkFtsRanking(db, matchQuery)
    : ftsRanking(db, matchQuery);
```

Add to `HybridSearchOptions`: `lexicalGranularity?: "document" | "chunk";`

In `hybridSearch`, read it with a default and pass through:

```ts
const lexicalGranularity = options.lexicalGranularity ?? "document";
// ...
const { hits, vectorUsed } = rankDocuments(db, matchQuery, queryEmbedding, snippetTokens, {
  weights,
  limit,
  excludePath: undefined,
  lexicalGranularity,
});
```

In `relatedSearch`, pass `lexicalGranularity: "document"` in its `rankDocuments` call (out of scope this pass — keep it explicit so the option is never `undefined` at the `RankOptions` boundary).

- [ ] **Step 5: Run the tests, verify they PASS**

Run: `npx vitest run test/search/hybrid.test.ts`
Expected: PASS (all existing hybrid tests + the two new ones).

- [ ] **Step 6: Typecheck / build**

Run: `npm run build`
Expected: clean compile (the `RankOptions.lexicalGranularity` field is required, so the compiler will catch any `rankDocuments` call site that forgot to pass it — there should be exactly two: `hybridSearch` and `relatedSearch`).

- [ ] **Step 7: Commit**

```bash
git add src/search/hybrid.ts test/search/hybrid.test.ts
git commit -m "feat(search): opt-in chunk-level BM25 ranker (lexicalGranularity)"
```

---

## Task 3: Measurement — `chunkbm25-runner.mjs` (three arms, recall@top-K)

**Files:**
- Create: `integrations/recall-bench/chunkbm25-runner.mjs` (sibling to `granularity-runner.mjs` — do NOT modify `granularity-runner.mjs`, its Stage A char-budget results must stay reproducible)
- Create (output): `docs/superpowers/results/2026-06-24-chunk-bm25-measurement.md`

This task has no unit test — it is a measurement script run against ephemeral `/tmp` vaults driving the real built `dist/`. The verification is the recorded result table.

- [ ] **Step 1: Confirm fixtures exist (regenerate if missing)**

```bash
ls /tmp/cov-recall/vault /tmp/cov-recall/atom-vault 2>/dev/null || echo "MISSING"
```
If missing, regenerate per the spec: `node integrations/recall-bench/prep-vault.mjs` (day-vault) and `node integrations/recall-bench/atomize-vault.mjs` (atom-vault); these may require re-cloning `Stevenic/recall` into `/tmp/recall-review/...memories-180d`. Read those two scripts' headers for their exact inputs before running.

- [ ] **Step 2: Rebuild so `dist/` has the new ranker; reindex the day-vault under SCHEMA_VERSION 7**

```bash
npm run build
# Force the day-vault and atom-vault indexes to rebuild at v7 so chunks_fts exists:
node -e "const {reindexVault}=await import('./dist/search/reindex.js'); for (const v of ['/tmp/cov-recall/vault','/tmp/cov-recall/atom-vault']){const r=await reindexVault(v); if(!r.ok){console.error(v,r.error.message);process.exit(1);} console.log('reindexed',v);}"
```
(The version bump 6→7 makes `openIndexForActiveProvider` drop+rebuild on next open, but an explicit reindex guarantees `chunks_fts` is populated before measuring.)

- [ ] **Step 3: Write `chunkbm25-runner.mjs`**

Model it on `granularity-runner.mjs` but compute **recall@top-K** (not char-budget) for three arms. Full script:

```js
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = "/Users/mihirwagle/projects/daftari";
const QFILE = `${ROOT}/integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl`;
const DAY_VAULT = "/tmp/cov-recall/vault";
const ATOM_VAULT = "/tmp/cov-recall/atom-vault";
const OUT = "/tmp/cov-recall";
const SMOKE = process.argv.includes("--smoke");
const KS = [10, 20, 50];
const LEX = { bm25: 1, vector: 0 };

const { hybridSearch } = await import(`${ROOT}/dist/search/hybrid.js`);
const { openIndexForActiveProvider } = await import(`${ROOT}/dist/tools/search.js`);
const { getAllDocuments } = await import(`${ROOT}/dist/storage/index-db.js`);

function openVault(path) {
  const r = openIndexForActiveProvider(path);
  if (!r.ok) { console.error(`open ${path} failed:`, r.error.message); process.exit(1); }
  return r.value;
}
const DAY = openVault(DAY_VAULT);
const ATOM = openVault(ATOM_VAULT);
const maxK = Math.max(...KS);
console.log(`vaults: day=${getAllDocuments(DAY).length} atom=${getAllDocuments(ATOM).length}`);

const dayOf = (p) => { const m = /day-(\d+)/.exec(p || ""); return m ? Number(m[1]) : null; };
const recall = (got, rel) => (rel.length ? rel.filter((d) => got.includes(d)).length / rel.length : null);
const daysAtK = (hits, K) => [...new Set(hits.slice(0, K).map((h) => dayOf(h.path)).filter((d) => d !== null))];

async function retrieve(db, q, opts) {
  const res = await hybridSearch(db, q, opts);
  if (!res.ok) throw new Error(res.error.message);
  return res.value;
}

const recs = readFileSync(QFILE, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const cases = SMOKE ? recs.slice(0, 25) : recs;

let vu = null;
const perQ = [];
for (const r of cases) {
  const q = r.qa.question;
  const rel = r.qa.relevantDays || [];
  // three arms, all lexical-only, retrieve maxK hits:
  const dayDoc = await retrieve(DAY, q, { limit: maxK, weights: LEX, lexicalGranularity: "document" });
  const dayChunk = await retrieve(DAY, q, { limit: maxK, weights: LEX, lexicalGranularity: "chunk" });
  const atom = await retrieve(ATOM, q, { limit: maxK, weights: LEX, lexicalGranularity: "document" });
  for (const v of [dayDoc.vectorUsed, dayChunk.vectorUsed, atom.vectorUsed]) {
    if (vu === null) vu = v;
    else if (v !== vu) throw new Error(`vectorUsed flipped (${vu} vs ${v}); pin provider / ensure lexical-only`);
  }
  const row = { id: r.qa.id, relLen: rel.length, rel, dayDoc: {}, dayChunk: {}, atom: {} };
  for (const K of KS) {
    row.dayDoc[K] = recall(daysAtK(dayDoc.hits, K), rel);
    row.dayChunk[K] = recall(daysAtK(dayChunk.hits, K), rel);
    row.atom[K] = recall(daysAtK(atom.hits, K), rel);
  }
  perQ.push(row);
}

const multi = perQ.filter((p) => p.relLen > 1);
const meanAt = (qset, arm, K) => {
  const v = qset.map((p) => p[arm][K]).filter((x) => x != null);
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4) : null;
};
const curve = (arm) => Object.fromEntries(KS.map((K) => [K, meanAt(multi, arm, K)]));
const summary = {
  counts: { total: perQ.length, multi: multi.length },
  vectorUsed: vu, // must be false for a clean lexical comparison
  multiDay: { dayDoc: curve("dayDoc"), dayChunk: curve("dayChunk"), atom: curve("atom") },
};
summary.gapRecovered = Object.fromEntries(KS.map((K) => {
  const floor = summary.multiDay.dayDoc[K], ceil = summary.multiDay.atom[K], got = summary.multiDay.dayChunk[K];
  const denom = ceil - floor;
  return [K, denom > 0 ? +(((got - floor) / denom)).toFixed(3) : null]; // fraction of day->atom gap recovered
}]));

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/chunkbm25-perq.json`, JSON.stringify({ ks: KS, smoke: SMOKE, perQ }, null, 2));
writeFileSync(`${OUT}/chunkbm25-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
```

- [ ] **Step 4: Smoke-run, then full run**

```bash
node integrations/recall-bench/chunkbm25-runner.mjs --smoke   # 25 Qs, sanity
node integrations/recall-bench/chunkbm25-runner.mjs           # full
```
Expected: `vectorUsed: false` in the summary (lexical-only); a `multiDay` table with `dayDoc`, `dayChunk`, `atom` curves at K=10/20/50; a `gapRecovered` fraction per K. If `vectorUsed` is `true`, the comparison is contaminated — stop and fix (ensure `weights:{bm25:1,vector:0}` is honored end-to-end).

- [ ] **Step 5: Record results + verdict**

Write `docs/superpowers/results/2026-06-24-chunk-bm25-measurement.md` with: the three-arm recall@top-K table, the `gapRecovered` fractions, the verdict against the success criterion (**day-chunk recovers most of the day→atom gap**), and an Honest Assessment (what it shows, what it does NOT — RB-only, day-level-truth confound C1 still stands, snippet/answer-quality untested). Apply the kill condition: if day-chunk lands at/near the day-doc floor, the lossless-ranker hypothesis is falsified for this corpus. Mirror the structure of `docs/superpowers/results/2026-06-23-atomization-granularity-measurement.md`.

- [ ] **Step 6: Commit**

```bash
git add integrations/recall-bench/chunkbm25-runner.mjs docs/superpowers/results/2026-06-24-chunk-bm25-measurement.md
git commit -m "test(recall-bench): chunk-BM25 three-arm recall@top-K runner + results"
```

---

## Final verification (before PR)

- [ ] `npm run build` — clean.
- [ ] `npm test` — full suite green (watch for the known CI embedding-model flake on one Node matrix job; re-run `--failed` before assuming a regression).
- [ ] Confirm prod path untouched: `git grep -n "lexicalGranularity" src/` shows it only as an optional, default-`"document"` thread through `hybrid.ts` — no tool handler (`vault_search`) sets it.
- [ ] Run the pre-release-assumption-audit skill before claiming done (happy path works; check the assumption that `chunks_fts` content-table-drop ordering and the version-bump rebuild hold on a pre-existing v6 db).

## Notes for the executor

- **Adversarial review before "done"** — run an explicit bug-hunting pass on the schema/trigger and ranker changes (the FTS-sync edge, the rowid join, the `score <= 0` guard) before calling it complete.
- The success/kill criteria live in the spec — do not soften them; report the honest magnitude (Stage A precedent: report top-K, not the inflated char-budget figure).
- This is a prototype behind a default-OFF flag; do NOT flip the default to `"chunk"` in this work — that is a separate, measurement-gated decision.
