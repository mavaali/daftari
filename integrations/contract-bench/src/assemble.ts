// assemble — the CB1 end-to-end orchestrator. Perturb the chain (consistently,
// so cross-document references stay aligned), resolve per-clause supersession,
// build the QAs and the atomized vault, and render everything to in-memory
// artifacts. I/O (writing files) is a thin layer on top of this pure step.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildCorpus } from "./corpus.js";
import { type ChainDoc, type ClauseResolution, resolveChain } from "./clause-edge.js";
import { buildQAs, type ContractQA } from "./qa-build.js";
import { perturbValues } from "./perturb.js";
import { renderDoc } from "./serialize.js";

export interface Assembly {
  vault: { path: string; content: string }[];
  groundTruth: ContractQA[];
  pairDump: string;
  mapping: Record<string, string>;
  // The perturbed chain docs — the Arm A (recency) foil must extract from the
  // SAME perturbed text the ground truth was built from, so it is returned here.
  perturbedDocs: ChainDoc[];
}

export interface AssembleOptions {
  seed: number;
  noValueClauses?: string[];
}

// Perturb every document with one shared, accumulating mapping so a value that
// recurs across documents is substituted identically everywhere.
function perturbChain(docs: ChainDoc[], seed: number): { docs: ChainDoc[]; mapping: Record<string, string> } {
  const mapping: Record<string, string> = {};
  const out = docs.map((d) => {
    const r = perturbValues(d.text, seed, mapping);
    Object.assign(mapping, r.mapping);
    return { ...d, text: r.text };
  });
  return { docs: out, mapping };
}

function renderPairDump(qas: ContractQA[], resolutions: ClauseResolution[]): string {
  const tainted = resolutions.filter((r) => !r.clean).map((r) => r.clause);
  const lines = qas.map(
    (q) => `${q.clause}\t${q.bucket}\tgoverning=${q.governingDoc || "-"}\tanswer=${q.answer}`,
  );
  if (tainted.length) lines.push(`# excluded (tainted by unrecoverable op): ${tainted.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

export function assemble(rawDocs: ChainDoc[], opts: AssembleOptions): Assembly {
  const { docs, mapping } = perturbChain(rawDocs, opts.seed);
  const resolutions = resolveChain(docs);
  const groundTruth = buildQAs(docs, resolutions, { noValueClauses: opts.noValueClauses });
  const vault = buildCorpus(docs, resolutions).map((d) => ({ path: d.path, content: renderDoc(d) }));
  return { vault, groundTruth, pairDump: renderPairDump(groundTruth, resolutions), mapping, perturbedDocs: docs };
}

// Write an assembly to <outDir>: the daftari-ingestable vault/ tree, plus the
// ground-truth QAs, the human-readable pair dump, and the perturbation mapping
// (for regenerability / audit).
export function writeAssembly(a: Assembly, outDir: string): void {
  for (const f of a.vault) {
    const full = join(outDir, "vault", f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content);
  }
  writeFileSync(join(outDir, "ground-truth.json"), JSON.stringify(a.groundTruth, null, 2));
  writeFileSync(join(outDir, "pairs.md"), a.pairDump);
  writeFileSync(join(outDir, "perturbation.json"), JSON.stringify(a.mapping, null, 2));
}
