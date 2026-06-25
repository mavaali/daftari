# Q1 — Chunk-BM25 Generalization on SQuAD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure whether chunk-granularity lexical retrieval beats document-granularity on SQuAD reconstructed to article-level documents with human-authored queries — testing whether the chunk-BM25 body-dilution win generalizes beyond Recall Bench.

**Architecture:** Two ephemeral Node scripts under `integrations/recall-bench/` (no `src/` changes): an adapter that downloads SQuAD, reconstructs each article into one long multi-topic markdown doc with a **neutral** title (so neither arm gets a title shortcut), and emits labeled queries; and a runner that drives `hybridSearch` in two arms (document vs chunk granularity, lexical-only) and reports hit@k / hit@1 / MRR@10. Output is a results note.

**Tech Stack:** Node ESM (`.mjs`), global `fetch`, the built `dist/**` (`hybridSearch`, `openIndexForActiveProvider`, `reindexVault`, `getAllDocuments`). No vitest — measurement scripts with runtime guards + smoke runs, following the `chunkbm25-runner.mjs` pattern. `$0`, no LLM.

**Spec:** `docs/superpowers/specs/2026-06-24-chunk-bm25-squad-generalization-design.md`

**Key facts (verified — don't re-derive):**
- Node global `fetch` is available; SQuAD train JSON is public: `https://rajpurkar.github.io/SQuAD-explorer/dataset/train-v1.1.json` (HTTP 200). Format: `{ data: [ { title, paragraphs: [ { context, qas: [ { question, id, answers } ] } ] } ] }`. ~442 articles, ~87.6k questions.
- `CHUNK_MAX_CHARS = 800` (vector.ts:45); a multi-paragraph article ≫ 800 → many chunks/doc.
- `hybridSearch(db, q, { limit, weights:{bm25:1,vector:0}, lexicalGranularity:"document"|"chunk" })` → `{ hits:[{path}], vectorUsed:false, ... }` (lexical-only skips embedding → `vectorUsed:false`).
- Frontmatter required fields incl. enums `domain`∈{accumulation,generative}, `status`∈{draft,canonical,deprecated,superseded,archived}, `confidence`∈{low,medium,high}, `provenance`∈{direct,synthesized,inferred}. Invalid → indexed-with-defaults **and flagged** in `ReindexResult.invalidFrontmatter` → the runner asserts that count is 0.
- This branch is on `main` (body-only chunk-BM25, no #157 title/tag union). Neutral titles make #157 inert, so the measured result is version-independent. Record the measured commit.

---

## Task 1: SQuAD → article-level vault adapter

**Files:**
- Create: `integrations/recall-bench/gen-squad-vault.mjs`

- [ ] **Step 1: Write the adapter**

```js
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/Users/mihirwagle/projects/daftari";
const SQUAD_URL = "https://rajpurkar.github.io/SQuAD-explorer/dataset/train-v1.1.json";
const CACHE = "/tmp/squad/train-v1.1.json";
const VAULT = "/tmp/squad/vault";
const QFILE = "/tmp/squad/queries.jsonl";
const TARGET_QUERIES = 1500; // deterministic stride sample across all questions

mkdirSync("/tmp/squad", { recursive: true });

// Download once (cache). Fail loudly — never produce an empty vault silently.
if (!existsSync(CACHE)) {
  const res = await fetch(SQUAD_URL);
  if (!res.ok) { console.error(`SQuAD download failed: ${res.status}`); process.exit(1); }
  writeFileSync(CACHE, await res.text());
}
const squad = JSON.parse(readFileSync(CACHE, "utf8"));
const articles = squad.data;
if (!Array.isArray(articles) || articles.length === 0) { console.error("SQuAD parse empty"); process.exit(1); }

rmSync(VAULT, { recursive: true, force: true });
mkdirSync(VAULT, { recursive: true });

// One doc per article: NEUTRAL frontmatter title (no title shortcut for either
// arm); body = all the article's paragraphs (the real entity tokens the human
// queries match live here, in content_body / chunks — fair to both arms).
const allQuestions = [];
articles.forEach((art, i) => {
  const ix = String(i).padStart(4, "0");
  const path = `squad-${ix}.md`;
  const body = art.paragraphs.map((p) => p.context).join("\n\n");
  const doc = `---
title: "Article ${ix}"
domain: accumulation
collection: squad
status: canonical
confidence: high
created: 2026-01-01
updated: 2026-01-01
updated_by: "agent:squad-gen"
provenance: direct
sources: []
superseded_by: null
tags: [squad]
---

${body}
`;
  writeFileSync(join(VAULT, path), doc);
  for (const p of art.paragraphs) {
    for (const qa of p.qas) allQuestions.push({ id: qa.id, query: qa.question, relevantPath: path });
  }
});

// Deterministic stride sample (~TARGET_QUERIES spread across all articles).
const stride = Math.max(1, Math.floor(allQuestions.length / TARGET_QUERIES));
const sample = [];
for (let i = 0; i < allQuestions.length && sample.length < TARGET_QUERIES; i += stride) sample.push(allQuestions[i]);

writeFileSync(QFILE, sample.map((q) => JSON.stringify(q)).join("\n") + "\n");
console.log(`gen-squad-vault: ${articles.length} articles -> ${VAULT}, ${sample.length} queries -> ${QFILE} (of ${allQuestions.length} total)`);
```

- [ ] **Step 2: Run it**

Run: `node integrations/recall-bench/gen-squad-vault.mjs`
Expected: `gen-squad-vault: 442 articles -> /tmp/squad/vault, 1500 queries -> /tmp/squad/queries.jsonl (of ~87599 total)`.

- [ ] **Step 3: Verify the corpus is clean + multi-chunk (the dilution precondition)**

Build first (`npm run build`), then:
```bash
node -e "
const {reindexVault}=await import('./dist/search/reindex.js');
const {openIndexForActiveProvider}=await import('./dist/tools/search.js');
const {getAllDocuments}=await import('./dist/storage/index-db.js');
const r=await reindexVault('/tmp/squad/vault');
if(!r.ok){console.error('reindex failed',r.error.message);process.exit(1);}
console.log('invalidFrontmatter',r.value.invalidFrontmatter.length,'skipped',r.value.skipped.length);
const db=openIndexForActiveProvider('/tmp/squad/vault').value;
const docs=getAllDocuments(db).length;
const meanChunks=db.prepare('SELECT AVG(c) m FROM (SELECT COUNT(*) c FROM chunks GROUP BY path)').get().m;
console.log('docs',docs,'meanChunksPerDoc',Number(meanChunks).toFixed(1));
"
```
Expected: `invalidFrontmatter 0 skipped 0`; `docs 442`; `meanChunksPerDoc` well above 1 (articles are multi-paragraph → dozens of chunks). **If `invalidFrontmatter > 0`** fix the frontmatter; **if `meanChunksPerDoc ≈ 1`** the reconstruction is wrong (articles must be long/multi-topic) — the whole test depends on this.
Note: reindex embeds all chunks via local MiniLM (`$0` but a few minutes for ~17k chunks) — the measurement is lexical-only and doesn't need the vectors, but `reindexVault` builds them anyway. Acceptable one-time cost.

- [ ] **Step 4: Commit**

```bash
git add integrations/recall-bench/gen-squad-vault.mjs
git commit -m "test(recall-bench): SQuAD -> article-level vault adapter (neutral titles, labeled queries)"
```

---

## Task 2: Two-arm doc-vs-chunk runner

**Files:**
- Create: `integrations/recall-bench/squad-runner.mjs`

Reuse only the import/open pattern from `chunkbm25-runner.mjs` (read it). Metrics are single-relevant-doc hit@k / hit@1 / MRR@10 (NOT day-coverage).

- [ ] **Step 1: Write the runner**

```js
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = "/Users/mihirwagle/projects/daftari";
const VAULT = "/tmp/squad/vault";
const QFILE = "/tmp/squad/queries.jsonl";
const OUT = "/tmp/squad";
const LEX = { bm25: 1, vector: 0 };
const KS = [10, 20, 50];
const LIMIT = 50;

const { hybridSearch } = await import(`${ROOT}/dist/search/hybrid.js`);
const { openIndexForActiveProvider } = await import(`${ROOT}/dist/tools/search.js`);
const { getAllDocuments } = await import(`${ROOT}/dist/storage/index-db.js`);

const open = openIndexForActiveProvider(VAULT);
if (!open.ok) { console.error("open failed:", open.error.message); process.exit(1); }
const db = open.value;

// Dilution precondition guard: docs must be genuinely multi-chunk.
const meanChunks = Number(db.prepare("SELECT AVG(c) m FROM (SELECT COUNT(*) c FROM chunks GROUP BY path)").get().m);
if (!(meanChunks > 3)) { console.error(`mean chunks/doc = ${meanChunks} (<=3): articles not multi-topic enough; corpus invalid`); process.exit(1); }
console.log(`docs=${getAllDocuments(db).length} meanChunksPerDoc=${meanChunks.toFixed(1)}`);

const queries = readFileSync(QFILE, "utf8").split("\n").filter(Boolean).map(JSON.parse);

async function retrieve(q, granularity) {
  const res = await hybridSearch(db, q, { limit: LIMIT, weights: LEX, lexicalGranularity: granularity });
  if (!res.ok) throw new Error(res.error.message);
  if (res.value.vectorUsed !== false) throw new Error("vectorUsed not false — lexical purity broken");
  return res.value.hits;
}
const rankOf = (hits, path) => { const i = hits.findIndex((h) => h.path === path); return i < 0 ? Infinity : i + 1; };

const perQ = [];
for (const q of queries) {
  const dRank = rankOf(await retrieve(q.query, "document"), q.relevantPath);
  const cRank = rankOf(await retrieve(q.query, "chunk"), q.relevantPath);
  perQ.push({ id: q.id, dRank, cRank });
}

const arm = (key) => {
  const ranks = perQ.map((p) => p[key]);
  const hitAt = (k) => +(ranks.filter((r) => r <= k).length / ranks.length).toFixed(4);
  const hit1 = +(ranks.filter((r) => r === 1).length / ranks.length).toFixed(4);
  const mrr10 = +(ranks.reduce((s, r) => s + (r <= 10 ? 1 / r : 0), 0) / ranks.length).toFixed(4);
  return { hit1, mrr10, ...Object.fromEntries(KS.map((k) => [`hit@${k}`, hitAt(k)])) };
};
const summary = { n: perQ.length, meanChunksPerDoc: +meanChunks.toFixed(1), document: arm("dRank"), chunk: arm("cRank") };
// Ceiling check: if the document arm already aces hit@1, there's no dilution headroom (honest null, not "chunk doesn't help").
summary.ceiling = summary.document.hit1 >= 0.95 ? "NO HEADROOM (document arm already ~ceiling — result is a null, not a negative)" : "headroom present";

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/squad-perq.json`, JSON.stringify(perQ, null, 2));
writeFileSync(`${OUT}/squad-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
```

- [ ] **Step 2: Run it**

Run: `node integrations/recall-bench/squad-runner.mjs`
Expected: a summary with `document` and `chunk` each reporting `hit1`, `mrr10`, `hit@10/20/50`, plus `meanChunksPerDoc` and `ceiling`. The dilution + vectorUsed guards must pass (non-zero exit if not). Capture the full summary JSON.

Interpretation (record in Task 3, do not pre-judge): **chunk > document** on hit@k/MRR by a meaningful margin → win replicates; **document already ~ceiling** → honest null (no headroom); **chunk < document** → win is RB-structure-specific (report honestly).

- [ ] **Step 3: Commit**

```bash
git add integrations/recall-bench/squad-runner.mjs
git commit -m "test(recall-bench): SQuAD two-arm doc-vs-chunk runner (hit@k/MRR, dilution + ceiling guards)"
```

---

## Task 3: Results write-up

**Files:**
- Create: `docs/superpowers/results/2026-06-24-chunk-bm25-squad-generalization.md`

- [ ] **Step 1: Write the results doc**

Use the actual numbers from Task 2. Mirror the structure of an existing results doc on this branch — `docs/superpowers/results/2026-06-24-chunk-bm25-measurement.md` (the RB chunk-BM25 win) or `docs/superpowers/results/2026-06-23-atomization-granularity-measurement.md`. (Do NOT reference `2026-06-24-chunk-bm25-native-regression.md` — it lives on the unmerged #156 branch, not here.) Include:
- Date, links to spec + the two scripts, and the **measured commit SHA** (`git rev-parse HEAD`).
- A doc-vs-chunk table: rows = document / chunk; columns = hit@1, MRR@10, hit@10, hit@20, hit@50. Plus `meanChunksPerDoc` and the ceiling-check status.
- **Verdict** against the spec's three outcomes: replicates (chunk > doc, by how much vs RB's gap-recovery framing) / null (no headroom) / negative (RB-specific). Use the actual numbers; do not overstate.
- **Honest Assessment** carrying the spec's caveats: SQuAD questions are entity-rich → magnitude may differ from RB even if direction replicates; one corpus ≠ universal; article-level (not paragraph) qrels; recall@k not answer quality; neutral-title reconstruction strips the #157 title/tag contribution (so this isolates *body* dilution).
- What it means for the default-flip gate (Q1 is one of two gates; answer-quality still pending).

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/results/2026-06-24-chunk-bm25-squad-generalization.md
git commit -m "docs(recall-bench): SQuAD generalization results — chunk-BM25 win [replicates|null|RB-specific]"
```

---

## Final verification

- [ ] Both scripts run clean end-to-end: `node integrations/recall-bench/gen-squad-vault.mjs && node integrations/recall-bench/squad-runner.mjs`.
- [ ] Guards fired and passed: `invalidFrontmatter == 0`, `meanChunksPerDoc > 3`, `vectorUsed == false`.
- [ ] No `src/` changes (`git diff --stat main -- src/` empty) — measurement only.
- [ ] Results doc verdict matches the summary JSON; the ceiling-check status is stated; magnitude is reported honestly (not spun).

## Notes for the executor

- **Adversarial review before "done":** the failure mode is a corpus that silently invalidates the comparison — confirm the dilution guard (`meanChunksPerDoc > 3`) and the ceiling check actually fire on the real run, and that the document arm isn't trivially acing every query (which would make "chunk wins" impossible to observe — a null, report as such).
- Do NOT change any `src/` file. The result is whatever it is — a null or a negative is a valid, honest outcome and must be reported plainly (this is the external-validity test; spin would defeat its purpose).
- The SQuAD download is ~30 MB; the cache at `/tmp/squad/train-v1.1.json` avoids re-downloading on reruns.
