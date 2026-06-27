// consensus-resolve — follow a consensus item's supersededBy edges to the
// current governing item. This is the daftari-arm core for corpus (B): the
// resolveChain / resolveCurrentSource analog. A chain that ends at an active
// item is `resolved`; a chain that dead-ends at a superseded item with no
// in-corpus successor (e.g. "Superseded by lead rewrite") is NOT resolved —
// the honest tainted/unrecoverable case, mirroring the contract bench.

import type { ConsensusItem } from "./consensus-parse.js";

export interface ResolveResult {
  item?: ConsensusItem;
  resolved: boolean;
  chain: number[];
}

export function resolveCurrent(items: ConsensusItem[], num: number): ResolveResult {
  const byNum = new Map(items.map((i) => [i.num, i]));
  const chain: number[] = [];
  const seen = new Set<number>();
  let cur = byNum.get(num);
  while (cur && !seen.has(cur.num)) {
    seen.add(cur.num);
    chain.push(cur.num);
    if (cur.status === "active") return { item: cur, resolved: true, chain };
    // Follow only an unambiguous single in-corpus successor. Zero successors
    // (a dead-end "Superseded by lead rewrite") or multiple (ambiguous) stop
    // the walk unresolved — the honest tainted case.
    if (cur.supersededBy.length !== 1) break;
    cur = byNum.get(cur.supersededBy[0]);
  }
  return { item: cur, resolved: false, chain };
}
