# Atomization Granularity Measurement (Stage A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure on Recall Bench whether sub-document (per-topic atom) retrieval recovers more relevant days than whole-day retrieval at matched context budget — and whether any benefit is **lexical** (→ points at a lossless chunk-level-BM25 ranker change) or **vector** (already handled). `$0`, no LLM.

**Architecture:** Two Node ESM scripts under `integrations/recall-bench/`, importing built daftari functions from `dist/`. `atomize-vault.mjs` splits the 180 RB day-files at `###` headers into ~2,980 topic-atoms and indexes them as a daftari vault (the granularity *upper-bound probe*, not a product). `granularity-runner.mjs` retrieves over both the atom-vault and the Stage-3 day-vault, fills a char budget per question, and computes recall-vs-budget curves — for hybrid AND lexical-only ranking — to attribute the effect. Results written up with the lexical-vs-vector verdict.

**Tech Stack:** Node ESM (`.mjs`), better-sqlite3 via daftari `dist/`. One-off experiment scripts (not the typed `src/`) — verification via runtime assertions + `--smoke`, not vitest. Reuses Stage 3's `prep-vault.mjs` (day-vault) and the `dayOf` path-mapping convention.

---

## Preconditions (verify before Task 1)

- `npm run build` current (scripts import from `dist/`).
- RB corpus present: `/tmp/recall-review/packages/recall-bench/personas/executive-assistant/memories-180d/day-0001.md` … `day-0180.md`. Re-clone `Stevenic/recall` if absent.
- Stage-3 day-vault present: `/tmp/cov-recall/vault` (re-run `node integrations/recall-bench/prep-vault.mjs` if gone — Stage 3's prep is the comparison baseline).
- Questions: `integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl` (1,489 records, `qa.relevantDays`).
- Spec: `docs/superpowers/specs/2026-06-23-atomization-granularity-design.md` (read it).

## File structure

- **Create** `integrations/recall-bench/atomize-vault.mjs` — RB day-files → atom-vault (split at `###`, index). The probe.
- **Create** `integrations/recall-bench/granularity-runner.mjs` — two-vault retrieval, char-budget fill, recall curves (hybrid + lexical-only), attribution. The measurement.
- **Create** `docs/superpowers/results/2026-06-23-atomization-granularity-measurement.md` — findings (Task 4).
- Scratch atom-vault + JSON outputs under `/tmp/cov-recall/` (gitignored scratch; not committed).

Shared constants (top of each script):
```js
const ROOT = "/Users/mihirwagle/projects/daftari";
const CORPUS = "/tmp/recall-review/packages/recall-bench/personas/executive-assistant/memories-180d";
const QFILE = `${ROOT}/integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl`;
const DAY_VAULT = "/tmp/cov-recall/vault";          // from Stage 3 prep-vault.mjs
const ATOM_VAULT = "/tmp/cov-recall/atom-vault";    // built by Task 1
const OUT = "/tmp/cov-recall";
const BASE_DATE = "2026-01-01";                       // day-0001
```

---

## Task 1: Atomize the corpus → atom-vault

**Files:** Create `integrations/recall-bench/atomize-vault.mjs`

- [ ] **Step 1: Write the atomizer**

Split rule (per spec §1): boundaries are lines matching `/^(# |### )/`. A `# ` line sets the current **session** (context prefix, not its own atom); a `### ` line starts an **atom** running to the next `# `/`### ` boundary. `## ` and `#### ` lines fall *inside* the current atom (do NOT split on them).

```js
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/Users/mihirwagle/projects/daftari";
const CORPUS = "/tmp/recall-review/packages/recall-bench/personas/executive-assistant/memories-180d";
const ATOM_VAULT = "/tmp/cov-recall/atom-vault";
const BASE_DATE = "2026-01-01";

if (!existsSync(CORPUS)) { console.error(`CORPUS missing: ${CORPUS}\nRe-clone Stevenic/recall.`); process.exit(1); }

function dayDate(n) {
  const d = new Date(`${BASE_DATE}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (n - 1));
  return d.toISOString().slice(0, 10);
}
function stripFrontmatter(text) {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

// Split a day body into atoms. Returns [{ session, title, body }].
function atomize(body) {
  const lines = body.split("\n");
  const atoms = [];
  let session = "";
  let cur = null; // { title, lines: [] }
  const flush = () => { if (cur && cur.lines.join("").trim()) atoms.push({ session, title: cur.title, lines: cur.lines }); cur = null; };
  for (const line of lines) {
    if (/^# /.test(line)) { flush(); session = line.replace(/^# /, "").trim(); continue; }
    if (/^### /.test(line)) { flush(); cur = { title: line.replace(/^### /, "").trim(), lines: [line] }; continue; }
    if (cur) cur.lines.push(line);
    // text before the first ### in a session is dropped only if it's pure session preamble;
    // verified in spec: no orphan text exists between `# session:` and its first `###`.
  }
  flush();
  return atoms;
}

const files = readdirSync(CORPUS).filter((f) => /^day-\d+\.md$/.test(f)).sort();
if (files.length !== 180) throw new Error(`expected 180 day-files, got ${files.length}`);

rmSync(ATOM_VAULT, { recursive: true, force: true });
mkdirSync(join(ATOM_VAULT, "notes"), { recursive: true });

let total = 0;
const perDay = [];
for (const f of files) {
  const n = Number(/day-(\d+)/.exec(f)[1]);
  const created = dayDate(n);
  const body = stripFrontmatter(readFileSync(join(CORPUS, f), "utf8"));
  const atoms = atomize(body);
  if (atoms.length === 0) throw new Error(`day ${n} produced 0 atoms`);
  // content-conservation check: atom bodies should cover the day's ### content.
  const atomChars = atoms.reduce((s, a) => s + a.lines.join("\n").length, 0);
  const dayHashChars = body.split("\n").filter((l) => !/^# /.test(l)).join("\n").length; // body minus session lines
  perDay.push({ n, atoms: atoms.length, atomChars, dayHashChars });
  atoms.forEach((a, k) => {
    const atomBody = `## session: ${a.session}\n\n${a.lines.join("\n")}`;
    const fm =
      `---\ntitle: ${a.title.replace(/\n/g, " ").slice(0, 120)}\ndomain: accumulation\n` +
      `collection: notes\nstatus: canonical\nconfidence: high\ncreated: ${created}\n` +
      `updated: ${created}\nupdated_by: agent:atomize\nprovenance: direct\ntags: [daily]\n---\n\n`;
    writeFileSync(join(ATOM_VAULT, "notes", `day-${String(n).padStart(4, "0")}-a${String(k).padStart(2, "0")}.md`), fm + atomBody);
    total++;
  });
}
console.log(`atomize: ${total} atoms from 180 days (mean ${(total / 180).toFixed(1)}/day, min ${Math.min(...perDay.map(p=>p.atoms))}, max ${Math.max(...perDay.map(p=>p.atoms))})`);

// Conservation: every day's atom chars should be >= ~90% of its ###-section chars (prefix adds chars; nothing dropped).
const shrunk = perDay.filter((p) => p.atomChars < 0.9 * p.dayHashChars);
if (shrunk.length) console.warn(`WARN: ${shrunk.length} days lost >10% content in atomization (investigate split rule)`, shrunk.slice(0,3));

const { reindexVault } = await import(`${ROOT}/dist/search/reindex.js`);
const r = await reindexVault(ATOM_VAULT);
if (!r.ok) { console.error("reindex failed:", r.error.message); process.exit(1); }
console.log(`atomize: indexed ${r.value.documentCount} atoms`);
if (r.value.documentCount !== total) throw new Error(`indexed ${r.value.documentCount} != written ${total}`);
```

Note: the prepended context line uses `## session:` (two hashes) so it is NOT a re-split boundary and is inert vs the `# `/`### ` rule. `title` is the topic text (spec confound C2 — intended).

- [ ] **Step 2: Build + run the atomizer**

Run: `npm run build && node integrations/recall-bench/atomize-vault.mjs`
Expected: `~2980 atoms from 180 days` (mean ~16/day, min ≥3, max ~37), no conservation WARN, `indexed <N> atoms` matching the written count. (Reindex embeds ~2,980 atoms via MiniLM — up to a few minutes.)

- [ ] **Step 3: Verify the atom-vault**

Run: `node -e "import('/Users/mihirwagle/projects/daftari/dist/storage/index-db.js').then(async m=>{const {getProvider}=await import('/Users/mihirwagle/projects/daftari/dist/search/vector.js');const o=m.openIndexDb('/tmp/cov-recall/atom-vault',getProvider().dim);const d=m.getAllDocuments(o.value);console.log('atoms',d.length);const s=d.find(x=>x.path.includes('day-0001-a00'));console.log('sample path',s.path,'created',s.created,'title',JSON.stringify(s.title));console.log('day recoverable', /day-(\\\\d+)/.exec(s.path)[1]);console.log('content len',s.content.length);})"`
Expected: `atoms` ~2,980, sample path `notes/day-0001-a00.md`, `created` an ISO date, a real topic `title`, day recoverable `0001`, content length > 0.

- [ ] **Step 4: Commit**

```bash
git add integrations/recall-bench/atomize-vault.mjs
git commit -m "feat(recall-bench): atomize RB day-files into a per-topic atom-vault (granularity probe)"
```

---

## Task 2: Two-vault retrieval + char-budget recall curves

**Files:** Create `integrations/recall-bench/granularity-runner.mjs`

Key fidelity points (spec §2): char length comes from `getDocument(db, hit.path).content.length` (the indexed body — the hit object has NO `content` field, and `snippet` is truncated). Retrieval `limit` = each vault's doc count. Run hybrid AND lexical-only (`weights {bm25:1, vector:0}`).

- [ ] **Step 1: Write the runner**

```js
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = "/Users/mihirwagle/projects/daftari";
const QFILE = `${ROOT}/integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl`;
const DAY_VAULT = "/tmp/cov-recall/vault";
const ATOM_VAULT = "/tmp/cov-recall/atom-vault";
const OUT = "/tmp/cov-recall";
const SMOKE = process.argv.includes("--smoke");
// budget sweep in chars: brackets a few thousand up to ~Stage-3 top-10-days (~110k)
const BUDGETS = [2000, 4000, 8000, 16000, 32000, 64000, 110000];

const { hybridSearch } = await import(`${ROOT}/dist/search/hybrid.js`);
const { openIndexForActiveProvider } = await import(`${ROOT}/dist/tools/search.js`);
const { getDocument, getAllDocuments } = await import(`${ROOT}/dist/storage/index-db.js`);

function openVault(path) {
  const r = openIndexForActiveProvider(path);
  if (!r.ok) { console.error(`open ${path} failed:`, r.error.message); process.exit(1); }
  return r.value;
}
const DAY = openVault(DAY_VAULT);
const ATOM = openVault(ATOM_VAULT);
const dayCount = getAllDocuments(DAY).length;
const atomCount = getAllDocuments(ATOM).length;
console.log(`vaults: day=${dayCount} atom=${atomCount}`);

const dayOf = (p) => { const m = /day-(\d+)/.exec(p || ""); return m ? Number(m[1]) : null; };
const recall = (got, rel) => (rel.length ? rel.filter((d) => got.includes(d)).length / rel.length : null);

// Fill budget B (chars) by walking ranked hits, adding each doc's true body length
// until the next would exceed B. Returns the set of covered day numbers.
function fillDays(db, hits, B) {
  let used = 0; const days = new Set();
  for (const h of hits) {
    const doc = getDocument(db, h.path);
    const len = doc ? doc.content.length : 0;
    if (used + len > B) break;
    used += len;
    const d = dayOf(h.path); if (d !== null) days.add(d);
  }
  return [...days];
}

async function retrieve(db, q, limit, weights) {
  const res = await hybridSearch(db, q, weights ? { limit, weights } : { limit });
  if (!res.ok) throw new Error(res.error.message);
  return res.value;
}

const recs = readFileSync(QFILE, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const cases = SMOKE ? recs.slice(0, 25) : recs;

let vu = { hybrid: null };
const perQ = [];
for (const r of cases) {
  const q = r.qa.question, rel = r.qa.relevantDays || [];
  const row = { id: r.qa.id, relLen: rel.length, rel, day: {}, atom: {}, dayLex: {}, atomLex: {} };
  // hybrid
  const dH = await retrieve(DAY, q, dayCount);
  const aH = await retrieve(ATOM, q, atomCount);
  if (vu.hybrid === null) vu.hybrid = dH.vectorUsed;
  for (const v of [dH.vectorUsed, aH.vectorUsed]) if (v !== vu.hybrid) throw new Error(`vectorUsed flipped (${vu.hybrid} vs ${v})`);
  // lexical-only
  const dL = await retrieve(DAY, q, dayCount, { bm25: 1, vector: 0 });
  const aL = await retrieve(ATOM, q, atomCount, { bm25: 1, vector: 0 });
  for (const B of BUDGETS) {
    row.day[B] = recall(fillDays(DAY, dH.hits, B), rel);
    row.atom[B] = recall(fillDays(ATOM, aH.hits, B), rel);
    row.dayLex[B] = recall(fillDays(DAY, dL.hits, B), rel);
    row.atomLex[B] = recall(fillDays(ATOM, aL.hits, B), rel);
  }
  perQ.push(row);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/granularity-perq.json`, JSON.stringify({ vectorUsed: vu.hybrid, budgets: BUDGETS, smoke: SMOKE, perQ }, null, 2));
console.log(`granularity-runner: ${perQ.length} questions, vectorUsed=${vu.hybrid} -> ${OUT}/granularity-perq.json`);
```

- [ ] **Step 2: Smoke-run**

Run: `node integrations/recall-bench/granularity-runner.mjs --smoke`
Expected: `vaults: day=180 atom=~2980`, `25 questions, vectorUsed=true`, no `vectorUsed flipped` throw. If `vectorUsed=false`, the embedding model didn't load — fix before trusting.

- [ ] **Step 3: Add the aggregator (append to the same script, after the perQ loop)**

```js
function meanAt(qset, arm, B) {
  const v = qset.map((p) => p[arm][B]).filter((x) => x != null);
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4) : null;
}
const multi = perQ.filter((p) => p.relLen > 1);
const curve = (arm) => Object.fromEntries(BUDGETS.map((B) => [B, meanAt(multi, arm, B)]));
const summary = {
  counts: { total: perQ.length, multi: multi.length },
  vectorUsed: vu.hybrid,
  multiDay: {
    hybrid: { day: curve("day"), atom: curve("atom") },
    lexicalOnly: { day: curve("dayLex"), atom: curve("atomLex") },
  },
};
// attribution helpers: atom-minus-day gap at each budget, hybrid vs lexical
summary.gapHybrid = Object.fromEntries(BUDGETS.map((B) => [B, +(summary.multiDay.hybrid.atom[B] - summary.multiDay.hybrid.day[B]).toFixed(4)]));
summary.gapLexical = Object.fromEntries(BUDGETS.map((B) => [B, +(summary.multiDay.lexicalOnly.atom[B] - summary.multiDay.lexicalOnly.day[B]).toFixed(4)]));
writeFileSync(`${OUT}/granularity-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
```

- [ ] **Step 4: Full run (free, no LLM)**

Run: `node integrations/recall-bench/granularity-runner.mjs`
Expected: `granularity-summary.json` with multi-day `hybrid.{day,atom}` and `lexicalOnly.{day,atom}` curves, plus `gapHybrid`/`gapLexical` (atom−day) per budget. Eyeball: is `gapHybrid` positive (atom beats day)? Is the gap larger under `gapLexical` (lexical-driven) or hybrid (vector-driven)?

- [ ] **Step 5: Commit**

```bash
git add integrations/recall-bench/granularity-runner.mjs
git commit -m "feat(recall-bench): two-vault char-budget recall curves, hybrid + lexical-only (granularity stage A)"
```

---

## Task 3: Decision + deeper slices

**Files:** none (analysis only) — produces numbers for Task 4.

- [ ] **Step 1: Evaluate the gate (spec §4)**

From `granularity-summary.json`:
- **Granularity helps?** Is `gapHybrid` ≥ ~+5pp at B=110000, and does the atom curve reach the day curve's max-budget recall at a strictly smaller B? (Compare `atom` vs `day` across budgets.)
- **Lexical or vector?** Compare `gapLexical` vs `gapHybrid`. If the atom advantage is as-large-or-larger under lexical-only → **lexical-driven → points at chunk-level BM25**. If it shrinks under lexical-only → vector-side (already handled by per-chunk embeddings).

- [ ] **Step 2: Optional deeper slices (only if useful for the writeup)**

E.g. recall conditioned on `relLen`, or per-question atom-beats-day win/tie/loss at a fixed budget. Reuse the `granularity-perq.json` like Stage 3's `analyze.mjs`. Keep ephemeral (`/tmp`); not committed.

---

## Task 4: Results doc

**Files:** Create `docs/superpowers/results/2026-06-23-atomization-granularity-measurement.md`

- [ ] **Step 1: Write the findings** (per spec §5)

Include:
- The recall@budget curves: `day` vs `atom`, for hybrid AND lexical-only (multi-day).
- The **lexical-vs-vector attribution** (`gapLexical` vs `gapHybrid`) — the headline.
- The **verdict**: does sub-document granularity help; is it lexical or vector; and does it point at a **lossless chunk-level-BM25 ranker change** (the markdown-general realization) rather than header-atomization (the RB-shaped probe)?
- Confounds C1–C4 stated plainly (day-level truth / atom-title FTS / embedding-length / session-prefix).
- "Honest Assessment": what this shows and doesn't (RB only; header-atomization is the upper bound, not the product; day-level ground truth limits C1).
- If granularity helps lexically → recommend a separate spec for a chunk-level-BM25 `hybrid.ts` prototype, and note the atom-vault gave its ceiling.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/results/2026-06-23-atomization-granularity-measurement.md
git commit -m "docs(recall-bench): atomization granularity results + lexical-vs-vector verdict (stage A)"
```

---

## Out of scope (per spec)
- Building chunk-level BM25 in `hybrid.ts` (the likely product follow-on) — separate spec, motivated by this result.
- Tag-coverage / entity tags (only revisited if the benefit is neither cleanly lexical nor vector).
- Any change to shipped daftari code; any non-RB corpus.
