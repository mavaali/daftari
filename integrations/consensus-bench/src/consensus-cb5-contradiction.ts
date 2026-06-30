// consensus-cb5-contradiction — the RIGHT lens for competing-version conflicts:
// a symmetric contradiction detector. It asks only "are these two in conflict?",
// NEVER which one wins — so it is structurally incapable of minting a supersession
// (it flags the tension, like vault_tension_log, and leaves the verdict to a human).
// Bespoke: daftari ships no such pass; this measures detectability + no-mint-compat.
import type { LlmClient } from "./consensus-llm.js";

export type ContradictionVerdict = "yes" | "no";

export function buildContradictionPrompt(textA: string, textB: string): string {
  return [
    "Two versions of a passage from a collaboratively edited article:",
    "",
    `A: ${textA}`,
    `B: ${textB}`,
    "",
    "Are these two in conflict — incompatible statements of the same thing that",
    "cannot both be true at once? Do NOT judge correctness, recency, or precedence;",
    "only say whether they conflict. Reply with exactly",
    "'YES_CONFLICT' or 'NO_CONFLICT', then a one-line reason.",
  ].join("\n");
}

// Conservative: only an explicit YES token flags a conflict; anything else
// (including unparseable) is NO, so the detector never invents a false conflict.
export function parseContradiction(resp: string): ContradictionVerdict {
  return /yes_conflict/i.test(resp) ? "yes" : "no";
}

export async function acquireContradiction(client: LlmClient, textA: string, textB: string): Promise<ContradictionVerdict> {
  const raw = await client.complete({ model: "anthropic/claude-haiku-4.5", user: buildContradictionPrompt(textA, textB) });
  return parseContradiction(raw);
}
