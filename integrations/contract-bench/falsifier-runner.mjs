// falsifier-runner — the A-vs-C kill race for the synthetic contract-supersession
// falsifier. For each variant (clean | stale): generate a chain, assemble it
// (perturb + resolve + atomized vault), reindex the vault, then answer every QA
// two ways —
//   Arm A (recency): most-recent whole-contract doc that mentions the clause.
//   Arm C (daftari): retrieve the clause's atomized version, resolveCurrentSource
//                    to the governing terminal, return its value.
// — and score per bucket. PREDICTION: clean → A ties C (INCONCLUSIVE);
// stale → C ≫ A on scoped-current (WIN), C fabrication ≈ 0.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const ROOT = "/Users/mihirwagle/projects/daftari";
const CB = `${ROOT}/integrations/contract-bench/dist`;
const OUT = "/tmp/contract-bench";
const SEED = 20260625;
const N_CLAUSES = 12;
const N_AMENDMENTS = 2;

const { generateChain } = await import(`${CB}/synth-gen.js`);
const { assemble } = await import(`${CB}/assemble.js`);
const { recencyAnswer } = await import(`${CB}/arm-recency.js`);
const { scoreArms } = await import(`${CB}/metrics.js`);

const { reindexVault } = await import(`${ROOT}/dist/search/reindex.js`);
const { openIndexForActiveProvider } = await import(`${ROOT}/dist/tools/search.js`);
const { hybridSearch } = await import(`${ROOT}/dist/search/hybrid.js`);
const { resolveCurrentSource } = await import(`${ROOT}/dist/search/current-source.js`);
const { getDocument } = await import(`${ROOT}/dist/storage/index-db.js`);

const slugOf = (clause) => clause.trim().replace(/\s+/g, "-").replace(/[/\\:*?"<>|]/g, "");

// Arm C: daftari retrieval + clause-scoped supersession resolution. Retrieve the
// clause's atomized version docs (lexical-only — no vector dependency), resolve
// from one to the governing terminal, return that version's value. Never mints:
// no candidate docs ⇒ NOT_PRESENT.
async function daftariAnswer(db, clause) {
  // Retrieval must reliably SURFACE the clause's atomized version docs so that
  // resolution (the thing under test) is what's measured — a retrieval miss is a
  // separate coverage concern, not a supersession finding. Clause ids live in the
  // doc title/frontmatter (the atomized body is the bare value), so use
  // document-granularity (title-indexed) lexical with a limit ≥ vault size.
  const res = await hybridSearch(db, `Section ${clause}`, {
    limit: 200,
    weights: { bm25: 1, vector: 0 },
    lexicalGranularity: "document",
  });
  if (!res.ok) throw new Error(res.error.message);
  const prefix = `clause-${slugOf(clause)}/`;
  const hits = res.value.hits.filter((h) => h.path.startsWith(prefix));
  if (hits.length === 0) return "NOT_PRESENT";
  const r = resolveCurrentSource(db, hits[0].path);
  const path = r && r.kind === "resolved" ? r.path : hits[0].path; // else hit is already terminal
  const doc = getDocument(db, path);
  return doc ? doc.content.trim() : "NOT_PRESENT";
}

const summaries = {};
let vectorWarned = false;
for (const variant of ["clean", "stale"]) {
  const { docs, noValueClauses } = generateChain({ seed: SEED, variant, nClauses: N_CLAUSES, nAmendments: N_AMENDMENTS });
  const asm = assemble(docs, { seed: SEED, noValueClauses });

  const dir = `${OUT}/${variant}`;
  rmSync(dir, { recursive: true, force: true });
  for (const f of asm.vault) {
    const full = `${dir}/vault/${f.path}`;
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content);
  }

  const rr = await reindexVault(`${dir}/vault`);
  if (!rr.ok) { console.error(`reindex ${variant} failed:`, rr.error.message); process.exit(1); }
  if (!rr.value.vectorEnabled && !vectorWarned) { console.warn("note: vectorEnabled=false (lexical-only retrieval; fine for Arm C path lookup)"); vectorWarned = true; }
  const open = openIndexForActiveProvider(`${dir}/vault`);
  if (!open.ok) { console.error(`open ${variant} failed:`, open.error.message); process.exit(1); }
  const db = open.value;

  const recency = { arm: "recency", byClauseId: {} };
  const daftari = { arm: "daftari", byClauseId: {} };
  for (const qa of asm.groundTruth) {
    recency.byClauseId[qa.id] = recencyAnswer(asm.perturbedDocs, qa.clause);
    daftari.byClauseId[qa.id] = await daftariAnswer(db, qa.clause);
  }

  const summary = scoreArms(asm.groundTruth, [recency, daftari], { armC: "daftari", armA: "recency" });
  summary.counts = { qas: asm.groundTruth.length, vault: asm.vault.length };
  summaries[variant] = summary;
  writeFileSync(`${dir}/summary.json`, JSON.stringify({ summary, groundTruth: asm.groundTruth, recency: recency.byClauseId, daftari: daftari.byClauseId }, null, 2));
}

console.log(JSON.stringify(summaries, null, 2));
