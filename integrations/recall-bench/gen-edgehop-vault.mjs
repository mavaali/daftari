import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Generates the MAV-160 edge-bearing labeled multi-hop corpus: the surface
// MAV-154's $0 reachability-ceiling arm (edge-ceiling.mjs) runs on. No
// existing corpus has BOTH a labeled relevant set and an edge graph — RB has
// labels and zero edges, gen-native-vault has neither — so this generator
// makes one deterministically. It validates harness MECHANICS and provides
// the labeled surface; because its edges are constructed, a result on it is
// a ceiling for what perfectly-aligned edges could do, never field evidence
// that real (consolidation-birthed) edges are aligned.
//
// Construction (everything derives from the cluster index — no randomness):
//   - CLUSTERS clusters of 1 hub + EVIDENCE_PER evidence docs, plus NOISE
//     noise docs. Questions use HUB vocabulary; evidence bodies share no
//     distinctive token with the hub or the question, so ranking finds the
//     hub and rank-extension cannot reach the evidence — only edges can.
//   - Aligned edges: hub --derives_from--> each of its evidence docs. Half
//     the clusters get a second qualifying blind vote (axis varied) so their
//     edges are trigger-bearing; the rest stay zero-strength candidates —
//     the ceiling can then compare all-edges vs trigger-bearing-only.
//   - Misaligned lineage noise: each hub also derives from two evidence docs
//     of the NEXT cluster (ancestry that is NOT question-relevant), and each
//     noise doc derives from an evidence doc. One-hop expansion therefore
//     pays a measurable precision cost; the corpus does not strawman it away.
//   - Tensions: every third cluster's hub contradicts the hub twelve
//     clusters over (an undirected topic link BFS traverses), and its first
//     evidence doc contradicts a noise doc.
//
// Question types (labels in queries.jsonl, relevant = vault-relative paths):
//   hub-hop       — hub vocabulary; relevant = hub + its evidence. The case
//                   edges should win.
//   lex-reachable — evidence vocabulary directly; relevant = those evidence
//                   docs. The control where rank-extension needs no help.
//   cross-tension — both hubs of a tension pair; relevant = both hubs + each
//                   hub's first evidence doc.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = process.env.EDGEHOP_OUT ?? "/tmp/edgehop";
const VAULT = join(OUT, "vault");
const QFILE = join(OUT, "queries.jsonl");

const CLUSTERS = 24;
const EVIDENCE_PER = 4;
const NOISE = 30;
const BASE_AT = "2026-08-01T00:00:00Z";
const CREATED = "2026-08-01";

const ix = (n) => String(n).padStart(3, "0");
const hubPath = (i) => `corpus/hub-${ix(i)}.md`;
const evPath = (i, j) => `corpus/ev-${ix(i)}${j}.md`;
const noisePath = (k) => `corpus/noise-${ix(k)}.md`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(VAULT, "corpus"), { recursive: true });

const fm = (title, tag) =>
  `---\n` +
  `title: "${title}"\n` +
  `domain: accumulation\n` +
  `collection: corpus\n` +
  `status: canonical\n` +
  `confidence: high\n` +
  `created: ${CREATED}\n` +
  `updated: ${CREATED}\n` +
  `updated_by: "agent:edgehop-gen"\n` +
  `provenance: direct\n` +
  `sources: []\n` +
  `superseded_by: null\n` +
  `tags: [${tag}, edgehop]\n` +
  `---\n\n`;

for (let i = 0; i < CLUSTERS; i++) {
  const hubTok = `hubtok${ix(i)}`;
  writeFileSync(
    join(VAULT, hubPath(i)),
    fm(`Decision ${hubTok}`, `hub${ix(i)}`) +
      `The ${hubTok} initiative reached a decision this week. The rationale for ` +
      `${hubTok} rests on findings gathered earlier and consolidated here. This note ` +
      `records the conclusion of ${hubTok} without restating the underlying measurements.\n`,
  );
  for (let j = 0; j < EVIDENCE_PER; j++) {
    const evTok = `evtok${ix(i)}${j}`;
    writeFileSync(
      join(VAULT, evPath(i, j)),
      fm(`Measurement ${evTok}`, `ev${ix(i)}`) +
        `Raw observation ${evTok}: the instrument logged a stable reading across three ` +
        `sessions. Conditions for ${evTok} were recorded in the lab notebook, and the ` +
        `${evTok} series passed its calibration check.\n`,
    );
  }
}
for (let k = 0; k < NOISE; k++) {
  const nTok = `noisetok${ix(k)}`;
  writeFileSync(
    join(VAULT, noisePath(k)),
    fm(`Aside ${nTok}`, "noise") +
      `Unrelated working note ${nTok}: housekeeping, scheduling, and a reminder about ` +
      `${nTok} follow-ups. Nothing here bears on any decision.\n`,
  );
}

