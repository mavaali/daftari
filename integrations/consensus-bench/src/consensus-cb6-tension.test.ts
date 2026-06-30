import { describe, expect, test } from "vitest";
import { tensionPairs, masquerades, buildForcedFoilPrompt } from "./consensus-cb6-tension.js";
import { acquireFoil } from "./consensus-cb4-foil.js";
import type { LlmClient } from "./consensus-llm.js";

describe("tensionPairs (editor-labeled 'no consensus' items, GT = neither supersedes)", () => {
  test("are genuine tension pairs with both positions present", () => {
    expect(tensionPairs.length).toBeGreaterThanOrEqual(4);
    for (const p of tensionPairs) {
      expect(p.statusQuo.length).toBeGreaterThan(0);
      expect(p.alternative.length).toBeGreaterThan(0);
      expect(p.gt).toBe("neither"); // editor 'no consensus' => neither supersedes
      expect(p.rfc).toMatch(/Archive/);
    }
  });
});

describe("masquerades (a forced supersession verdict on a genuine tension is the masquerade)", () => {
  test("any direction is a masquerade; neither is faithful", () => {
    expect(masquerades("a_supersedes_b")).toBe(true);
    expect(masquerades("b_supersedes_a")).toBe(true);
    expect(masquerades("neither")).toBe(false);
  });
});

describe("buildForcedFoilPrompt (the architectural anchor: a single-value store has no tension slot)", () => {
  test("presents both positions and forces a binary supersession — no NEITHER escape", () => {
    const p = buildForcedFoilPrompt("TA", "TB");
    expect(p).toContain("TA");
    expect(p).toContain("TB");
    expect(p).toContain("A_SUPERSEDES_B");
    expect(p).toContain("B_SUPERSEDES_A");
    expect(p.toUpperCase()).not.toContain("NEITHER");
  });
});

describe("acquireFoil model threading (for the foil panel)", () => {
  test("passes the requested model through to the client", async () => {
    let seen = "";
    const spy: LlmClient = { complete: async ({ model }) => { seen = model; return "NEITHER"; } };
    await acquireFoil(spy, "x", "y", "z-ai/glm-4.6");
    expect(seen).toBe("z-ai/glm-4.6");
  });
});
