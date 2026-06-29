// consensus-pilot — run Arm A (both snapshots) and Arm C over the stale-trap
// diffs, classify, and aggregate the pilot's kill-gate metrics.
import type { ConsensusItem } from "./consensus-parse.js";
import type { RevertDiff } from "./consensus-content.js";
import { parsePassage } from "./consensus-passage.js";
import { armA, classifyAnswer } from "./consensus-arm-a.js";
import { armC } from "./consensus-arm-c.js";

export interface PilotRow {
  revid: number;
  citedNum: number;
  scorable: boolean;
  reason?: string;
  armABefore?: string; // classification at the bad-edit snapshot
  armAAfter?: string; // classification at the revert snapshot
  armC: string; // Arm C classification
}

export interface PilotMetrics {
  total: number;
  scorable: number;
  armAFailBefore: number; // 'stale' at before (recency fails)
  armAPassAfter: number; // 'governing' at after (fair foil)
  armCGoverning: number;
}

export interface PilotResult {
  rows: PilotRow[];
  metrics: PilotMetrics;
}

export function runPilot(items: ConsensusItem[], diffs: RevertDiff[]): PilotResult {
  const rows: PilotRow[] = diffs.map((d) => {
    const passage = parsePassage(d.diffHtml);
    const c = armC(items, d, passage, d.diffHtml);
    if (!passage.scorable) {
      return { revid: d.revid, citedNum: d.citedNum, scorable: false, reason: passage.reason, armC: c.classification };
    }
    return {
      revid: d.revid,
      citedNum: d.citedNum,
      scorable: true,
      armABefore: classifyAnswer(armA(passage, "before").answer, passage),
      armAAfter: classifyAnswer(armA(passage, "after").answer, passage),
      armC: c.classification,
    };
  });

  const scorable = rows.filter((r) => r.scorable);
  return {
    rows,
    metrics: {
      total: rows.length,
      scorable: scorable.length,
      armAFailBefore: scorable.filter((r) => r.armABefore === "stale").length,
      armAPassAfter: scorable.filter((r) => r.armAAfter === "governing").length,
      armCGoverning: scorable.filter((r) => r.armC === "governing").length,
    },
  };
}
