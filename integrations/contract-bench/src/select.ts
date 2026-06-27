// select — filter scored chains to the labelable, well-formed ones and rank them;
// always report the full distribution (the natural unrecoverable-rate histogram
// is the labelability finding, independent of the selection cutoff). Both gates
// are tunable; maxUnrecoverable defaults to a deliberately generous 0.20.
import type { ChainScore } from "./score.js";

export interface SelectOpts { minLength: number; maxUnrecoverable: number; }

export interface Distribution {
  total: number;
  unitTypeCounts: Record<string, number>;
  rateBuckets: Record<string, number>;
}

export interface Selection { selected: ChainScore[]; distribution: Distribution; }

function bucket(rate: number): string {
  const lo = Math.min(9, Math.floor(rate * 10));
  return `${(lo / 10).toFixed(1)}-${((lo + 1) / 10).toFixed(1)}`;
}

export function rankCandidates(scores: ChainScore[], opts: SelectOpts): Selection {
  const selected = scores
    .filter((s) => s.length >= opts.minLength && s.unrecoverableRate <= opts.maxUnrecoverable)
    .sort((a, b) => a.unrecoverableRate - b.unrecoverableRate || b.length - a.length || a.chainId.localeCompare(b.chainId));
  const unitTypeCounts: Record<string, number> = {};
  const rateBuckets: Record<string, number> = {};
  for (const s of scores) {
    unitTypeCounts[s.unitType] = (unitTypeCounts[s.unitType] ?? 0) + 1;
    const b = bucket(s.unrecoverableRate);
    rateBuckets[b] = (rateBuckets[b] ?? 0) + 1;
  }
  return { selected, distribution: { total: scores.length, unitTypeCounts, rateBuckets } };
}
