// consensus-instances — join the stream's citing reverts to the box's governing
// truth. The cited item is resolved through resolveCurrent so an editor who
// cited a since-superseded item still lands on the current terminal. A cited
// item absent from the box is kept as an unresolved anomaly for spot-check.
import type { ConsensusItem } from "./consensus-parse.js";
import { resolveCurrent } from "./consensus-resolve.js";
import { parseConsensusReverts, type RevertInstance } from "./consensus-reverts.js";
import type { RevisionRecord } from "./consensus-revisions.js";

export interface LabeledInstance extends RevertInstance {
  resolved: boolean;
  governingNum?: number; // the active terminal the cited item resolves to
  chain: number[];
}

export function buildInstances(items: ConsensusItem[], revisions: RevisionRecord[]): LabeledInstance[] {
  const known = new Set(items.map((i) => i.num));
  return parseConsensusReverts(revisions).map((r) => {
    if (!known.has(r.citedNum)) {
      return { ...r, resolved: false, governingNum: undefined, chain: [] };
    }
    const res = resolveCurrent(items, r.citedNum);
    return {
      ...r,
      resolved: res.resolved,
      governingNum: res.resolved ? res.item?.num : undefined,
      chain: res.chain,
    };
  });
}
