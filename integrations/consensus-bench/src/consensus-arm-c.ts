// consensus-arm-c — daftari's arm: resolve the cited item's supersession chain to
// the governing item (oracle edge), confirm the governed passage via the inline
// consensus marker, and foreground the governing text. Never mints: an unresolved
// item (dead-end / absent) abstains. The oracle edge makes a governing result
// near-tautological at the revert snapshot (accepted upper bound); the load-bearing
// signal is Arm A's failure and this abstention.
import type { ConsensusItem } from "./consensus-parse.js";
import { resolveCurrent } from "./consensus-resolve.js";
import { markerPresent, type ParsedPassage } from "./consensus-passage.js";
import type { RevertDiff } from "./consensus-content.js";

export type ArmCClassification = "governing" | "abstain" | "unscorable";

export interface ArmCResult {
  answer?: string;
  classification: ArmCClassification;
  reason?: string;
}

export function armC(
  items: ConsensusItem[],
  instance: Pick<RevertDiff, "citedNum">,
  passage: ParsedPassage,
  diffHtml: string,
): ArmCResult {
  const res = resolveCurrent(items, instance.citedNum);
  if (!res.resolved || res.item === undefined) {
    return { classification: "abstain", reason: "unresolved (dead-end/absent) — no-mint" };
  }
  if (!passage.scorable) return { classification: "unscorable", reason: passage.reason };
  // Non-circular localization: the governing item's marker must tag this passage.
  if (!markerPresent(diffHtml, res.item.num) && !markerPresent(diffHtml, instance.citedNum)) {
    return { classification: "unscorable", reason: "no inline consensus marker in diff window" };
  }
  return { answer: passage.governingText, classification: "governing" };
}
