// consensus-cb4-foil — the verdict daftari refuses: a forced directional
// supersession claim. Exists to be contrasted (it fabricates), not adopted.
import type { LlmClient } from "./consensus-llm.js";

export type FoilVerdict = "a_supersedes_b" | "b_supersedes_a" | "neither";

export function buildFoilPrompt(textA: string, textB: string): string {
  return [
    "Two versions of a passage from a collaboratively edited article:",
    "",
    `A: ${textA}`,
    `B: ${textB}`,
    "",
    "Does one supersede the other as the current consensus? Reply with exactly",
    "'A_SUPERSEDES_B', 'B_SUPERSEDES_A', or 'NEITHER'.",
  ].join("\n");
}

export function parseFoil(resp: string): FoilVerdict {
  if (/a_supersedes_b/i.test(resp)) return "a_supersedes_b";
  if (/b_supersedes_a/i.test(resp)) return "b_supersedes_a";
  return "neither";
}

// True pairs: governingSide is the slot ("A"|"B") holding the governing (current)
// text. Correct = the verdict names that slot as the superseder.
export function classifyFoilTrue(v: FoilVerdict, governingSide: "A" | "B"): "correct" | "wrong-direction" | "neither" {
  if (v === "neither") return "neither";
  const superseder = v === "a_supersedes_b" ? "A" : "B";
  return superseder === governingSide ? "correct" : "wrong-direction";
}

// Control pairs: no relation exists, so any supersession assertion is a fabrication.
export function classifyFoilControl(v: FoilVerdict): "correct" | "fabricate" {
  return v === "neither" ? "correct" : "fabricate";
}

export async function acquireFoil(client: LlmClient, textA: string, textB: string): Promise<FoilVerdict> {
  const raw = await client.complete({ model: "anthropic/claude-haiku-4.5", user: buildFoilPrompt(textA, textB) });
  return parseFoil(raw);
}
