#!/usr/bin/env node
// edgar-arms-runner — E3: run Arm A (recency) vs Arm C (daftari
// resolveCurrentSource) on the REAL selected NGS chain that E2 discovered.
// Same harness as falsifier-runner.mjs, but the chain is buildChainDocs() over
// the cached real EDGAR exhibits (in .edgar-cache/, gitignored) instead of
// synth-gen. Run `npx tsc` first (imports the compiled dist) and ensure the NGS
// exhibits are cached (pull via discover-edgar / pull-edgar). Result on the
// clean NGS chain: 12/12 scoped-current, Arm A == Arm C, INCONCLUSIVE (the
// chain has no stale re-mention, so recency resolves every clause correctly).
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DIST = join(HERE, "dist");
const OUT = "/tmp/contract-bench/edgar-ngs";
const SEED = 20260627;
const cacheDir = join(HERE, ".edgar-cache");

const { buildChainDocs } = await import(`${DIST}/chain-docs.js`);
const { assemble } = await import(`${DIST}/assemble.js`);
const { recencyAnswer } = await import(`${DIST}/arm-recency.js`);
const { scoreArms } = await import(`${DIST}/metrics.js`);

const { reindexVault } = await import(`${ROOT}/dist/search/reindex.js`);
const { openIndexForActiveProvider } = await import(`${ROOT}/dist/tools/search.js`);
const { hybridSearch } = await import(`${ROOT}/dist/search/hybrid.js`);
const { resolveCurrentSource } = await import(`${ROOT}/dist/search/current-source.js`);
const { getDocument } = await import(`${ROOT}/dist/storage/index-db.js`);

// The real selected NGS chain (E2 manifest): base A&R + amendments 1..4.
const seed = {
  chainId: "0001084991-amended-and-restated-credit-agreement-february-28-2023",
  unitType: "mixed",
  docs: [
    { id: "master", order: 0, role: "master", cik: "0001084991", accession: "0001084991-23-000019", filename: "exhibit101tcbamendedandres.htm" },
    { id: "amendment-1", order: 1, role: "amendment-1", cik: "0001084991", accession: "0001084991-23-000124", filename: "exhibit101firstamendmentto.htm" },
    { id: "amendment-2", order: 2, role: "amendment-2", cik: "0001084991", accession: "0001084991-24-000066", filename: "exhibit101_secondamendme.htm" },
    { id: "amendment-3", order: 3, role: "amendment-3", cik: "0001084991", accession: "0001084991-24-000080", filename: "exhibit101thirdamendment.htm" },
    { id: "amendment-4", order: 4, role: "amendment-4", cik: "0001084991", accession: "0001084991-25-000044", filename: "exhibit101_fourthxamendm.htm" },
  ],
};

const slugOf = (clause) => clause.trim().replace(/\s+/g, "-").replace(/[/\\:*?"<>|]/g, "");

// Arm C: daftari retrieval + clause-scoped supersession resolution. Never mints.
async function daftariAnswer(db, clause) {
  const res = await hybridSearch(db, `Section ${clause}`, { limit: 300, weights: { bm25: 1, vector: 0 }, lexicalGranularity: "document" });
  if (!res.ok) throw new Error(res.error.message);
  const hits = res.value.hits.filter((h) => h.path.startsWith(`clause-${slugOf(clause)}/`));
  if (hits.length === 0) return "NOT_PRESENT";
  const r = resolveCurrentSource(db, hits[0].path);
  const path = r && r.kind === "resolved" ? r.path : hits[0].path;
  const doc = getDocument(db, path);
  return doc ? doc.content.trim() : "NOT_PRESENT";
}

const built = await buildChainDocs(seed, { cacheDir, userAgent: "offline-cache-only" });
if (!built.ok) { console.error("buildChainDocs failed (are the NGS exhibits cached?):", built.error); process.exit(1); }
const asm = assemble(built.docs, { seed: SEED });
const byBucket = {};
for (const q of asm.groundTruth) byBucket[q.bucket] = (byBucket[q.bucket] || 0) + 1;
console.log(`built ${built.docs.length} docs; ${asm.groundTruth.length} QAs ${JSON.stringify(byBucket)}; ${asm.vault.length} vault docs`);

rmSync(OUT, { recursive: true, force: true });
for (const f of asm.vault) { const full = `${OUT}/vault/${f.path}`; mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, f.content); }

const rr = await reindexVault(`${OUT}/vault`);
if (!rr.ok) { console.error("reindex failed:", rr.error.message); process.exit(1); }
const open = openIndexForActiveProvider(`${OUT}/vault`);
if (!open.ok) { console.error("open failed:", open.error.message); process.exit(1); }
const db = open.value;

const recency = { arm: "recency", byClauseId: {} };
const daftari = { arm: "daftari", byClauseId: {} };
for (const qa of asm.groundTruth) {
  recency.byClauseId[qa.id] = recencyAnswer(asm.perturbedDocs, qa.clause);
  daftari.byClauseId[qa.id] = await daftariAnswer(db, qa.clause);
}

const summary = scoreArms(asm.groundTruth, [recency, daftari], { armC: "daftari", armA: "recency" });
summary.counts = { qas: asm.groundTruth.length, vault: asm.vault.length, buckets: byBucket };
writeFileSync(`${OUT}/summary.json`, JSON.stringify({ summary, groundTruth: asm.groundTruth, recency: recency.byClauseId, daftari: daftari.byClauseId }, null, 2));
console.log(JSON.stringify(summary.verdict, null, 2));
