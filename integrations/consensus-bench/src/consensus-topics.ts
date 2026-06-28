// consensus-topics — group consensus items into topics. A topic is a connected
// component of the supersession graph: a chain of items that revised one
// underlying editorial decision (e.g. the lead sentence 11->17->50->70). The
// current consensus on a topic is its active terminal item. A component with no
// active item (a chain that dead-ends at a superseded item with no in-corpus
// successor) has NO current consensus — the honest no-mint case, mirroring
// resolveCurrent. This turns the box into a set of "current consensus on topic
// X?" questions for the bench.

import type { ConsensusItem } from "./consensus-parse.js";

export interface Topic {
  // Stable id: the smallest item number in the component.
  id: number;
  // All item numbers in the component, ascending.
  items: number[];
  // The active item(s) — the current consensus. Normally exactly one; empty
  // when the chain dead-ends at a superseded item (no current value to mint).
  current: number[];
  // True iff the component resolves to exactly one current active item.
  resolved: boolean;
}

export function groupTopics(items: ConsensusItem[]): Topic[] {
  const parent = new Map<number, number>();
  for (const it of items) parent.set(it.num, it.num);

  function find(x: number): number {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // Path compression.
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  }
  function union(a: number, b: number): void {
    if (!parent.has(a) || !parent.has(b)) return; // ignore refs outside the corpus
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }

  // Both edge directions link the same two items into one component.
  for (const it of items) {
    for (const s of it.supersededBy) union(it.num, s);
    for (const s of it.supersedes) union(it.num, s);
  }

  const byRoot = new Map<number, number[]>();
  for (const it of items) {
    const r = find(it.num);
    const bucket = byRoot.get(r) ?? [];
    bucket.push(it.num);
    byRoot.set(r, bucket);
  }

  const statusByNum = new Map(items.map((i) => [i.num, i.status]));
  const topics: Topic[] = [];
  for (const [root, nums] of byRoot) {
    nums.sort((a, b) => a - b);
    const current = nums.filter((n) => statusByNum.get(n) === "active");
    topics.push({ id: root, items: nums, current, resolved: current.length === 1 });
  }
  topics.sort((a, b) => a.id - b.id);
  return topics;
}
