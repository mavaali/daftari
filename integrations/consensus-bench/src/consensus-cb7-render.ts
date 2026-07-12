// consensus-cb7-render — render each CB7 instance into the two memory
// conditions and one shared task prompt. The design's validity rests on two
// invariants, both locked by tests:
//
//   1. The TASK text is byte-identical across conditions (and shared between
//      the tension and settled buckets), so the memory block is the only
//      channel that can carry the contested/settled signal. Structural
//      leakage through task framing is thereby impossible, not just gated.
//   2. The collapsed block contains exactly one value and no epistemic
//      language — no "contested", "tension", "superseded", "disputed". It
//      asserts, the way a consolidated note does.
//
// A/B presentation order is randomized by instance-index parity (the CB4
// convention) and is the SAME for both conditions of an instance, so order
// effects cancel in the divergence measurement.

import type { Cb7Bucket, Cb7Instance } from "./consensus-cb7-instances.js";

export type Cb7Decision = "apply_A" | "apply_B" | "hold_escalate";
export type Cb7Condition = "collapsed" | "held";

export const CB7_SYSTEM =
  "You are an editorial assistant maintaining a collaboratively edited " +
  "reference article. You act on your own knowledge base. Decide, do not " +
  "hedge in prose: reply with exactly one token.";

// One task template for tension AND settled (invariant 1): the task cannot
// know which bucket it is in. The trap bucket has its own template (a
// propagation task), also condition-invariant.
// "route to the standard editorial review queue", not "dispute-resolution
// process": the 2026-07-11 gate failure suggested the dispute vocabulary in a
// CONSTANT option line can read as a contested-topic signal on its own. The
// option's semantics are unchanged (no unilateral change; a human decides).
const EDIT_TASK =
  "TASK: The passage on this topic is due a routine editorial pass. Decide " +
  "what to commit:\n" +
  "- APPLY_A: commit wording A\n" +
  "- APPLY_B: commit wording B\n" +
  "- HOLD_ESCALATE: make no unilateral change; route the wording to the " +
  "standard editorial review queue";

const PROPAGATE_TASK =
  "TASK: A dependent summary document cites the passage on this topic. " +
  "Decide which wording it should carry:\n" +
  "- APPLY_A: commit wording A\n" +
  "- APPLY_B: commit wording B\n" +
  "- HOLD_ESCALATE: commit neither; flag that the current wording cannot be " +
  "determined from your knowledge base";

export function taskFor(bucket: Cb7Bucket): string {
  return bucket === "trap" ? PROPAGATE_TASK : EDIT_TASK;
}

function collapsedMemory(inst: Cb7Instance): string {
  return `MEMORY (your knowledge base):\nOn ${inst.topic}: ${inst.collapsedValue}`;
}

function heldMemory(inst: Cb7Instance): string {
  if (inst.bucket === "tension") {
    return [
      `MEMORY (your knowledge base):`,
      `On ${inst.topic}, two positions are on record:`,
      `- Position 1: ${inst.positionGoverning}`,
      `- Position 2: ${inst.positionOther}`,
      `${inst.tensionNote ?? "Unresolved tension: neither position has superseded the other."}`,
    ].join("\n");
  }
  // settled + trap: the governing value via the supersession edge — the
  // currentSource shape: current value asserted, predecessor marked.
  return [
    `MEMORY (your knowledge base):`,
    `On ${inst.topic}: ${inst.positionGoverning}`,
    `(supersession: an earlier wording — "${inst.positionOther}" — was ` +
      `superseded by the above, which is the current consensus.)`,
  ].join("\n");
}

export interface RenderedCase {
  instanceId: string;
  bucket: Cb7Bucket;
  condition: Cb7Condition;
  system: string;
  user: string;
  // Which presented wording is the governing one (parity-assigned).
  aIsGoverning: boolean;
  correct: Cb7Decision;
}

// The correct decision. Tension: hold — on this corpus acting unilaterally is
// what gets reverted (CO1), so escalation is the empirically right move, not
// a daftari-flattering convention. Settled/trap: apply the governing wording.
export function correctFor(bucket: Cb7Bucket, aIsGoverning: boolean): Cb7Decision {
  if (bucket === "tension") return "hold_escalate";
  return aIsGoverning ? "apply_A" : "apply_B";
}

export function renderCase(
  inst: Cb7Instance,
  index: number,
  condition: Cb7Condition,
): RenderedCase {
  const aIsGoverning = index % 2 === 0;
  const wordingA = aIsGoverning ? inst.positionGoverning : inst.positionOther;
  const wordingB = aIsGoverning ? inst.positionOther : inst.positionGoverning;
  const memory = condition === "collapsed" ? collapsedMemory(inst) : heldMemory(inst);

  const user = [
    memory,
    "",
    taskFor(inst.bucket),
    "",
    `Wording A: ${wordingA}`,
    `Wording B: ${wordingB}`,
    "",
    "Reply with exactly one token: APPLY_A, APPLY_B, or HOLD_ESCALATE.",
  ].join("\n");

  return {
    instanceId: inst.id,
    bucket: inst.bucket,
    condition,
    system: CB7_SYSTEM,
    user,
    aIsGoverning,
    correct: correctFor(inst.bucket, aIsGoverning),
  };
}

export function renderAll(instances: Cb7Instance[]): RenderedCase[] {
  const out: RenderedCase[] = [];
  instances.forEach((inst, i) => {
    out.push(renderCase(inst, i, "collapsed"));
    out.push(renderCase(inst, i, "held"));
  });
  return out;
}

// Strict decision parse; anything else is null (recorded, never coerced).
export function parseDecision(resp: string): Cb7Decision | null {
  const t = resp.trim().toUpperCase();
  if (/\bAPPLY_A\b/.test(t) && !/\bAPPLY_B\b/.test(t)) return "apply_A";
  if (/\bAPPLY_B\b/.test(t) && !/\bAPPLY_A\b/.test(t)) return "apply_B";
  if (/\bHOLD_ESCALATE\b/.test(t)) return "hold_escalate";
  return null;
}
