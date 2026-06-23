import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/Users/mihirwagle/projects/daftari";
const CORPUS = "/tmp/recall-review/packages/recall-bench/personas/executive-assistant/memories-180d";
const VAULT = "/tmp/cov-recall/vault";
const BASE_DATE = "2026-01-01";

if (!existsSync(CORPUS)) {
  console.error(`CORPUS missing: ${CORPUS}\nRe-clone Stevenic/recall.`);
  process.exit(1);
}

// day-N -> BASE_DATE + (N-1) days, UTC, YYYY-MM-DD
function dayDate(n) {
  const d = new Date(`${BASE_DATE}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (n - 1));
  return d.toISOString().slice(0, 10);
}
// strip a leading `--- ... ---` frontmatter block, return the body verbatim
function stripFrontmatter(text) {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

const files = readdirSync(CORPUS)
  .filter((f) => /^day-\d+\.md$/.test(f))
  .sort();
const nums = files.map((f) => Number(/day-(\d+)/.exec(f)[1])).sort((a, b) => a - b);

// Invariant assertions (the date-window depends on monotonic, contiguous, one-per-day):
if (files.length !== 180) throw new Error(`expected 180 day-files, got ${files.length}`);
for (let i = 0; i < nums.length; i++) {
  if (nums[i] !== i + 1) throw new Error(`non-contiguous day numbering at index ${i}: got ${nums[i]}`);
}
// Spot-check ONLY the base offset (NOT per-file in-body dates — body dates are often topic prose):
const day1 = readFileSync(join(CORPUS, "day-0001.md"), "utf8");
if (!day1.includes(BASE_DATE)) console.warn(`warning: day-0001 body does not mention ${BASE_DATE}; confirm BASE_DATE`);

rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, "notes"), { recursive: true });

for (const n of nums) {
  const created = dayDate(n);
  const body = stripFrontmatter(readFileSync(join(CORPUS, `day-${String(n).padStart(4, "0")}.md`), "utf8"));
  // Inert, question-orthogonal title (NOT the first prose header — that would enter FTS and perturb ranking).
  const fm =
    `---\n` +
    `title: daily log ${created}\n` +
    `domain: accumulation\n` +
    `collection: notes\n` +
    `status: canonical\n` +
    `confidence: high\n` +
    `created: ${created}\n` +
    `updated: ${created}\n` +
    `updated_by: agent:prep\n` +
    `provenance: direct\n` +
    `tags: [daily]\n` +
    `---\n\n`;
  writeFileSync(join(VAULT, "notes", `day-${String(n).padStart(4, "0")}.md`), fm + body);
}
console.log(`prep: wrote 180 docs to ${VAULT}/notes (dates ${dayDate(1)} .. ${dayDate(180)})`);

// Reindex via the built daftari pipeline.
const { reindexVault } = await import(`${ROOT}/dist/search/reindex.js`);
const r = await reindexVault(VAULT);
if (!r.ok) {
  console.error("reindex failed:", r.error.message);
  process.exit(1);
}
console.log(`prep: indexed ${r.value.documentCount} docs`);
if (r.value.documentCount !== 180) throw new Error(`indexed ${r.value.documentCount}, expected 180`);
