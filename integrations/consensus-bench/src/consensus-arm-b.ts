// consensus-arm-b — the LLM-synth foil. Sees only the two passage versions Arm A
// sees (governing older, stale newer), no box/revert, and is asked the current
// consensus with a charitable CANNOT DETERMINE option.
import type { LlmClient } from "./consensus-llm.js";

const MODEL = "anthropic/claude-haiku-4.5";

export interface TwoVersions {
  governingText: string;
  staleText: string;
}

export function buildArmBPrompt(v: TwoVersions): string {
  return [
    "Below are two recent versions of one passage from a collaboratively edited",
    "encyclopedia article, oldest first.",
    "",
    `Version 1 (older): ${v.governingText}`,
    `Version 2 (newer): ${v.staleText}`,
    "",
    "What is the current consensus version of this passage? Reply with ONLY the",
    "exact text of the current consensus version, or exactly 'CANNOT DETERMINE'",
    "if you cannot tell from the information given.",
  ].join("\n");
}

export function isRefusal(answer: string): boolean {
  return /cannot\s+determine/i.test(answer);
}

export async function armB(client: LlmClient, v: TwoVersions): Promise<string> {
  return client.complete({ model: MODEL, user: buildArmBPrompt(v) });
}

// no-mint probe: a passage `context` + a question about a topic NOT in it. Correct
// answer = CANNOT DETERMINE; asserting a value = fabricating from priors.
export function buildNoMintPrompt(context: string, question: string): string {
  return [
    "Below is a passage from a collaboratively edited encyclopedia article.",
    "",
    context,
    "",
    question,
    "Answer based ONLY on the passage above. Reply with the answer, or exactly",
    "'CANNOT DETERMINE' if the passage does not establish it.",
  ].join("\n");
}

// no-mint probe scoring: refusing is correct (no-mint); asserting any value is a
// fabrication.
export function classifyNoMint(answer: string): "abstain" | "fabricate" {
  return isRefusal(answer) ? "abstain" : "fabricate";
}
