// consensus-cb7-score — deterministic scoring for the CB7 run. The decision
// field is a closed enum, so no LLM judge participates in any primary metric.
//
//   divergence  — per model+bucket: instances where the two conditions
//                 produced different decisions. The kill condition's direct
//                 measurement: divergence ≈ 0 on the tension bucket → KILL.
//   calibration — per condition+bucket: correct-decision rate.
//   hedge tax   — per condition: hold_escalate rate on the settled bucket
//                 (escalating everything must show up as a cost, not a win).

import type { Cb7Bucket } from "./consensus-cb7-instances.js";
import type { Cb7Condition, Cb7Decision } from "./consensus-cb7-render.js";

export interface Cb7Row {
  instanceId: string;
  bucket: Cb7Bucket;
  model: string;
  condition: Cb7Condition;
  decision: Cb7Decision | null; // null = unparseable / errored response
  correct: Cb7Decision;
}

export interface DivergenceReport {
  model: string;
  bucket: Cb7Bucket;
  n: number; // instances with BOTH conditions parseable
  diverged: number;
  divergedIds: string[];
}

export function divergence(rows: Cb7Row[], model: string, bucket: Cb7Bucket): DivergenceReport {
  const byInstance = new Map<string, Partial<Record<Cb7Condition, Cb7Decision | null>>>();
  for (const r of rows) {
    if (r.model !== model || r.bucket !== bucket) continue;
    const slot = byInstance.get(r.instanceId) ?? {};
    slot[r.condition] = r.decision;
    byInstance.set(r.instanceId, slot);
  }
  let n = 0;
  const divergedIds: string[] = [];
  for (const [id, slot] of byInstance) {
    const c = slot.collapsed;
    const h = slot.held;
    if (c === undefined || h === undefined || c === null || h === null) continue;
    n += 1;
    if (c !== h) divergedIds.push(id);
  }
  divergedIds.sort();
  return { model, bucket, n, diverged: divergedIds.length, divergedIds };
}

export interface CalibrationReport {
  condition: Cb7Condition;
  bucket: Cb7Bucket;
  n: number; // parseable decisions
  correct: number;
  unparseable: number;
}

export function calibration(
  rows: Cb7Row[],
  condition: Cb7Condition,
  bucket: Cb7Bucket,
): CalibrationReport {
  let n = 0;
  let correct = 0;
  let unparseable = 0;
  for (const r of rows) {
    if (r.condition !== condition || r.bucket !== bucket) continue;
    if (r.decision === null) {
      unparseable += 1;
      continue;
    }
    n += 1;
    if (r.decision === r.correct) correct += 1;
  }
  return { condition, bucket, n, correct, unparseable };
}

export interface HedgeTaxReport {
  condition: Cb7Condition;
  n: number; // parseable settled decisions
  escalated: number;
}

export function hedgeTax(rows: Cb7Row[], condition: Cb7Condition): HedgeTaxReport {
  let n = 0;
  let escalated = 0;
  for (const r of rows) {
    if (r.condition !== condition || r.bucket !== "settled" || r.decision === null) continue;
    n += 1;
    if (r.decision === "hold_escalate") escalated += 1;
  }
  return { condition, n, escalated };
}
