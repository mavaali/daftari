// consensus-reverts — the deterministic labeling signal. A consensus-citing
// revert (a revert verb + a citation of a consensus item) tells us, with
// editor-provided alignment, that a recent edit asserted a NON-governing value
// on topic #N. This is the contamination-safe alignment the probe established;
// no LLM aligner.
import type { RevisionRecord } from "./consensus-revisions.js";

export interface RevertInstance {
  revid: number;
  parentid: number;
  timestamp: string;
  user: string;
  comment: string;
  citedNum: number;
}

const REVERT_RE = /\b(rv|rvt|revert(?:ed)?|undid|undo|restore[ds]?)\b/i;
// Either "consensus #N" / "consensus N" or an anchor wikilink "#C<N>".
const CITE_RE = /consensus\s*#?\s*(\d+)|#C(\d+)\b/gi;

export function parseConsensusReverts(revisions: RevisionRecord[]): RevertInstance[] {
  const out: RevertInstance[] = [];
  for (const r of revisions) {
    if (!REVERT_RE.test(r.comment)) continue;
    const nums = new Set<number>();
    for (const m of r.comment.matchAll(CITE_RE)) {
      nums.add(Number(m[1] ?? m[2]));
    }
    for (const citedNum of nums) {
      out.push({
        revid: r.revid,
        parentid: r.parentid,
        timestamp: r.timestamp,
        user: r.user,
        comment: r.comment,
        citedNum,
      });
    }
  }
  return out;
}
