// consensus-cb4-pairs — build the CB4 datasets from CO2 diffs. True pairs are the
// scorable stale-traps (a real supersession: governing supersedes stale). Control
// pairs join governing passages from DISTINCT consensus items (no relation) —
// deduped on governingNum because only ~18 distinct items exist across 37
// instances (index pairing would pair same-item passages).
import type { RevertDiff } from "./consensus-content.js";
import { parsePassage } from "./consensus-passage.js";

export interface TruePair {
  revid: number;
  governingNum: number;
  govText: string;
  staleText: string;
}

export interface ControlPair {
  numA: number;
  numB: number;
  textA: string;
  textB: string;
}

export function truePairs(diffs: RevertDiff[]): TruePair[] {
  const out: TruePair[] = [];
  for (const d of diffs) {
    const p = parsePassage(d.diffHtml);
    if (!p.scorable) continue;
    out.push({ revid: d.revid, governingNum: d.governingNum, govText: p.governingText, staleText: p.staleText });
  }
  return out;
}

export function controlPairs(diffs: RevertDiff[]): ControlPair[] {
  // One governing passage per distinct governingNum (first scorable instance).
  const byNum = new Map<number, string>();
  for (const d of diffs) {
    if (byNum.has(d.governingNum)) continue;
    const p = parsePassage(d.diffHtml);
    if (p.scorable) byNum.set(d.governingNum, p.governingText);
  }
  const items = [...byNum.entries()].sort((a, b) => a[0] - b[0]); // [num, text]
  const out: ControlPair[] = [];
  for (let i = 0; i + 1 < items.length; i++) {
    out.push({ numA: items[i][0], numB: items[i + 1][0], textA: items[i][1], textB: items[i + 1][1] });
  }
  return out; // all numA != numB by construction (distinct items, adjacent)
}
