// consensus-judge — blind cross-family judge. Maps Arm B's free-text answer to
// two randomized, unlabeled candidate texts (governing vs stale) or neither. The
// judge never learns which candidate is "correct"; the caller knows the order
// (governingOption) and maps back.
// NB: the spec lists a 'refusal' judge verdict; we deliberately omit it — refusal
// is a property of Arm B's ANSWER ("CANNOT DETERMINE"), checked via isRefusal in
// classifyArmB, so a refusal never reaches the judge.
import { isRefusal } from "./consensus-arm-b.js";

export type JudgeVerdict = "option1" | "option2" | "neither";
export type ArmBClass = "governing" | "stale" | "abstain" | "other";

export function buildJudgePrompt(answer: string, candA: string, candB: string): string {
  return [
    "Compare the Answer to two reference texts and decide which one it expresses",
    "the same content as.",
    "",
    `Answer: ${answer}`,
    "",
    `Option 1: ${candA}`,
    `Option 2: ${candB}`,
    "",
    "Reply with exactly 'OPTION 1', 'OPTION 2', or 'NEITHER'.",
  ].join("\n");
}

export function parseJudge(resp: string): JudgeVerdict {
  if (/option\s*1\b/i.test(resp)) return "option1";
  if (/option\s*2\b/i.test(resp)) return "option2";
  return "neither";
}

export function classifyArmB(answer: string, verdict: JudgeVerdict, governingOption: 1 | 2): ArmBClass {
  if (isRefusal(answer)) return "abstain";
  if (verdict === "neither") return "other";
  const chosen = verdict === "option1" ? 1 : 2;
  return chosen === governingOption ? "governing" : "stale";
}
