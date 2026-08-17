import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The MAV-160 frozen-baseline runner. Verifies the corpus against
// baseline/manifest.json (commit + content hashes — the freeze), builds the
// vault the same way prep-vault.mjs did, and records recall AND distractor
// load per arm per budget, so every child of the retrieval epic scores
// against one pinned surface instead of a fresh snapshot. Two arms:
//   rankExt  — top-(seedLimit+m) by relevance (the honest quantity baseline)
//   coverage — top-seedLimit seeds + first m date-window candidates (shipped)
// Distractor load is the deterministic half of the harness's hallucination
// scoring: the 2026-06-21 placebo showed stale co-ranked distractors are
// causally hallucinogenic, so a child that wins recall while adding
// distractors has not won. The LLM-judged hallucination arm stays gated on
// ANTHROPIC_API_KEY and reuses these same per-arm candidate sets.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const MANIFEST_PATH = join(HERE, "baseline", "manifest.json");
const CORPUS_ROOT = process.env.RB_CORPUS;
const OUT = process.env.RB_OUT ?? join(tmpdir(), "rb-baseline");
const SMOKE = process.argv.includes("--smoke");

if (!CORPUS_ROOT) {
  console.error(
    "RB_CORPUS is not set. Clone the pinned corpus and point RB_CORPUS at the clone root:\n" +
      "  git clone https://github.com/Stevenic/recall <dir> && RB_CORPUS=<dir> node baseline-runner.mjs",
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const manifestSha256 = createHash("sha256").update(readFileSync(MANIFEST_PATH)).digest("hex");

// --- the freeze: corpus must match the manifest byte-for-byte ---------------

const daysDir = join(CORPUS_ROOT, manifest.corpus.daysDir);
const qaPath = join(CORPUS_ROOT, manifest.corpus.qaFile);
if (!existsSync(daysDir) || !existsSync(qaPath)) {
  console.error(`corpus paths missing under RB_CORPUS=${CORPUS_ROOT}`);
  process.exit(1);
}

const dayFiles = readdirSync(daysDir)
  .filter((f) => /^day-\d+\.md$/.test(f))
  .sort();
if (dayFiles.length !== manifest.corpus.daysCount)
  throw new Error(`day-file count ${dayFiles.length} != pinned ${manifest.corpus.daysCount}`);
const daysHash = createHash("sha256");
for (const f of dayFiles) {
  daysHash.update(f);
  daysHash.update("\0");
  daysHash.update(readFileSync(join(daysDir, f)));
  daysHash.update("\0");
}
const daysSha256 = daysHash.digest("hex");
const qaSha256 = createHash("sha256").update(readFileSync(qaPath)).digest("hex");
for (const [got, want, what] of [
  [daysSha256, manifest.corpus.daysSha256, "day-files"],
  [qaSha256, manifest.corpus.qaSha256, "qa file"],
]) {
  if (got !== want)
    throw new Error(`FROZEN BASELINE VIOLATION: ${what} sha256 ${got} != pinned ${want}`);
}
let corpusCommit = null;
try {
  corpusCommit = execSync("git rev-parse HEAD", { cwd: CORPUS_ROOT }).toString().trim();
} catch {
  // A corpus exported without .git still verifies via the content hashes.
}
if (corpusCommit && corpusCommit !== manifest.corpus.commit)
  console.warn(
    `warning: corpus commit ${corpusCommit} != pinned ${manifest.corpus.commit} (content hashes match, so the pinned files are unchanged)`,
  );
console.log("freeze: corpus verified against manifest");

// --- build the vault (same construction as prep-vault.mjs) ------------------

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
    `updated_by: agent:baseline\n` +
    `provenance: direct\n` +
    `tags: [${manifest.vault.tags.join(", ")}]\n` +
    `---\n\n`;
  writeFileSync(join(VAULT, manifest.vault.collection, `day-${String(n).padStart(4, "0")}.md`), fm + body);
}

const { reindexVault } = await import(join(ROOT, "dist/search/reindex.js"));
const reindexed = await reindexVault(VAULT);
if (!reindexed.ok) {
  console.error("reindex failed:", reindexed.error.message);
  process.exit(1);
}
if (reindexed.value.documentCount !== manifest.corpus.daysCount)
  throw new Error(`indexed ${reindexed.value.documentCount}, expected ${manifest.corpus.daysCount}`);
console.log(`vault: indexed ${reindexed.value.documentCount} docs`);

// --- retrieval sweep ---------------------------------------------------------

const { hybridSearch } = await import(join(ROOT, "dist/search/hybrid.js"));
const { applyCoveragePass, DEFAULT_COVERAGE_OPTIONS } = await import(
  join(ROOT, "dist/search/coverage.js")
);
const { openIndexForActiveProvider } = await import(join(ROOT, "dist/tools/search.js"));

const opened = openIndexForActiveProvider(VAULT);
if (!opened.ok) {
  console.error("open index failed:", opened.error.message);
  process.exit(1);
}
const DB = opened.value;

const SEED_LIMIT = manifest.retrieval.seedLimit;
const BUDGETS = manifest.retrieval.budgets;
const questionsAll = readFileSync(qaPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);
const questions = questionsAll.filter((q) => q.verdict === manifest.questionFilter.verdict);
const cases = SMOKE ? questions.slice(0, 25) : questions;

const dayOf = (p) => {
  const m = /day-(\d+)/.exec(p || "");
  return m ? Number(m[1]) : null;
};
const daysOf = (hits) => [...new Set(hits.map((h) => dayOf(h.path)).filter((x) => x !== null))];
const recallOf = (got, rel) => (rel.length ? rel.filter((d) => got.includes(d)).length / rel.length : null);

// Per arm at budget m: recall over relevant_days, plus the distractor half —
// how many docs the arm put in front of the answerer that are NOT relevant.
// addedDistractors isolates what the widening mechanism itself added.
function armMetrics(days, addedDays, rel) {
  const relevantSet = new Set(rel);
  const distractors = days.filter((d) => !relevantSet.has(d)).length;
  const addedRelevant = addedDays.filter((d) => relevantSet.has(d)).length;
  return {
    recall: recallOf(days, rel),
    contextDistractors: distractors,
    addedRelevant,
    addedDistractors: addedDays.length - addedRelevant,
    addedPrecision: addedDays.length ? +(addedRelevant / addedDays.length).toFixed(4) : null,
  };
}

let vectorUsed = null;
let faithChecked = false;
const perQ = [];
for (const q of cases) {
  const rel = q.relevant_days ?? [];
  const res = await hybridSearch(DB, q.question, { limit: manifest.retrieval.sweepLimit });
  if (!res.ok) throw new Error(`search failed on ${q.id}: ${res.error.message}`);
  if (vectorUsed === null) vectorUsed = res.value.vectorUsed;
  else if (vectorUsed !== res.value.vectorUsed)
    throw new Error(`vectorUsed flipped mid-run (${vectorUsed} -> ${res.value.vectorUsed})`);

  const ranked = res.value.hits;
  const seeds = ranked.slice(0, SEED_LIMIT);
  const widened = applyCoveragePass(DB, seeds, { ...DEFAULT_COVERAGE_OPTIONS, maxAdd: 1e9 });
  const covAdded = widened.filter((h) => h.viaCoverage);
  if (!faithChecked) {
    // Slicing the uncapped candidate list must equal the real feature at its
    // shipped cap, or the sweep is measuring something the product doesn't do.
    const real5 = applyCoveragePass(DB, seeds, { ...DEFAULT_COVERAGE_OPTIONS })
      .filter((h) => h.viaCoverage)
      .map((h) => h.path);
    const sliced5 = covAdded.slice(0, DEFAULT_COVERAGE_OPTIONS.maxAdd).map((h) => h.path);
    if (JSON.stringify(real5) !== JSON.stringify(sliced5))
      throw new Error("faithfulness FAIL: sliced coverage != applyCoveragePass at shipped cap");
    faithChecked = true;
  }

  const seedDays = daysOf(seeds);
  const budgets = {};
  for (const m of BUDGETS) {
    const rxDays = daysOf(ranked.slice(0, SEED_LIMIT + m));
    const rxAddedDays = rxDays.filter((d) => !seedDays.includes(d));
    const covAddedDays = daysOf(covAdded.slice(0, m));
    const covDays = [...new Set([...seedDays, ...covAddedDays])];
    budgets[m] = {
      rankExt: armMetrics(rxDays, rxAddedDays, rel),
      coverage: armMetrics(covDays, covAddedDays.filter((d) => !seedDays.includes(d)), rel),
    };
  }
  perQ.push({
    id: q.id,
    category: q.category,
    difficulty: q.difficulty,
    relLen: rel.length,
    rel,
    seedDays,
    budgets,
  });
}

// --- summary -----------------------------------------------------------------

function meanCurve(qset, arm, key) {
  const out = {};
  for (const m of BUDGETS) {
    const vals = qset.map((p) => p.budgets[m][arm][key]).filter((x) => x != null);
    out[m] = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4) : null;
  }
  return out;
}
const scored = perQ.filter((p) => p.relLen > 0);
const multi = scored.filter((p) => p.relLen > 1);
const single = scored.filter((p) => p.relLen === 1);
const summarize = (qset) => ({
  n: qset.length,
  rankExt: { recall: meanCurve(qset, "rankExt", "recall"), addedDistractors: meanCurve(qset, "rankExt", "addedDistractors"), addedPrecision: meanCurve(qset, "rankExt", "addedPrecision") },
  coverage: { recall: meanCurve(qset, "coverage", "recall"), addedDistractors: meanCurve(qset, "coverage", "addedDistractors"), addedPrecision: meanCurve(qset, "coverage", "addedPrecision") },
});

const summary = {
  baseline: manifest.name,
  manifestSha256,
  daftariCommit: execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim(),
  corpusCommit,
  nodeVersion: process.version,
  vectorUsed,
  smoke: SMOKE,
  counts: {
    qaTotal: questionsAll.length,
    answerable: questions.length,
    scored: scored.length,
    negativeRecallExcluded: perQ.length - scored.length,
    multiDay: multi.length,
    singleDay: single.length,
  },
  multiDay: summarize(multi),
  singleDay: summarize(single),
  all: summarize(scored),
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "baseline-perq.json"), JSON.stringify({ summaryRef: manifest.name, perQ }, null, 2));
writeFileSync(join(OUT, "baseline-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`baseline-runner: ${perQ.length} questions -> ${OUT}`);
