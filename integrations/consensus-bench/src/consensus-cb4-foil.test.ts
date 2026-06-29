import { describe, expect, test } from "vitest";
import { buildFoilPrompt, parseFoil, classifyFoilTrue, classifyFoilControl, acquireFoil } from "./consensus-cb4-foil.js";
import type { LlmClient } from "./consensus-llm.js";

const stub = (reply: string): LlmClient => ({ complete: async () => reply });

describe("buildFoilPrompt", () => {
  test("presents A and B and forces a directional supersession verdict", () => {
    const p = buildFoilPrompt("TA", "TB");
    expect(p).toContain("TA");
    expect(p).toContain("TB");
    expect(p).toContain("A_SUPERSEDES_B");
    expect(p).toContain("B_SUPERSEDES_A");
    expect(p).toContain("NEITHER");
  });
});

describe("parseFoil", () => {
  test("parses the three verdicts (tolerant)", () => {
    expect(parseFoil("A_SUPERSEDES_B")).toBe("a_supersedes_b");
    expect(parseFoil("answer: b_supersedes_a")).toBe("b_supersedes_a");
    expect(parseFoil("NEITHER")).toBe("neither");
    expect(parseFoil("unclear")).toBe("neither");
  });
});

describe("classifyFoilTrue (governingSide tells which slot is governing/current)", () => {
  test("verdict naming governing as superseder => correct (both slots)", () => {
    expect(classifyFoilTrue("a_supersedes_b", "A")).toBe("correct");
    expect(classifyFoilTrue("b_supersedes_a", "B")).toBe("correct");
  });
  test("verdict naming stale as superseder => wrong-direction (fabrication)", () => {
    expect(classifyFoilTrue("b_supersedes_a", "A")).toBe("wrong-direction");
    expect(classifyFoilTrue("a_supersedes_b", "B")).toBe("wrong-direction");
  });
  test("neither => neither", () => {
    expect(classifyFoilTrue("neither", "A")).toBe("neither");
  });
});

describe("classifyFoilControl (no relation exists)", () => {
  test("any supersession assertion => fabricate; neither => correct", () => {
    expect(classifyFoilControl("a_supersedes_b")).toBe("fabricate");
    expect(classifyFoilControl("b_supersedes_a")).toBe("fabricate");
    expect(classifyFoilControl("neither")).toBe("correct");
  });
});

describe("acquireFoil", () => {
  test("returns the parsed verdict", async () => {
    expect(await acquireFoil(stub("A_SUPERSEDES_B"), "x", "y")).toBe("a_supersedes_b");
  });
});
