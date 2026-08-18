// off.1/MAV-154 graph-augmented retrieval: a post-pass that injects a bounded,
// affinity-filtered set of one-hop edge neighbors into an already-ranked hit
// list. Mirrors applyCoveragePass (src/tools/search.ts): resolves its own config
// gate, returns `ranked` unchanged when off, flags injected hits (viaEdge) for
// RBAC filtering at the call site. hybrid.ts ranking is not touched.

import { type GraphExpandConfig, SEARCH_TUNING_DEFAULTS } from "../utils/config.js";

// Runtime config holder — resolved ONCE at startup (setGraphExpandConfig called
// from src/index.ts and src/serve/index.ts beside setCoverageEnabled/setVecKnnK),
// read by the pass at serve time. Avoids a per-query loadConfig re-parse.
let graphExpandCfg: GraphExpandConfig = { ...SEARCH_TUNING_DEFAULTS.graphExpand };
export function setGraphExpandConfig(cfg: GraphExpandConfig): void {
  graphExpandCfg = cfg;
}
export function graphExpandConfig(): GraphExpandConfig {
  return graphExpandCfg;
}

export interface NeighborCandidate {
  path: string;
  seed: string; // the ranked doc it was reached from
  edgeType: "derives_from" | "tension";
  affinity: number; // max cosine of the neighbor's chunks to the query embedding
}

export interface SelectOptions {
  cap: number; // fixed global add budget
  tau: number; // vector-cosine affinity floor
}

export interface ExpansionHit {
  path: string;
  affinity: number;
  viaEdge: { seed: string; edgeType: "derives_from" | "tension" };
}

// Pure. Floor by tau, dedup against candidates and across seeds (keeping the
// highest-affinity attribution per path), order by descending affinity, cap.
export function selectExpansion(
  candidates: NeighborCandidate[],
  candidateSet: ReadonlySet<string>,
  opts: SelectOptions,
): ExpansionHit[] {
  if (opts.cap <= 0) return [];
  const best = new Map<string, NeighborCandidate>();
  for (const c of candidates) {
    if (c.affinity < opts.tau) continue;
    if (candidateSet.has(c.path)) continue; // already a ranked/seed doc
    const prior = best.get(c.path);
    if (!prior || c.affinity > prior.affinity) best.set(c.path, c);
  }
  return [...best.values()]
    .sort((a, b) => b.affinity - a.affinity || a.path.localeCompare(b.path))
    .slice(0, opts.cap)
    .map((c) => ({
      path: c.path,
      affinity: c.affinity,
      viaEdge: { seed: c.seed, edgeType: c.edgeType },
    }));
}
