import { describe, expect, test } from "vitest";
import { buildJudgePrompt, parseJudge, classifyArmB } from "./consensus-judge.js";

describe("buildJudgePrompt", () => {
  test("includes the answer and both candidates as Option 1 / Option 2", () => {
    const p = buildJudgePrompt("ANS", "CANDA", "CANDB");
    expect(p).toContain("ANS");
    expect(p).toContain("Option 1");
    expect(p).toContain("CANDA");
    expect(p).toContain("Option 2");
    expect(p).toContain("CANDB");
    expect(p).toContain("NEITHER");
  });
});

describe("parseJudge", () => {
  test("parses OPTION 1 / OPTION 2 / NEITHER (case/space tolerant)", () => {
    expect(parseJudge("OPTION 1")).toBe("option1");
    expect(parseJudge("the answer is option 2.")).toBe("option2");
    expect(parseJudge("NEITHER")).toBe("neither");
    expect(parseJudge("unclear blah")).toBe("neither"); // ambiguous => neither
  });
});

describe("classifyArmB", () => {
  // governingOption tells which option held the governing text in this trial.
  test("refusal => abstain regardless of verdict", () => {
    expect(classifyArmB("CANNOT DETERMINE", "option1", 1)).toBe("abstain");
  });
  test("verdict on the governing option => governing (both orders)", () => {
    expect(classifyArmB("some text", "option1", 1)).toBe("governing");
    expect(classifyArmB("some text", "option2", 2)).toBe("governing");
  });
  test("verdict on the non-governing option => stale (both orders)", () => {
    expect(classifyArmB("some text", "option2", 1)).toBe("stale");
    expect(classifyArmB("some text", "option1", 2)).toBe("stale");
  });
  test("neither => other (fabrication)", () => {
    expect(classifyArmB("some text", "neither", 1)).toBe("other");
  });
});
