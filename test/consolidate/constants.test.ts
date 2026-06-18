import { describe, expect, it } from "vitest";
import {
  CONSOLIDATE_AGENT,
  CONSOLIDATE_BIRTH_TOP_K,
  CONSOLIDATE_DECORRELATION_MIN_LIFT,
  CONSOLIDATE_DEFAULT_BUDGET,
  CONSOLIDATE_DEFAULT_MODEL,
  CONSOLIDATE_MAX_INTERVAL_DAYS,
  CONSOLIDATE_MIN_INTERVAL_DAYS,
  CONSOLIDATE_PANEL_SIZE,
  CONSOLIDATE_PATH_STRENGTH_FLOOR,
  CONSOLIDATE_PROMPT_TEMPLATES,
  CONSOLIDATE_SLICE_FRACTIONS,
  reviewIntervalDays,
} from "../../src/consolidate/constants.js";
import { EDGE_AXES } from "../../src/curation/edges.js";

describe("consolidate constants", () => {
  it("slice fractions sum to 1", () => {
    const { backstop, main, periphery, birth } = CONSOLIDATE_SLICE_FRACTIONS;
    expect(backstop + main + periphery + birth).toBeCloseTo(1, 10);
  });

  it("interval grows with strength and caps at MAX", () => {
    expect(reviewIntervalDays(0)).toBe(CONSOLIDATE_MIN_INTERVAL_DAYS);
    expect(reviewIntervalDays(1)).toBeGreaterThan(reviewIntervalDays(0));
    // 2^7=128 > 90 → strength 7 is the first that saturates the MAX cap; pin it.
    expect(reviewIntervalDays(7)).toBe(CONSOLIDATE_MAX_INTERVAL_DAYS);
    expect(reviewIntervalDays(99)).toBe(CONSOLIDATE_MAX_INTERVAL_DAYS);
  });

  it("path-strength floor is in (0,1)", () => {
    expect(CONSOLIDATE_PATH_STRENGTH_FLOOR).toBeGreaterThan(0);
    expect(CONSOLIDATE_PATH_STRENGTH_FLOOR).toBeLessThan(1);
  });

  it("default budget is a positive integer", () => {
    expect(Number.isInteger(CONSOLIDATE_DEFAULT_BUDGET)).toBe(true);
    expect(CONSOLIDATE_DEFAULT_BUDGET).toBeGreaterThan(0);
  });

  // --- Stage 2 ----------------------------------------------------------------

  it("panel size is a small positive integer (M ≥ 2 so the panel can vary axes)", () => {
    expect(Number.isInteger(CONSOLIDATE_PANEL_SIZE)).toBe(true);
    expect(CONSOLIDATE_PANEL_SIZE).toBeGreaterThanOrEqual(2);
    // CONSOLIDATE_PROMPT_TEMPLATES.length is the v1 axis ceiling; pinning the
    // relationship so an accidental panel-size bump past available axes (which
    // would force same-(observer,axis) replay) is a test failure, not a runtime
    // surprise. Lift this if the axis catalog grows.
    expect(CONSOLIDATE_PANEL_SIZE).toBeLessThanOrEqual(CONSOLIDATE_PROMPT_TEMPLATES.length);
  });

  it("birth top-K matches the §10.2 recall@K kill condition (K=20)", () => {
    expect(CONSOLIDATE_BIRTH_TOP_K).toBe(20);
  });

  it("default model is a non-empty string (Anthropic SDK validates the id at call time)", () => {
    expect(typeof CONSOLIDATE_DEFAULT_MODEL).toBe("string");
    expect(CONSOLIDATE_DEFAULT_MODEL.length).toBeGreaterThan(0);
  });

  it("agent principal claim is the spec §8 string", () => {
    expect(CONSOLIDATE_AGENT).toBe("agent:curation-loop");
  });

  it("prompt templates are the three v1 framings, distinct, non-empty", () => {
    expect(CONSOLIDATE_PROMPT_TEMPLATES).toEqual(["forward", "reverse", "contrast"]);
    expect(new Set(CONSOLIDATE_PROMPT_TEMPLATES).size).toBe(CONSOLIDATE_PROMPT_TEMPLATES.length);
  });

  it("there are at least as many store axes as panel votes (distinct-axes precondition)", () => {
    // The revision panel maps each surviving vote to a DISTINCT store axis via
    // EDGE_AXES[i % EDGE_AXES.length]; if the prompt templates ever outgrow the
    // store axes, that modulo would silently reuse an axis and collapse the
    // §11.3 replay guard. Fail here at test time, not at runtime.
    expect(CONSOLIDATE_PROMPT_TEMPLATES.length).toBeLessThanOrEqual(EDGE_AXES.length);
  });

  it("decorrelation min lift is in (0, 1) — small positive lift the panel must beat", () => {
    expect(CONSOLIDATE_DECORRELATION_MIN_LIFT).toBeGreaterThan(0);
    expect(CONSOLIDATE_DECORRELATION_MIN_LIFT).toBeLessThan(1);
  });
});
