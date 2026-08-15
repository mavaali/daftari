// Assemble v2-core fixture: the cross-family-validated derives + neither classes
// (contamination-free synthetic domains + Daftari/novel). The directional classes
// (depends/symmetric) are deliberately EXCLUDED — the v2 build found they cannot be
// cross-family-validated (gemini is direction-blind, systematically inverting
// derives/depends), so they require labeler adjudication and are a pending decision.
//
// Output: test/fixtures/decorrelation-fixture-v2.json (v1 preserved for provenance).

import { readFileSync, writeFileSync } from "node:fs";
const read = (p) => JSON.parse(readFileSync(p, "utf-8"));
const G = "openai/gpt-4o";
const M = "google/gemini-2.5-flash";

const sources = [
  { cand: "scripts/pools/v2/deriv-pool-v2.json", res: "scripts/pools/v2/deriv-pool-v2.results.json", truth: "derives" },
  { cand: "scripts/pools/v2/cooc-pool-v2.json", res: "scripts/pools/v2/cooc-pool-v2.results.json", truth: "neither" },
  { cand: "scripts/pools/v2/trap-pool-v2.json", res: "scripts/pools/v2/trap-pool-v2.results.json", truth: "neither" },
];

function tally(res, id, label) {
  const r = res.results.find((x) => x.id === id);
  const g = r.familyMaj[G].counts[label] ?? 0;
  const m = r.familyMaj[M].counts[label] ?? 0;
  return { pass: r.pass, s: `gpt-4o ${g}/3 + gemini ${m}/3 confirm '${label}' (blind)` };
}

const edges = [];
let n = 0;
const fid = () => `v2-${String(++n).padStart(3, "0")}`;

for (const src of sources) {
  const cand = read(src.cand);
  const res = read(src.res);
  for (const c of cand) {
    const t = tally(res, c.id, src.truth);
    if (!t.pass) continue;
    const isTrap = c.id.startsWith("tr-");
    const contamNote = /synthetic/.test(c.domain)
      ? "contamination-free (invented self-consistent domain — the model must reason, cannot recall)"
      : c.domain === "daftari"
        ? "post-cutoff/private (Daftari internals)"
        : c.domain === "ml-novel"
          ? "post-cutoff novel content"
          : "real content";
    let rationale;
    if (src.truth === "derives") {
      rationale =
        `DERIVES (${c.difficulty}, ${c.edgeClass}). DOC A's claim depends on DOC B as a ` +
        `load-bearing premise: if B were false, A loses its warrant; B stands without A. ` +
        `Cross-family gate: ${t.s}. ${contamNote}. Domain: ${c.domain}. [orig ${c.id}]`;
    } else {
      rationale =
        `NEITHER (${isTrap ? "common-cause/co-consequence TRAP" : "co-occurrence"}). ${c.subtype}. ` +
        `A and B share theme/vocabulary but neither is a load-bearing premise for the other. ` +
        `Cross-family gate: ${t.s}. ${contamNote}. Domain: ${c.domain}. [orig ${c.id}]`;
    }
    const edge = {
      id: fid(),
      fromPath: c.fromPath,
      toPath: c.toPath,
      fromContent: c.fromContent,
      toContent: c.toContent,
      truth: src.truth,
      ...(c.edgeClass ? { edgeClass: c.edgeClass } : {}),
      rationale,
    };
    edges.push(edge);
  }
}

writeFileSync("test/fixtures/decorrelation-fixture-v2.json", JSON.stringify({ version: 1, edges }, null, 2) + "\n");
const counts = edges.reduce((a, e) => ((a[e.truth] = (a[e.truth] ?? 0) + 1), a), {});
const cls = edges.filter((e) => e.truth === "derives").reduce((a, e) => ((a[e.edgeClass] = (a[e.edgeClass] ?? 0) + 1), a), {});
console.log(`wrote ${edges.length} edges: ${JSON.stringify(counts)}`);
console.log(`derives edge-class: ${JSON.stringify(cls)}`);
