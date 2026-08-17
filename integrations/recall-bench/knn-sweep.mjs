import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// MAV-159: the recall-vs-K curve. VEC_KNN_K bounds the vector arm's chunk
// fan-out before the best-chunk-per-doc collapse; it has been 64 since the
// first release with a comment guessing that's generous. This sweep measures
// instead of guessing, on the SAME frozen corpus as baseline-runner.mjs so
// the curves are comparable. K only affects the vector arm, so the sweep
// REFUSES to run lexical-only — a container that cannot load the embedding
// model would measure nothing but noise. Run this on a machine with the
// model (or an API provider configured); embeddings are computed once at
// reindex, and K is query-time, so the sweep itself is cheap.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const MANIFEST_PATH = join(HERE, "baseline", "manifest.json");
const CORPUS_ROOT = process.env.RB_CORPUS;
const OUT = process.env.RB_OUT ?? join(tmpdir(), "rb-knn-sweep");
const SMOKE = process.argv.includes("--smoke");
const K_GRID = [16, 32, 64, 128, 256, 512];
const BUDGETS = [0, 5, 10, 20];

if (!CORPUS_ROOT) {
  console.error(
    "RB_CORPUS is not set. Clone the pinned corpus and point RB_CORPUS at the clone root:\n" +
      "  git clone https://github.com/Stevenic/recall <dir> && RB_CORPUS=<dir> node knn-sweep.mjs",
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

// Same freeze verification as baseline-runner.mjs: the sweep is only
// meaningful against the pinned corpus.
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
if (
  createHash("sha256").update(readFileSync(qaPath)).digest("hex") !== manifest.corpus.qaSha256
)
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
    `updated_by: agent:knn-sweep\n` +
    `provenance: direct\n` +
    `tags: [${manifest.vault.tags.join(", ")}]\n` +
    `---\n\n`;
  writeFileSync(join(VAULT, manifest.vault.collection, `day-${String(n).padStart(4, "0")}.md`), fm + body);
}

const { warmModel } = await import(join(ROOT, "dist/search/vector.js"));
const warmed = await warmModel();
if (!warmed.ok) {
  console.error(
    `knn-sweep refuses to run lexical-only: the embedding model failed to load\n  (${warmed.error.message})\n` +
      "K only affects the vector arm — run on a machine with the model available.",
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

const { hybridSearch, setVecKnnK } = await import(join(ROOT, "dist/search/hybrid.js"));
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
  .filter((q) => q.verdict === manifest.questionFilter.verdict && (q.relevant_days ?? []).length > 0);
const cases = SMOKE ? questions.slice(0, 25) : questions;

const dayOf = (p) => {
  const m = /day-(\d+)/.exec(p || "");
  return m ? Number(m[1]) : null;
};
const daysOf = (hits) => [...new Set(hits.map((h) => dayOf(h.path)).filter((x) => x !== null))];

const byK = {};
for (const K of K_GRID) {
  setVecKnnK(K);
  const perQ = [];
  for (const q of cases) {
    const rel = q.relevant_days;
    const res = await hybridSearch(DB, q.question, { limit: SEED_LIMIT + Math.max(...BUDGETS) });
    if (!res.ok) throw new Error(`search failed on ${q.id}: ${res.error.message}`);
    if (res.value.vectorUsed !== true)
      throw new Error("vectorUsed flipped to false mid-sweep — the model dropped out");
    const relevantSet = new Set(rel);
    const budgets = {};
    for (const m of BUDGETS) {
      const days = daysOf(res.value.hits.slice(0, SEED_LIMIT + m));
      budgets[m] = {
        recall: rel.filter((d) => days.includes(d)).length / rel.length,
        contextDistractors: days.filter((d) => !relevantSet.has(d)).length,
      };
    }
    perQ.push({ id: q.id, relLen: rel.length, budgets });
  }
  const multi = perQ.filter((p) => p.relLen > 1);
  const mean = (qset, m, key) =>
    +(qset.reduce((a, p) => a + p.budgets[m][key], 0) / qset.length).toFixed(4);
  byK[K] = {
    multiDay: Object.fromEntries(
      BUDGETS.map((m) => [
        m,
        { recall: mean(multi, m, "recall"), contextDistractors: mean(multi, m, "contextDistractors") },
      ]),
    ),
  };
  console.log(`K=${K}: multi-day recall@+5 ${byK[K].multiDay[5].recall}`);
}

const summary = {
  baseline: manifest.name,
  daftariCommit: execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim(),
  nodeVersion: process.version,
  smoke: SMOKE,
  counts: { scored: cases.length, multiDay: cases.filter((q) => q.relevant_days.length > 1).length },
  kGrid: K_GRID,
  budgets: BUDGETS,
  byK,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "knn-sweep-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`knn-sweep: ${cases.length} questions x ${K_GRID.length} K values -> ${OUT}`);
