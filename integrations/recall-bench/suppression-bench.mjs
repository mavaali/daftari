import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// MAV-161 deterministic bench: runs the REAL vault_search (tool layer, where
// the suppression pass lives) over the gen-supersession-vault corpus, with
// the gate off then on, and reports the metrics the bead's kill condition
// turns on:
//   stale-trap queries — headInContext (the current head reaches the served
//     list), headAboveStale (no distractor-above-truth inversion),
//     contextDistractors (stale ancestors served)
//   span-guard queries — recall of unsuperseded multi-doc spans, which the
//     pass must leave untouched (the "without reducing span recall" guard)
// The hallucination arm (the primary metric per the bead) needs the LLM
// answerer/judge and stays gated on ANTHROPIC_API_KEY; these candidate sets
// are exactly what that arm consumes.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = process.env.SUPPRESS_OUT ?? "/tmp/suppression";
const VAULT = join(OUT, "vault");
const QFILE = join(OUT, "queries.jsonl");
// Two serving budgets: at 5 the head usually reaches context on its own rank
// (the inversion metric is the story); at 2 only the stale ancestors fit, so
// the pull-in half of the pass carries the whole recall load.
const LIMITS = [2, 5];

const { reindexVault } = await import(join(ROOT, "dist/search/reindex.js"));
const r = await reindexVault(VAULT);
if (!r.ok) throw new Error(`reindex failed: ${r.error.message}`);

const { vaultSearch } = await import(join(ROOT, "dist/tools/search.js"));
const { setSuppressSuperseded } = await import(join(ROOT, "dist/search/suppression.js"));

const queries = readFileSync(QFILE, "utf8").split("\n").filter(Boolean).map(JSON.parse);

async function runArm(enabled, limit) {
  setSuppressSuperseded(enabled);
  const perQ = [];
  try {
    for (const q of queries) {
      const res = await vaultSearch(VAULT, { query: q.query, limit });
      if (!res.ok) throw new Error(`search failed on ${q.id}: ${res.error.message}`);
      const paths = res.value.hits.map((h) => h.path);
      const relevantSet = new Set(q.relevant);
      const distractorSet = new Set(q.distractors);
      const headIdx = q.type === "stale-trap" ? paths.indexOf(q.relevant[0]) : -1;
      const staleIdxs = paths
        .map((p, i) => (distractorSet.has(p) ? i : -1))
        .filter((i) => i !== -1);
      perQ.push({
        id: q.id,
        type: q.type,
        recall: q.relevant.filter((p) => paths.includes(p)).length / q.relevant.length,
        headInContext: q.type === "stale-trap" ? headIdx !== -1 : null,
        headAboveStale:
          q.type === "stale-trap"
            ? headIdx !== -1 && staleIdxs.every((i) => i > headIdx)
            : null,
        contextDistractors: paths.filter((p) => distractorSet.has(p)).length,
        demotedServed: res.value.hits.filter((h) => h.demoted === "superseded").length,
        foregrounded: res.value.hits.filter((h) => h.viaForeground).length,
        served: paths.length,
      });
    }
  } finally {
    setSuppressSuperseded(false);
  }
  return perQ;
}

const arms = {};
for (const limit of LIMITS) {
  arms[limit] = { off: await runArm(false, limit), on: await runArm(true, limit) };
}

const mean = (vals) => +(vals.reduce((a, b) => a + b, 0) / (vals.length || 1)).toFixed(4);
const rate = (vals) => mean(vals.map((v) => (v ? 1 : 0)));
function summarize(perQ) {
  const traps = perQ.filter((p) => p.type === "stale-trap");
  const guards = perQ.filter((p) => p.type === "span-guard");
  return {
    staleTrap: {
      n: traps.length,
      headInContext: rate(traps.map((p) => p.headInContext)),
      headAboveStale: rate(traps.map((p) => p.headAboveStale)),
      meanContextDistractors: mean(traps.map((p) => p.contextDistractors)),
      meanForegrounded: mean(traps.map((p) => p.foregrounded)),
    },
    spanGuard: { n: guards.length, recall: mean(guards.map((p) => p.recall)) },
  };
}

const summary = {};
for (const limit of LIMITS) {
  summary[`limit${limit}`] = {
    off: summarize(arms[limit].off),
    on: summarize(arms[limit].on),
  };
  // The guard is a hard assert, not a reported number: suppression must never
  // cost unsuperseded span recall.
  const { off, on } = summary[`limit${limit}`];
  if (on.spanGuard.recall < off.spanGuard.recall)
    throw new Error(
      `SPAN-RECALL GUARD TRIPPED at limit ${limit}: on=${on.spanGuard.recall} < off=${off.spanGuard.recall}`,
    );
}

writeFileSync(join(OUT, "suppression-perq.json"), JSON.stringify(arms, null, 2));
writeFileSync(join(OUT, "suppression-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`suppression-bench: ${queries.length} queries x 2 arms x ${LIMITS.length} limits -> ${OUT}`);
