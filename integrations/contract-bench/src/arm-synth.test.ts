import { describe, expect, test } from "vitest";
import { ABSTAIN, isAbstain, isFabrication, synthAnswer, synthPrompt } from "./arm-synth.js";

describe("arm-synth — the minting foil", () => {
  test("synthPrompt embeds the clause, the context, and the abstain instruction", () => {
    const p = synthPrompt("11.25", "the last paragraph of Section 11.25 is amended to read X.");
    expect(p).toContain("11.25");
    expect(p).toContain("the last paragraph");
    expect(p).toContain(ABSTAIN);
  });

  test("a model that abstains is NOT a fabrication", async () => {
    const llm = async () => `${ABSTAIN}`;
    const ans = await synthAnswer("11.25", "partial edit only", llm);
    expect(isAbstain(ans)).toBe(true);
    expect(isFabrication(ans)).toBe(false);
  });

  test("a model that asserts a full clause for a trap IS a fabrication", async () => {
    const llm = async () => 'Section 11.25 Notices. All notices shall be in writing and delivered to ...';
    const ans = await synthAnswer("11.25", "partial edit only", llm);
    expect(isFabrication(ans)).toBe(true);
  });

  test("the abstain sentinel buried inside an asserted clause still counts as fabrication", async () => {
    const llm = async () => `The clause currently reads as follows ... (note: ${ABSTAIN} for the first paragraph).`;
    expect(isAbstain(await synthAnswer("11.25", "x", llm))).toBe(false);
  });

  test("abstain detection tolerates trailing punctuation/whitespace", () => {
    expect(isAbstain(`  ${ABSTAIN}.  `)).toBe(true);
  });
});
