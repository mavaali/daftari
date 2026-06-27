import { describe, expect, test } from "vitest";
import { rankCandidates } from "./select.js";
import type { ChainScore } from "./score.js";

const s = (chainId: string, length: number, rate: number, unitType: ChainScore["unitType"] = "mixed"): ChainScore =>
  ({ chainId, cik: "1", length, unitType, totalOps: 10, unrecoverableOps: Math.round(rate * 10), unrecoverableRate: rate });

describe("rankCandidates", () => {
  test("selects length>=minLength AND rate<=maxUnrecoverable, sorted by rate ascending", () => {
    const scores = [s("hi", 4, 0.5), s("clean", 4, 0.05), s("short", 2, 0.0), s("ok", 3, 0.15)];
    const { selected } = rankCandidates(scores, { minLength: 3, maxUnrecoverable: 0.2 });
    expect(selected.map((x) => x.chainId)).toEqual(["clean", "ok"]); // "hi" rate too high, "short" too short
  });
  test("the distribution counts ALL scores regardless of selection", () => {
    const scores = [s("a", 4, 0.05), s("b", 2, 0.95, "section"), s("c", 5, 0.15, "defined-term")];
    const { distribution } = rankCandidates(scores, { minLength: 3, maxUnrecoverable: 0.2 });
    expect(distribution.total).toBe(3);
    expect(distribution.unitTypeCounts).toEqual({ mixed: 1, section: 1, "defined-term": 1 });
    expect(distribution.rateBuckets["0.0-0.1"]).toBe(1);
    expect(distribution.rateBuckets["0.1-0.2"]).toBe(1);
    expect(distribution.rateBuckets["0.9-1.0"]).toBe(1);
  });
});
