import { describe, expect, it } from "vitest";
import {
  CONSOLIDATE_DEFAULT_BUDGET,
  CONSOLIDATE_MAX_INTERVAL_DAYS,
  CONSOLIDATE_MIN_INTERVAL_DAYS,
  CONSOLIDATE_PATH_STRENGTH_FLOOR,
  CONSOLIDATE_SLICE_FRACTIONS,
  reviewIntervalDays,
} from "../../src/consolidate/constants.js";

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
});
