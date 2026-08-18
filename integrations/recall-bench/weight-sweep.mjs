import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Fusion-weight sweep over the frozen corpus. Both the MAV-159 K-sweep and
// the vector-armed MAV-160 baseline found the 0.5/0.5 BM25+MiniLM fusion
// TRAILING lexical-only on multi-day recall at nearly every budget — the
// vector arm costs 0.7–2.4pp at default weights. This runner measures the
// recall curve as the fusion slides from even split to pure lexical, at the
// measured K=256 fan-out, so the weights question is answered by a curve
// instead of a hunch. Requires the embedding model (the bm25<1 arms are
// meaningless lexical-only); refuses to run without it.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const MANIFEST_PATH = join(HERE, "baseline", "manifest.json");
const CORPUS_ROOT = process.env.RB_CORPUS;
const OUT = process.env.RB_OUT ?? join(tmpdir(), "rb-weight-sweep");
const SMOKE = process.argv.includes("--smoke");
const BM25_GRID = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const BUDGETS = [0, 5, 10, 20];

if (!CORPUS_ROOT) {
  console.error(
    "RB_CORPUS is not set. Clone the pinned corpus and point RB_CORPUS at the clone root:\n" +
      "  git clone https://github.com/Stevenic/recall <dir> && RB_CORPUS=<dir> node weight-sweep.mjs",
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

// Same freeze verification as baseline-runner.mjs.
const daysDir = join(CORPUS_ROOT, manifest.corpus.daysDir);
const qaPath = join(CORPUS_ROOT, manifest.corpus.qaFile);
if (!existsSync(daysDir) || !existsSync(qaPath)) {
  console.error(`corpus paths missing under RB_CORPUS=${CORPUS_ROOT}`);
  process.exit(1);
}
const dayFiles = readdirSync(daysDir)
  .filter((f) => /^day-\d+\.md$/.test(f))
  .sort();
const daysHash = createHash("sha256");
for (const f of dayFiles) {
  daysHash.update(f);
  daysHash.update("\0");
  daysHash.update(readFileSync(join(daysDir, f)));
  daysHash.update("\0");
}
if (daysHash.digest("hex") !== manifest.corpus.daysSha256)
  throw new Error("FROZEN BASELINE VIOLATION: day-files sha256 mismatch");
if (createHash("sha256").update(readFileSync(qaPath)).digest("hex") !== manifest.corpus.qaSha256)
  throw new Error("FROZEN BASELINE VIOLATION: qa file sha256 mismatch");
console.log("freeze: corpus verified against manifest");

// Vault build, identical construction to baseline-runner.mjs.
const VAULT = join(OUT, "vault");
const BASE_DATE = manifest.vault.baseDate;
function dayDate(n) {
  const d = new Date(`${BASE_DATE}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (n - 1));
  return d.toISOString().slice(0, 10);
}
function stripFrontmatter(text) {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}
rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, manifest.vault.collection), { recursive: true });
for (const f of dayFiles) {
  const n = Number(/day-(\d+)/.exec(f)[1]);
  const created = dayDate(n);
  const body = stripFrontmatter(readFileSync(join(daysDir, f), "utf8"));
  const fm =
    `---\n` +
    `title: daily log ${created}\n` +
    `domain: accumulation\n` +
    `collection: ${manifest.vault.collection}\n` +
    `status: canonical\n` +
    `confidence: high\n` +
    `created: ${created}\n` +
    `updated: ${created}\n` +
    `updated_by: agent:weight-sweep\n` +
    `provenance: direct\n` +
    `tags: [${manifest.vault.tags.join(", ")}]\n` +
    `---\n\n`;
  writeFileSync(
    join(VAULT, manifest.vault.collection, `day-${String(n).padStart(4, "0")}.md`),
    fm + body,
  );
}

const { warmModel } = await import(join(ROOT, "dist/search/vector.js"));
const warmed = await warmModel();
if (!warmed.ok) {
  console.error(
    `weight-sweep refuses to run: the embedding model failed to load\n  (${warmed.error.message})\n` +
      "The bm25<1 arms need the vector ranker — run on a machine with the model available.",
  );
  process.exit(2);
}

const { reindexVault } = await import(join(ROOT, "dist/search/reindex.js"));
const reindexed = await reindexVault(VAULT);
if (!reindexed.ok) {
  console.error("reindex failed:", reindexed.error.message);
  process.exit(1);
}
console.log(`vault: indexed ${reindexed.value.documentCount} docs (embeddings included)`);

const { getVecKnnK, hybridSearch } = await import(join(ROOT, "dist/search/hybrid.js"));
const { openIndexForActiveProvider } = await import(join(ROOT, "dist/tools/search.js"));
const opened = openIndexForActiveProvider(VAULT);
if (!opened.ok) {
  console.error("open index failed:", opened.error.message);
  process.exit(1);
}
const DB = opened.value;

const SEED_LIMIT = manifest.retrieval.seedLimit;
const questions = readFileSync(qaPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse)
  .filter(
    (q) => q.verdict === manifest.questionFilter.verdict && (q.relevant_days ?? []).length > 0,
  );
const cases = SMOKE ? questions.slice(0, 25) : questions;

const dayOf = (p) => {
  const m = /day-(\d+)/.exec(p || "");
  return m ? Number(m[1]) : null;
};
const daysOf = (hits) => [...new Set(hits.map((h) => dayOf(h.path)).filter((x) => x !== null))];

const byWeight = {};
for (const bm25 of BM25_GRID) {
  const weights = { bm25, vector: +(1 - bm25).toFixed(2) };
  const perQ = [];
  for (const q of cases) {
    const res = await hybridSearch(DB, q.question, {
      limit: SEED_LIMIT + Math.max(...BUDGETS),
      weights,
    });
    if (!res.ok) throw new Error(`search failed on ${q.id}: ${res.error.message}`);
    const rel = q.relevant_days;
    const relevantSet = new Set(rel);
    const budgets = {};
    for (const m of BUDGETS) {
      const days = daysOf(res.value.hits.slice(0, SEED_LIMIT + m));
      budgets[m] = {
        recall: rel.filter((d) => days.includes(d)).length / rel.length,
        contextDistractors: days.filter((d) => !relevantSet.has(d)).length,
      };
    }
    perQ.push({ id: q.id, relLen: rel.length, budgets, vectorUsed: res.value.vectorUsed });
  }
  const multi = perQ.filter((p) => p.relLen > 1);
  const mean = (qset, m, key) =>
    +(qset.reduce((a, p) => a + p.budgets[m][key], 0) / qset.length).toFixed(4);
  byWeight[bm25] = {
    vectorUsed: perQ[0]?.vectorUsed ?? null,
    multiDay: Object.fromEntries(
      BUDGETS.map((m) => [
        m,
        {
          recall: mean(multi, m, "recall"),
          contextDistractors: mean(multi, m, "contextDistractors"),
        },
      ]),
    ),
  };
  console.log(`bm25=${bm25}: multi-day recall@+5 ${byWeight[bm25].multiDay[5].recall}`);
}

const summary = {
  baseline: manifest.name,
  nodeVersion: process.version,
  vecKnnK: getVecKnnK(),
  smoke: SMOKE,
  counts: { scored: cases.length, multiDay: cases.filter((q) => q.relevant_days.length > 1).length },
  bm25Grid: BM25_GRID,
  budgets: BUDGETS,
  byWeight,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "weight-sweep-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`weight-sweep: ${cases.length} questions x ${BM25_GRID.length} weights -> ${OUT}`);
