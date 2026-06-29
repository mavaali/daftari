import { describe, expect, test } from "vitest";
import { buildArmBPrompt, isRefusal, armB, classifyNoMint, buildNoMintPrompt } from "./consensus-arm-b.js";
import type { LlmClient } from "./consensus-llm.js";

const stub = (reply: string): LlmClient => ({ complete: async () => reply });

describe("buildArmBPrompt", () => {
  test("shows both versions chronologically and offers CANNOT DETERMINE", () => {
    const p = buildArmBPrompt({ governingText: "OLD", staleText: "NEW" });
    expect(p).toContain("OLD");
    expect(p).toContain("NEW");
    expect(p.indexOf("OLD")).toBeLessThan(p.indexOf("NEW")); // older first
    expect(p).toContain("CANNOT DETERMINE");
  });
});

describe("isRefusal", () => {
  test("detects the cannot-determine refusal", () => {
    expect(isRefusal("CANNOT DETERMINE")).toBe(true);
    expect(isRefusal("  cannot determine.  ")).toBe(true);
    expect(isRefusal("The current consensus is X.")).toBe(false);
  });
});

describe("armB", () => {
  test("sends the prompt and returns the model's answer", async () => {
    const out = await armB(stub("answer text"), { governingText: "OLD", staleText: "NEW" });
    expect(out).toBe("answer text");
  });
});

describe("classifyNoMint", () => {
  test("refusal => abstain (correct), assertion => fabricate", () => {
    expect(classifyNoMint("CANNOT DETERMINE")).toBe("abstain");
    expect(classifyNoMint("The consensus is to use the 2017 portrait.")).toBe("fabricate");
  });
});

describe("buildNoMintPrompt", () => {
  test("includes the context + absent-topic question + CANNOT DETERMINE, answer-from-passage-only", () => {
    const p = buildNoMintPrompt("CTX", "What is the consensus on Y?");
    expect(p).toContain("CTX");
    expect(p).toContain("What is the consensus on Y?");
    expect(p).toContain("CANNOT DETERMINE");
    expect(p).toMatch(/only/i);
  });
});