const { reindexVault } = await import(join(ROOT, "dist/search/reindex.js"));
const r = await reindexVault(VAULT);
if (!r.ok) throw new Error(`reindex failed: ${r.error.message}`);
const expectedDocs = CLUSTERS * (1 + EVIDENCE_PER) + NOISE;
if (r.value.documentCount !== expectedDocs)
  throw new Error(`indexed ${r.value.documentCount}, expected ${expectedDocs}`);

// --- edges (through the real store, so the format can never drift) ----------

const { observeEdge } = await import(join(ROOT, "dist/curation/edges.js"));
const { addTension } = await import(join(ROOT, "dist/curation/tension.js"));

const at = (offsetMinutes) =>
  new Date(Date.parse(BASE_AT) + offsetMinutes * 60_000).toISOString();
let edgeCount = 0;
async function observe(fromPath, toPath, opts) {
  const res = await observeEdge(VAULT, {
    fromPath,
    toPath,
    observedBy: "agent:edgehop-gen",
    blind: true,
    ...opts,
  });
  if (!res.ok) throw new Error(`observe ${fromPath}->${toPath}: ${res.error.message}`);
  edgeCount++;
}

for (let i = 0; i < CLUSTERS; i++) {
  const triggerBearing = i % 2 === 0;
  for (let j = 0; j < EVIDENCE_PER; j++) {
    // Seed vote (k_survived=0 — a zero-strength candidate).
    await observe(hubPath(i), evPath(i, j), { at: at(i * 10 + j) });
    if (triggerBearing) {
      // A qualifying re-derivation (blind, axis varied, different observer)
      // earns k_survived=1: trigger-bearing at fresh age.
      const res = await observeEdge(VAULT, {
        fromPath: hubPath(i),
        toPath: evPath(i, j),
        observedBy: "agent:edgehop-verifier",
        blind: true,
        axis: "prompt",
        at: at(1000 + i * 10 + j),
      });
      if (!res.ok) throw new Error(`re-observe: ${res.error.message}`);
    }
  }
  // Lineage noise: ancestry into the next cluster's evidence — real
  // derivation, not question-relevant for this hub's question.
  const next = (i + 1) % CLUSTERS;
  await observe(hubPath(i), evPath(next, 0), { at: at(2000 + i) });
  await observe(hubPath(i), evPath(next, 1), { at: at(2100 + i) });
}
for (let k = 0; k < NOISE; k++) {
  await observe(noisePath(k), evPath(k % CLUSTERS, k % EVIDENCE_PER), { at: at(3000 + k) });
}

let tensionCount = 0;
for (let i = 0; i < CLUSTERS; i += 3) {
  const other = (i + 12) % CLUSTERS;
  const pairs = [
    [hubPath(i), hubPath(other), `hubtok${ix(i)} conclusion conflicts with hubtok${ix(other)}`],
    [evPath(i, 0), noisePath(i % NOISE), `evtok${ix(i)}0 reading disputed by an aside`],
  ];
  for (const [a, b, title] of pairs) {
    const res = await addTension(VAULT, {
      title,
      kind: "factual",
      sourceA: a,
      claimA: `claim recorded in ${a}`,
      sourceB: b,
      claimB: `claim recorded in ${b}`,
      loggedBy: "agent:edgehop-gen",
    });
    if (!res.ok) throw new Error(`tension ${a}<->${b}: ${res.error.message}`);
    tensionCount++;
  }
}

// --- labeled questions -------------------------------------------------------

const queries = [];
for (let i = 0; i < CLUSTERS; i++) {
  const hubTok = `hubtok${ix(i)}`;
  queries.push({
    id: `hub-hop-${ix(i)}`,
    type: "hub-hop",
    query: `What measurements back the ${hubTok} decision and its rationale?`,
    relevant: [hubPath(i), ...Array.from({ length: EVIDENCE_PER }, (_, j) => evPath(i, j))],
  });
  queries.push({
    id: `lex-reachable-${ix(i)}`,
    type: "lex-reachable",
    query: `observation evtok${ix(i)}0 and evtok${ix(i)}1 calibration readings`,
    relevant: [evPath(i, 0), evPath(i, 1)],
  });
}
for (let i = 0; i < CLUSTERS; i += 3) {
  const other = (i + 12) % CLUSTERS;
  queries.push({
    id: `cross-tension-${ix(i)}`,
    type: "cross-tension",
    query: `How do the hubtok${ix(i)} and hubtok${ix(other)} decisions conflict?`,
    relevant: [hubPath(i), hubPath(other), evPath(i, 0), evPath(other, 0)],
  });
}
writeFileSync(QFILE, queries.map((q) => JSON.stringify(q)).join("\n") + "\n");

console.log(
  `gen-edgehop-vault: ${expectedDocs} docs, ${edgeCount} edge observations, ` +
    `${tensionCount} tensions, ${queries.length} queries -> ${OUT}`,
);
