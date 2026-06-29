import { describe, expect, test } from "vitest";
import { armA, classifyAnswer } from "./consensus-arm-a.js";
import type { ParsedPassage } from "./consensus-passage.js";

const passage: ParsedPassage = { staleText: "stale value", governingText: "governing value", scorable: true };

describe("armA (stream-recency)", () => {
  test("returns the stale value at the bad-edit snapshot (fails)", () => {
    const a = armA(passage, "before");
    expect(a.answer).toBe("stale value");
    expect(classifyAnswer(a.answer, passage)).toBe("stale");
  });

  test("returns the governing value once the revert is ingested (fair-foil passes)", () => {
    const a = armA(passage, "after");
    expect(a.answer).toBe("governing value");
    expect(classifyAnswer(a.answer, passage)).toBe("governing");
  });
});

describe("classifyAnswer", () => {
  test("normalizes whitespace/case when matching", () => {
    expect(classifyAnswer("  Governing   VALUE ", passage)).toBe("governing");
  });
  test("returns 'other' for an unrelated answer", () => {
    expect(classifyAnswer("something else", passage)).toBe("other");
  });
});
