// consensus-qa — assemble the bench buckets from box topics + labeled instances.
// Bucket provenance:
//   stale-restatement-trap : resolved citing-revert instances (stream-derived)
//   no-mint                : unresolved topics — dead-end chains ({4,15}) AND lone
//                            superseded/canceled items with no successor (BOX-derived,
//                            not the parser); all are genuine no-current-value cases
//   current-decision       : settled active single-item topics not cited by any instance
//   live-tension           : NOT populated in CO1 — the box holds only settled items;
//                            the keystone bucket is deferred to a stream pass. The type
//                            keeps the member for that future work.
import type { ConsensusItem } from "./consensus-parse.js";
import type { Topic } from "./consensus-topics.js";
import type { LabeledInstance } from "./consensus-instances.js";

export type QaBucket = "current-decision" | "stale-restatement-trap" | "live-tension" | "no-mint";

export interface QaItem {
  id: string;
  bucket: QaBucket;
  governingNum?: number; // gold item for resolvable buckets
  gold?: "not-present" | "contested"; // gold for no-mint / live-tension
  staleCitedNum?: number; // the trap's cited item (stale-restatement-trap)
  topicItems?: number[]; // the component, for box-derived buckets
}

export function buildQa(items: ConsensusItem[], topics: Topic[], instances: LabeledInstance[]): QaItem[] {
  const qa: QaItem[] = [];

  // stale-restatement-trap — one per resolved instance.
  for (const inst of instances) {
    if (!inst.resolved || inst.governingNum === undefined) continue;
    qa.push({
      id: `trap:${inst.revid}:${inst.citedNum}`,
      bucket: "stale-restatement-trap",
      governingNum: inst.governingNum,
      staleCitedNum: inst.citedNum,
    });
  }

  // no-mint — box-derived: topics with no single active terminal (dead-ends).
  for (const t of topics) {
    if (!t.resolved && t.current.length === 0) {
      qa.push({ id: `nomint:${t.id}`, bucket: "no-mint", gold: "not-present", topicItems: t.items });
    }
  }

  // live-tension — intentionally NOT populated in CO1. The box holds only settled
  // items (including "no consensus on wording but status-quo is X", which HAS a
  // governing value). A genuine live tension lives in the open stream, not the box;
  // the keystone bucket is deferred to a later best-effort stream pass.

  // current-decision — settled active single-item topics not cited by any instance.
  const cited = new Set(instances.map((i) => i.governingNum).filter((n): n is number => n !== undefined));
  for (const t of topics) {
    if (t.resolved && t.items.length === 1) {
      const num = t.current[0];
      if (cited.has(num)) continue;
      qa.push({ id: `current:${num}`, bucket: "current-decision", governingNum: num });
    }
  }

  return qa;
}
