# Title/tag-aware chunk-BM25 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close chunk-BM25's title/tag blindness — in chunk mode, union the chunk-body BM25 with a column-restricted `{title tags}` BM25 (de-weighted so body wins ties) so chunk mode matches native title/tag-only queries without reintroducing whole-document dilution.

**Architecture:** One-file change in `src/search/hybrid.ts`. The title/tag signal reuses the existing `ftsRanking` against `documents_fts` with a **column-restricted** match string (`{title tags} : (...)`); chunk mode's lexical score becomes `unionMax(normalize(chunk-body), TITLE_TAG_WEIGHT × normalize(title/tag-only))`. No schema/reindex change; production default (`"document"`) and `relatedSearch` are untouched.

**Tech Stack:** TypeScript, better-sqlite3 (FTS5 column filters), vitest. Build `npm run build`; test `npx vitest run <file>`.

**Spec:** `docs/superpowers/specs/2026-06-24-chunk-bm25-title-tag-design.md`

**Key facts (verified — don't re-derive):**
- `documents_fts` is `fts5(title, tags, content_body, content='documents', ...)` (index-db.ts:183-184) — `title`/`tags` are separate columns, so `{title tags} : (...)` is valid column-filter syntax. Verified against the live build: `{title tags} : titletok042*` returns the doc; `{title tags} : bodytok042*` returns empty.
- `ftsRanking(db, query: string|null)` (hybrid.ts:115) runs `documents_fts MATCH ?` and returns path→best flipped-bm25 — **reuse it** with a column-restricted query string; no new ranking function needed.
- `chunkFtsRanking` (hybrid.ts:173), `normalize` (hybrid.ts:103), and the integration point `rankDocuments` (hybrid.ts:214) with the `bm25Raw`/`bm25Norm` block at **hybrid.ts:224-237**.
- `buildMatchQuery` yields a prefix-OR'd string like `t1* OR t2*` (bm25.ts:93); the column filter wraps it: `{title tags} : (t1* OR t2*)`.
- `relatedSearch` pins `lexicalGranularity:"document"` (hybrid.ts:~367); the default is `?? "document"` (hybrid.ts:~292). The chunk-mode branch only fires for explicit `"chunk"` callers.

---

## Task 1: Title/tag-aware chunk-mode lexical signal (`hybrid.ts`)

**Files:**
- Modify: `src/search/hybrid.ts`
- Test: `test/search/hybrid.test.ts`

### Step 1: Write the failing tests (title-only + tag-only)

Add a new `describe` block to `test/search/hybrid.test.ts` modeled on the existing `describe("hybrid search — chunk-level BM25 granularity", ...)` block (read it first — same `mkdtempSync`/`writeFileSync`/`reindexVault`/`openIndexDb`/`afterAll` pattern, frontmatter shape, and `LOCAL_MINILM_DIM`). Build a small vault with field-isolated unique terms:

- `titledoc.md` — frontmatter `title: "Project wintermute roadmap"` (term **wintermute** only in title), generic body with NO `wintermute`.
- `tagdoc.md` — `tags: [tagunique, native]` (term **tagunique** only in a tag), generic body.
- `bodywin.md` — body contains the term **tiebreak** in its own short paragraph (so chunk-body scores it high), generic title/tags (no `tiebreak`).
- `titlecoincidence.md` — `title: "tiebreak quarterly"` (term **tiebreak** only in the title), generic body.
- A couple of generic filler docs so retrieval isn't trivial.

**Ground-truth isolation (load-bearing for the tie-break):** each probe term must appear in EXACTLY the intended field of EXACTLY one doc — no filler/other doc may contain `wintermute`, `tagunique`, or `tiebreak` in any field. In particular `bodywin.md` must be the *only* doc whose body contains `tiebreak`, so its chunk-body match normalizes to 1.0 (the top chunk scorer); if another doc also bodied `tiebreak`, `bodywin.md`'s `chunkNorm` could fall below the 0.99 title/tag fallback and the tie-break assertion would be unsound.

Tests (all lexical-only `{bm25:1, vector:0}`, `lexicalGranularity:"chunk"`):

```ts
it("chunk mode matches a title-only term (was blind before the fix)", async () => {
  const res = await hybridSearch(ttDb, "wintermute", { weights: { bm25: 1, vector: 0 }, lexicalGranularity: "chunk" });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.value.hits[0]?.path).toBe("titledoc.md");
});

it("chunk mode matches a tag-only term", async () => {
  const res = await hybridSearch(ttDb, "tagunique", { weights: { bm25: 1, vector: 0 }, lexicalGranularity: "chunk" });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.value.hits[0]?.path).toBe("tagdoc.md");
});
```

### Step 2: Run the title/tag tests, verify they FAIL

Run: `npx vitest run test/search/hybrid.test.ts -t "title-only term"` and `-t "tag-only term"`
Expected: FAIL — chunk mode currently can't match title/tag terms, so `hits[0]` is not the expected doc (likely empty hits).

### Step 3: Implement the helpers + chunk-mode branch

In `src/search/hybrid.ts`:

(a) Add a module-level constant near `DEFAULT_WEIGHTS`:
```ts
// Body is the primary lexical signal; a title/tag-only match is a fallback that
// surfaces native title/tag retrieval (where chunk-body scores 0) but never
// outranks a full chunk-body match (1.0 > 0.99). See the chunk-mode branch in
// rankDocuments and the title/tag-aware design spec.
const TITLE_TAG_WEIGHT = 0.99;
```

(b) Add three small pure helpers (near `normalize`):
```ts
// Wraps a prefix-OR'd FTS match string in an FTS5 column filter so it matches
// only the named columns (e.g. "{title tags}"). Null query → null.
function columnRestrict(matchQuery: string | null, columns: string): string | null {
  return matchQuery === null ? null : `${columns} : (${matchQuery})`;
}

// Multiplies every score in a map by k (used to de-weight the title/tag signal).
function scale(scores: Map<string, number>, k: number): Map<string, number> {
  return new Map([...scores].map(([p, v]) => [p, v * k]));
}

// Per-document max over the union of two score maps.
function unionMax(a: Map<string, number>, b: Map<string, number>): Map<string, number> {
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, Math.max(out.get(k) ?? -Infinity, v));
  return out;
}
```

(c) In `rankDocuments`, replace the current `bm25Raw`/`bm25Norm` block (hybrid.ts:224-237 — the `const bm25Raw = ... ? chunkFtsRanking(...) : ftsRanking(...)` assignment and the later `const bm25Norm = normalize(bm25Raw);`) with a chunk-mode branch that produces `bm25Norm` directly. Keep `ftsRanking`/`chunkFtsRanking`/`normalize` as-is:

```ts
let bm25Norm: Map<string, number>;
if (opts.lexicalGranularity === "chunk") {
  // Chunk-body granularity (the dilution fix) UNIONED with a clean title/tag
  // signal (the native-shape fix). Each map is normalized to its own max=1.0
  // to reconcile the two FTS score scales (chunk corpus vs document corpus),
  // then combined per-doc by max. The title/tag map is de-weighted by
  // TITLE_TAG_WEIGHT so a coincidental single title match (which normalize()
  // inflates to 1.0) never outranks a real chunk-body match.
  const chunkNorm = normalize(chunkFtsRanking(db, matchQuery));
  const titleTagNorm = scale(
    normalize(ftsRanking(db, columnRestrict(matchQuery, "{title tags}"))),
    TITLE_TAG_WEIGHT,
  );
  bm25Norm = unionMax(chunkNorm, titleTagNorm);
} else {
  bm25Norm = normalize(ftsRanking(db, matchQuery));
}
```

Note: the `vectorRaw`/`vectorUsed`/`vectorNorm` lines stay exactly where they are; only the `bm25Raw` line and the `const bm25Norm = normalize(bm25Raw);` line are replaced by the block above. Make sure `bm25Norm` is declared before the `candidates` set that consumes it.

### Step 4: Run the title/tag tests, verify they PASS

Run: `npx vitest run test/search/hybrid.test.ts -t "title-only term"` and `-t "tag-only term"`
Expected: PASS.

### Step 5: Add the tie-break + body-no-op + dilution-preserved assertions

Add to the new describe block:

```ts
// bodywin.md is the only doc with "tiebreak" in its body → chunkNorm normalizes
// to 1.0. titlecoincidence.md has it title-only → titleTagNorm 1.0 × 0.99 = 0.99.
// 1.0 > 0.99, so body wins; the de-weight is what guarantees this isn't a tie.
it("body match wins a tie against a coincidental title-only match", async () => {
  const res = await hybridSearch(ttDb, "tiebreak", { weights: { bm25: 1, vector: 0 }, lexicalGranularity: "chunk" });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.value.hits[0]?.path).toBe("bodywin.md");                 // body is primary
  expect(res.value.hits.some((h) => h.path === "titlecoincidence.md")).toBe(true); // title still retrieved
});
```

Then confirm the existing dilution test is untouched and still passes (it asserts the multi-topic body-granularity behavior): run the whole file in Step 6. (The body-no-op property — a pure body query is unchanged by an empty title/tag union — is covered by the existing `chunk granularity ranks a diluted single-chunk topic above a decoy` test continuing to pass, since "zephyr" is body-only there.)

Run: `npx vitest run test/search/hybrid.test.ts -t "tie"`
Expected: PASS.

### Step 6: Build + full hybrid test file

Run: `npm run build && npx vitest run test/search/hybrid.test.ts`
Expected: clean compile; ALL hybrid tests pass (the new title/tag/tie tests + every pre-existing test, including the dilution and `defaults to document-granularity` no-regression tests).

### Step 7: Commit

```bash
git add src/search/hybrid.ts test/search/hybrid.test.ts
git commit -m "feat(search): title/tag-aware chunk-BM25 (column-restricted union, body-primary tie-break)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Validation — both harnesses + results note

This task runs the two existing recall-bench harnesses as the regression + win gates and records the outcome. No code change beyond the results doc.

**Files:**
- Create: `docs/superpowers/results/2026-06-24-chunk-bm25-title-tag.md`

### Step 1: Rebuild and re-index the ephemeral vaults

```bash
npm run build
# native-regression vault (regenerate if /tmp was cleared):
ls /tmp/native-regression/vault 2>/dev/null || node integrations/recall-bench/gen-native-vault.mjs
# RB vaults (regenerate per their script headers if cleared — see the chunk-BM25 measurement results doc):
ls /tmp/cov-recall/vault /tmp/cov-recall/atom-vault 2>/dev/null || echo "RB vaults missing — see integrations/recall-bench/{prep-vault,atomize-vault}.mjs"
# reindex so chunks_fts + documents_fts reflect the current build:
node -e "const {reindexVault}=await import('./dist/search/reindex.js'); for (const v of ['/tmp/native-regression/vault','/tmp/cov-recall/vault','/tmp/cov-recall/atom-vault']){try{const r=await reindexVault(v); console.log(r.ok?'reindexed '+v:'FAIL '+v+' '+r.error.message);}catch(e){console.log('skip '+v+' '+e.message);}}"
```

### Step 2: Run the native-regression gate (the fix must work)

Run: `node integrations/recall-bench/native-regression-runner.mjs`
Expected: **title and tag `chunk.hit1` jump from 0.0 to ≈ 1.0** (the document arm is the same 1.0; body stays 1.0). The validity guard (document arm hit@1 ≥ 0.99) still passes. If title/tag chunk hit@1 is NOT ≈1.0, the fix is incomplete — stop and debug before writing results.

### Step 3: Run the RB win gate (the fix must not regress the multi-topic win)

Run: `node integrations/recall-bench/chunkbm25-runner.mjs`
Expected: `gapRecovered` ≈ the prior **0.527 / 0.996 / 0.880** at K=10/20/50 (within noise). If the RB win has materially dropped, the title/tag union is interfering on multi-topic corpora — that triggers the spec's kill condition (gate or weight the title/tag contribution); stop and report rather than papering over it.

(If the RB vaults are unavailable in `/tmp` and can't be regenerated cheaply, record that the RB gate was not re-run and that the unit tests + native gate stand; flag it explicitly — do not silently skip.)

### Step 4: Write the results note

Create `docs/superpowers/results/2026-06-24-chunk-bm25-title-tag.md`. Mirror the structure of `docs/superpowers/results/2026-06-24-chunk-bm25-native-regression.md`. Include: the before/after native-regression table (title/tag 0.0 → ~1.0), the RB `gapRecovered` before/after (preserved), the verdict (title/tag blindness closed AND multi-topic win preserved → chunk mode is now a complete lossless ranker; default-flip still gated on Q1 + answer-quality), and an Honest Assessment (synthetic native corpus is worst-case; `TITLE_TAG_WEIGHT` is a fixed tie-break not a tuned blend; RB titles are non-topical so the union is near-inert there).

### Step 5: Commit

```bash
git add docs/superpowers/results/2026-06-24-chunk-bm25-title-tag.md
git commit -m "docs(recall-bench): title/tag-aware chunk-BM25 validation — gap closed, RB win preserved

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `npm run build` clean.
- [ ] `npm test` — full suite green (watch the known CI embedding-model flake; re-run `--failed` before assuming a regression).
- [ ] Production default untouched: `git grep -n "lexicalGranularity" src/` shows the option still defaults to `"document"` and is set to `"chunk"` by no tool handler; `relatedSearch` still pins `"document"`.
- [ ] Native gate: chunk title/tag hit@1 ≈ 1.0; RB gate: gapRecovered ≈ 53/99.6/88 preserved.
- [ ] Run the pre-release-assumption-audit skill before claiming done (the load-bearing assumption is "RB titles are non-topical so the union is inert on the multi-topic win" — the RB gate is what proves it; confirm it actually ran).

## Notes for the executor

- **Adversarial review before "done"** — focus on the combine: does `unionMax` ever let a de-weighted title/tag match (0.99) tie a chunk match (1.0)? It must not (0.99 < 1.0). And confirm a pure-body query is byte-identical to pre-fix chunk mode (empty title/tag map → `unionMax` no-op).
- Do NOT touch schema, `reindex`, `relatedSearch`, or the production default. If tempted, that's out of scope.
- If the RB win regresses (kill condition), STOP and report — the remedy (gate/weight the title/tag term further) is a design change, not a silent tweak.
