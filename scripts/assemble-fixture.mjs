// Assemble the final decorrelation fixture from cross-family-validated survivors.
//
// Composition: 19 derives (forward) + 10 depends (validated derivations shown
// reversed) + 22 neither (co-occurrence). Every label is gated by the
// both-families validator; the rationale cites each pair's actual blind vote
// tally as the audit trail.
//
// Reads the pool files + their .results.json, emits test/fixtures/decorrelation-fixture.json.

import { readFileSync, writeFileSync } from "node:fs";

const read = (p) => JSON.parse(readFileSync(p, "utf-8"));

const pools = {
  deriv1: { cand: read("scripts/pools/deriv-pool.json"), res: read("scripts/pools/deriv-pool.results.json") },
  deriv2: { cand: read("scripts/pools/deriv-pool-2.json"), res: read("scripts/pools/deriv-pool-2.results.json") },
  cooc1: { cand: read("scripts/pools/cooc-pool.json"), res: read("scripts/pools/cooc-pool.results.json") },
  cooc2: { cand: read("scripts/pools/cooc-pool-2.json"), res: read("scripts/pools/cooc-pool-2.results.json") },
};

const G = "openai/gpt-4o";
const M = "google/gemini-2.5-flash";

// Index results by id -> {pass, tally string}
function tallyOf(res, id, label) {
  const r = res.results.find((x) => x.id === id);
  if (!r) return { pass: false, tally: "(no result)" };
  const g = r.familyMaj[G].counts[label] ?? 0;
  const m = r.familyMaj[M].counts[label] ?? 0;
  return { pass: r.pass, tally: `gpt-4o ${g}/3 + gemini ${m}/3 confirm '${label}' (blind)` };
}

// Collect survivors with their candidate content.
function survivors(poolKey, label) {
  const { cand, res } = pools[poolKey];
  return cand
    .map((c) => ({ c, t: tallyOf(res, c.id, label ?? c.truth) }))
    .filter((x) => x.t.pass);
}

const derivSurvivors = [...survivors("deriv1", "derives"), ...survivors("deriv2", "derives")];
const coocSurvivors = [...survivors("cooc1", "neither"), ...survivors("cooc2", "neither")];

if (derivSurvivors.length < 29 || coocSurvivors.length < 22) {
  console.error(`unexpected survivor counts: deriv=${derivSurvivors.length} cooc=${coocSurvivors.length}`);
  process.exit(1);
}

// Pick 10 domain-diverse derivations to become `depends` (reversed). Spread
// across domains by taking every ~3rd after sorting by domain.
const sortedDeriv = [...derivSurvivors].sort((a, b) => a.c.domain.localeCompare(b.c.domain) || a.c.id.localeCompare(b.c.id));
const dependsPick = new Set();
for (let i = 0; i < sortedDeriv.length && dependsPick.size < 10; i += 3) dependsPick.add(sortedDeriv[i].c.id);
// top up if stride didn't reach 10
for (const s of sortedDeriv) { if (dependsPick.size >= 10) break; dependsPick.add(s.c.id); }

const edges = [];
let n = 0;
const fid = () => `f-${String(++n).padStart(3, "0")}`;

// --- derives (forward) ---
for (const { c, t } of derivSurvivors) {
  if (dependsPick.has(c.id)) continue;
  edges.push({
    id: fid(),
    fromPath: c.fromPath,
    toPath: c.toPath,
    fromContent: c.fromContent,
    toContent: c.toContent,
    truth: "derives",
    edgeClass: c.edgeClass,
    rationale:
      `DERIVES (${c.difficulty}, ${c.edgeClass}). DOC A's claim depends on DOC B as a load-bearing premise: ` +
      `if B were false, A loses its warrant; B stands without A. Cross-family gate: ${t.tally}. ` +
      `Domain: ${c.domain}. [orig ${c.id}]`,
  });
}

// --- depends (validated derivation shown reversed) ---
for (const { c, t } of derivSurvivors) {
  if (!dependsPick.has(c.id)) continue;
  edges.push({
    id: fid(),
    // REVERSED: from = premise, to = conclusion. Correct answer is 'depends'
    // (DOC B/to derives from DOC A/from).
    fromPath: c.toPath,
    toPath: c.fromPath,
    fromContent: c.toContent,
    toContent: c.fromContent,
    truth: "depends",
    rationale:
      `DEPENDS (direction probe). Presentation REVERSED vs the validated forward derivation: ` +
      `DOC A is the premise, DOC B the conclusion, so DOC B derives from DOC A -> 'depends'. ` +
      `The forward derivation was cross-family-confirmed (${t.tally} on the forward form). ` +
      `Tests whether the panel tracks direction; the reverse template should outperform forward. ` +
      `Domain: ${c.domain}. [orig ${c.id} reversed]`,
  });
}

// --- neither (co-occurrence) ---
for (const { c, t } of coocSurvivors) {
  edges.push({
    id: fid(),
    fromPath: c.fromPath,
    toPath: c.toPath,
    fromContent: c.fromContent,
    toContent: c.toContent,
    truth: "neither",
    rationale:
      `NEITHER (${c.subtype}). A and B share vocabulary/theme but neither is a load-bearing premise ` +
      `for the other — each claim stands if the other is false. Cross-family gate: ${t.tally}. ` +
      `Domain: ${c.domain}. [orig ${c.id}]`,
  });
}

const fixture = { version: 1, edges };
writeFileSync("test/fixtures/decorrelation-fixture.json", JSON.stringify(fixture, null, 2) + "\n");

const counts = edges.reduce((a, e) => ((a[e.truth] = (a[e.truth] ?? 0) + 1), a), {});
const classCounts = edges.filter((e) => e.truth === "derives").reduce((a, e) => ((a[e.edgeClass] = (a[e.edgeClass] ?? 0) + 1), a), {});
console.log(`wrote ${edges.length} edges: ${JSON.stringify(counts)}`);
console.log(`derives edge-class: ${JSON.stringify(classCounts)}`);
console.log(`depends (reversed) origs: ${[...dependsPick].join(", ")}`);
