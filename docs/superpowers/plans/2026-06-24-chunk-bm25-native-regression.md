# Chunk-BM25 Native-Shape Regression Check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quantify how much the opt-in chunk-level BM25 ranker regresses retrieval on native-daftari-shape vaults (single-topic, one-fact-per-file) due to its code-confirmed title/tag blindness, broken down by query type (body / title / tag).

**Architecture:** Two ephemeral Node scripts under `integrations/recall-bench/` (siblings to the existing runners, no `src/` changes): a deterministic generator that writes a synthetic native-shape vault + a labeled query JSONL, and a runner that drives the existing `hybridSearch` in two arms (document vs chunk granularity, lexical-only) and reports path-equality metrics per query type. Output is a results note.

**Tech Stack:** Node ESM (`.mjs`), the built `dist/**` (`hybridSearch`, `openIndexForActiveProvider`, `reindexVault`). No vitest — these are measurement scripts with built-in runtime guards + smoke runs, following the established `chunkbm25-runner.mjs` pattern. `$0`, no LLM.

**Spec:** `docs/superpowers/specs/2026-06-24-chunk-bm25-native-regression-design.md`

**Key facts (verified against the code — don't re-derive):**
- `documents_fts` indexes `(title, tags, content_body)` (index-db.ts:183-184); `chunks_fts` indexes only chunk text, and chunks are **body-only** (`const body = parsed.value.content; chunkText(body)`, reindex.ts:261-266). ⇒ chunk-BM25 cannot match a token that lives only in title/tags.
- `CHUNK_MAX_CHARS = 800` (vector.ts:45) — a doc whose body packs under 800 chars is a single chunk.
- `buildMatchQuery` prefix-matches every token (`${t}*`, bm25.ts:93). ⇒ unique tokens **must be zero-padded fixed-width** so no token is a prefix of another (`tok007` not `tok7`, else `tok7*` also matches `tok70`).
- Required frontmatter (validateFrontmatter): `title`, `domain`∈{accumulation,generative}, `collection`, `status`∈{draft,canonical,deprecated,superseded,archived}, `confidence`∈{low,medium,high}, `created`(date), `updated`(date), `updated_by`, `provenance`∈{direct,synthesized,inferred}, `tags`. Invalid frontmatter is **indexed with defaults**, not skipped — so an empty/missing field silently corrupts the corpus; the runner asserts `invalidFrontmatter.length === 0 && skipped.length === 0` from the `ReindexResult`.
- `hybridSearch(db, q, { weights:{bm25:1,vector:0}, lexicalGranularity:"document"|"chunk" })` returns `{ hits:[{path,...}], vectorUsed, ... }`. The lexical-only path now reports `vectorUsed:false` (merged in #155).

---

## Task 1: Synthetic native-shape vault generator

**Files:**
- Create: `integrations/recall-bench/gen-native-vault.mjs`

- [ ] **Step 1: Write the generator**

Deterministic (no `Math.random`/`Date.now` — those are unavailable/forbidden in some contexts and break reproducibility; derive everything from the doc index). `N = 100` docs. For doc `i` (0-based), let `ix = String(i).padStart(3, "0")` (fixed width → prefix-collision-safe under FTS `*`). Each doc gets three globally-unique, field-isolated tokens:
- title-only: `titletok${ix}` — appears ONLY in the title
- tag-only: `tagtok${ix}` — appears ONLY in a tag
- body-only: `bodytok${ix}` — appears ONLY in the body

Plus shared filler words (so the body is realistic prose, not just the token) — but keep the body well under 800 chars so it stays single-chunk. Write each doc as `native-${ix}.md`:

```js
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VAULT = "/tmp/native-regression/vault";
const QFILE = "/tmp/native-regression/queries.jsonl";
const N = 100;

rmSync("/tmp/native-regression", { recursive: true, force: true });
mkdirSync(VAULT, { recursive: true });

const queries = [];
for (let i = 0; i < N; i++) {
  const ix = String(i).padStart(3, "0");
  const titleTok = `titletok${ix}`;
  const tagTok = `tagtok${ix}`;
  const bodyTok = `bodytok${ix}`;
  const path = `native-${ix}.md`;
  // Single-topic doc: the fact is one entity. Title carries the entity handle,
  // a tag carries a classification, the body restates context. Each *-tok is
  // isolated to its field so a query for it has exactly one correct doc.
  const doc = `---
title: "Entity ${titleTok} quarterly note"
domain: accumulation
collection: native-regression
status: canonical
confidence: high
created: 2026-01-01
updated: 2026-01-01
updated_by: agent:native-regression-gen
provenance: direct
sources: []
superseded_by: null
tags: [${tagTok}, native]
---

This note records a single fact about ${bodyTok}. It captures one decision and a
short rationale, the kind of one-fact-per-file entry a native daftari vault holds.
`;
  writeFileSync(join(VAULT, path), doc);
  queries.push({ id: `q-${ix}-title`, type: "title", query: titleTok, relevantPath: path });
  queries.push({ id: `q-${ix}-tag`, type: "tag", query: tagTok, relevantPath: path });
  queries.push({ id: `q-${ix}-body`, type: "body", query: bodyTok, relevantPath: path });
}
writeFileSync(QFILE, queries.map((q) => JSON.stringify(q)).join("\n") + "\n");
console.log(`gen-native-vault: ${N} docs -> ${VAULT}, ${queries.length} queries -> ${QFILE}`);
```

- [ ] **Step 2: Run the generator**

Run: `node integrations/recall-bench/gen-native-vault.mjs`
Expected: `gen-native-vault: 100 docs -> /tmp/native-regression/vault, 300 queries -> /tmp/native-regression/queries.jsonl`

- [ ] **Step 3: Verify the corpus indexes cleanly and is single-chunk (the load-bearing premise)**

Build first if needed (`npm run build`), then:
```bash
node -e "
const {reindexVault}=await import('./dist/search/reindex.js');
const {openIndexForActiveProvider}=await import('./dist/tools/search.js');
const {getAllDocuments}=await import('./dist/storage/index-db.js');
const r=await reindexVault('/tmp/native-regression/vault');
if(!r.ok){console.error('reindex failed',r.error.message);process.exit(1);}
console.log('invalidFrontmatter',r.value.invalidFrontmatter.length,'skipped',r.value.skipped.length);
const db=openIndexForActiveProvider('/tmp/native-regression/vault').value;
const docs=getAllDocuments(db).length;
const maxChunks=db.prepare('SELECT MAX(c) m FROM (SELECT COUNT(*) c FROM chunks GROUP BY path)').get().m;
console.log('docs',docs,'maxChunksPerDoc',maxChunks);
"
```
Expected: `invalidFrontmatter 0 skipped 0`, `docs 100`, `maxChunksPerDoc 1`. **If `invalidFrontmatter > 0`** the frontmatter is wrong (fix the template — defaults would corrupt the title-arm). **If `maxChunksPerDoc > 1`** the bodies are too long (trim them) — the single-chunk native premise must hold.

- [ ] **Step 4: Commit**

```bash
git add integrations/recall-bench/gen-native-vault.mjs
git commit -m "test(recall-bench): synthetic native-shape vault generator + labeled queries"
```

---

## Task 2: Two-arm regression runner

**Files:**
- Create: `integrations/recall-bench/native-regression-runner.mjs`

Reuse only the **import/open pattern** from `chunkbm25-runner.mjs` (read it first) — NOT its `daysAtK`/`recall` helpers (RB-date-window-specific). Metrics here are path-equality.

- [ ] **Step 1: Write the runner**

```js
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = "/Users/mihirwagle/projects/daftari";
const VAULT = "/tmp/native-regression/vault";
const QFILE = "/tmp/native-regression/queries.jsonl";
const OUT = "/tmp/native-regression";
const LEX = { bm25: 1, vector: 0 };
const TYPES = ["body", "title", "tag"];

const { hybridSearch } = await import(`${ROOT}/dist/search/hybrid.js`);
const { openIndexForActiveProvider } = await import(`${ROOT}/dist/tools/search.js`);

const open = openIndexForActiveProvider(VAULT);
if (!open.ok) { console.error("open failed:", open.error.message); process.exit(1); }
const db = open.value;

const queries = readFileSync(QFILE, "utf8").split("\n").filter(Boolean).map(JSON.parse);

async function retrieve(q, granularity) {
  const res = await hybridSearch(db, q, { limit: 5, weights: LEX, lexicalGranularity: granularity });
  if (!res.ok) throw new Error(res.error.message);
  if (res.value.vectorUsed !== false) throw new Error("vectorUsed not false — lexical purity broken");
  return res.value.hits;
}

const perQ = [];
for (const q of queries) {
  const docHits = await retrieve(q.query, "document");
  const chunkHits = await retrieve(q.query, "chunk");
  perQ.push({
    ...q,
    docHit1: docHits[0]?.path === q.relevantPath,
    docHit5: docHits.slice(0, 5).some((h) => h.path === q.relevantPath),
    chunkHit1: chunkHits[0]?.path === q.relevantPath,
    chunkHit5: chunkHits.slice(0, 5).some((h) => h.path === q.relevantPath),
  });
}

const frac = (rows, key) => (rows.length ? +(rows.filter((r) => r[key]).length / rows.length).toFixed(4) : null);
const summary = { total: perQ.length, byType: {} };
for (const t of TYPES) {
  const rows = perQ.filter((r) => r.type === t);
  summary.byType[t] = {
    n: rows.length,
    document: { hit1: frac(rows, "docHit1"), hit5: frac(rows, "docHit5") },
    chunk: { hit1: frac(rows, "chunkHit1"), hit5: frac(rows, "chunkHit5") },
  };
}

// VALIDITY GUARD: the document arm indexes title+tags+body, so it MUST find every
// unique token at hit@1. If it doesn't, the corpus/queries are ambiguous (prefix
// collisions, tokenization) and the whole comparison is invalid — fail loudly.
for (const t of TYPES) {
  const d1 = summary.byType[t].document.hit1;
  if (d1 === null || d1 < 0.99) {
    console.error(`VALIDITY FAIL: document arm hit@1 on ${t} = ${d1} (< 0.99). Corpus/query ground truth is broken; numbers are invalid.`);
    process.exit(1);
  }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/native-regression-perq.json`, JSON.stringify(perQ, null, 2));
writeFileSync(`${OUT}/native-regression-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
```

- [ ] **Step 2: Run the runner**

Run: `node integrations/recall-bench/native-regression-runner.mjs`
Expected: a summary JSON with `byType.{body,title,tag}.{document,chunk}.{hit1,hit5}`. The **validity guard must pass** (document arm hit@1 ≥ 0.99 on all three types) or it exits non-zero — if it fails, fix the generator (Task 1) before trusting anything.

Predicted shape (the experiment's whole point — confirm or refute):
- `body`: document ≈ chunk, both hit1 ≈ 1.0 (single chunk holds the body token) → **safe**.
- `title` / `tag`: document hit1 ≈ 1.0, **chunk hit1 ≈ 0.0** (chunk-BM25 blind to title/tags) → **the regression, quantified**.

- [ ] **Step 3: Commit**

```bash
git add integrations/recall-bench/native-regression-runner.mjs
git commit -m "test(recall-bench): two-arm native-shape regression runner (path-equality, per query type)"
```

---

## Task 3: Results write-up

**Files:**
- Create: `docs/superpowers/results/2026-06-24-chunk-bm25-native-regression.md`

- [ ] **Step 1: Write the results doc**

Use the actual numbers from the Task 2 run. Mirror the structure of `docs/superpowers/results/2026-06-24-chunk-bm25-measurement.md`. Include:
- Date, links to the spec and the two scripts.
- A per-query-type table: rows = body / title / tag; columns = document hit@1, chunk hit@1, document hit@5, chunk hit@5.
- The **headline number**: the chunk-arm drop on title/tag queries (the regression magnitude) and the body-arm parity (the safety confirmation).
- **Verdict** against the spec's interpretation: is chunk-BM25 safe as a blanket default on native vaults, or does it need a title/tag fix? Use the actual numbers; do not overstate.
- **Honest Assessment**, carrying the spec's caveats verbatim in spirit: (1) **synthetic, worst-case** — real native vaults restate the title token in the body more often than this corpus isolates it, so the measured title/tag regression is an **upper bound**, not the expected case; (2) recall@k, not answer quality; (3) says nothing about the multi-topic *win* (the separate Q1 question).
- **Feeds:** name the follow-on fix brainstorm (title+tags pseudo-chunk vs union-with-document-BM25) and note the magnitude here should inform that choice.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/results/2026-06-24-chunk-bm25-native-regression.md
git commit -m "docs(recall-bench): native-shape regression results — chunk-BM25 title/tag blindness quantified"
```

---

## Final verification

- [ ] Both scripts run clean end-to-end: `node integrations/recall-bench/gen-native-vault.mjs && node integrations/recall-bench/native-regression-runner.mjs`.
- [ ] The validity guard passed (document arm hit@1 ≥ 0.99 on all three types) — the numbers are trustworthy.
- [ ] No `src/` changes (`git diff --stat main -- src/` is empty) — this is a measurement-only change; production code is untouched.
- [ ] Results doc verdict matches the summary JSON numbers (no overstatement; the worst-case caveat is stated).

## Notes for the executor

- **Adversarial review before "done":** the highest-risk failure is a corpus that silently invalidates the comparison — re-confirm the three guards (single-chunk, zero invalidFrontmatter, document-arm hit@1≈1.0) actually fire and pass on the real run, not just in theory.
- Do NOT change any `src/` file. If you find yourself wanting to (e.g. the ranker "should" handle title/tags), STOP — that's the follow-on fix cycle, not this one.
- Report the honest magnitude. A large title/tag regression is the *expected* result and is useful — it is not a failure of the experiment.
