// score — labelability metrics for a candidate chain. Reuses E1's buildChainDocs
// (fetch+htmlToText) and parseCitations: counts amendment ops, classifies the
// unit type (Section / defined-term / mixed) and the unrecoverable rate (the
// >20% hand-resolution kill-metric). Master (order 0) is not an amendment.
import { buildChainDocs, type Seed } from "./chain-docs.js";
import type { FetchOpts } from "./edgar-fetch.js";
import { parseCitations } from "./citation-parse.js";

export type UnitType = "section" | "defined-term" | "mixed" | "unknown";

export interface ChainScore {
  chainId: string;
  cik: string;
  /** Total documents in the chain, INCLUDING the master (order 0) — not the
   * count of scored amendments. select.ts compares `length >= minLength`. */
  length: number;
  unitType: UnitType;
  totalOps: number;
  unrecoverableOps: number;
  unrecoverableRate: number;
}

// Mirrors the numeric CLAUSE shape in citation-parse.ts (digits, dotted
// sub-sections, optional `(a)`) — anchored so the rule is "clause is purely
// numeric", not "starts with a digit".
const NUMERIC_CLAUSE = /^\d+(\.\d+)*(\([a-z0-9]+\))?$/;

export async function scoreChain(seed: Seed, opts: FetchOpts): Promise<{ ok: true; score: ChainScore } | { ok: false; error: string }> {
  const built = await buildChainDocs(seed, opts);
  if (!built.ok) return { ok: false, error: built.error };
  let total = 0, unrec = 0, section = 0, term = 0;
  for (const d of built.docs) {
    if (d.order === 0) continue; // the master is not an amendment
    for (const c of parseCitations(d.text)) {
      total++;
      if (!c.recoverable) unrec++;
      if (NUMERIC_CLAUSE.test(c.clause)) section++; else term++;
    }
  }
  const unitType: UnitType = section && term ? "mixed" : section ? "section" : term ? "defined-term" : "unknown";
  return { ok: true, score: {
    chainId: seed.chainId,
    cik: seed.docs[0]?.cik ?? "", // CIK is homogeneous across a chain's docs (one filer)
    length: built.docs.length,
    unitType,
    totalOps: total,
    unrecoverableOps: unrec,
    unrecoverableRate: total ? unrec / total : 0,
  } };
}
