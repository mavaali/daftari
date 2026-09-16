import { describe, expect, it } from "vitest";
import { meanOf, ndcgAtK, recallAtK, reciprocalRank } from "../../src/search/retrieval-metrics.js";

describe("recallAtK", () => {
  it("full recall when every relevant doc is within k", () => {
    expect(recallAtK(["a", "b", "c"], ["a", "c"], 3)).toBe(1);
  });

  it("partial recall when only some relevant docs are within k", () => {
    expect(recallAtK(["a", "x", "y"], ["a", "b"], 3)).toBe(0.5);
  });

  it("zero recall when k excludes every relevant doc", () => {
    expect(recallAtK(["x", "y", "a"], ["a"], 2)).toBe(0);
  });

  it("null for a query with no relevant docs", () => {
    expect(recallAtK(["a", "b"], [], 5)).toBeNull();
  });

  it("only counts within the top k, not the full ranked list", () => {
    expect(recallAtK(["x", "y", "a"], ["a"], 3)).toBe(1);
    expect(recallAtK(["x", "y", "a"], ["a"], 2)).toBe(0);
  });
});

describe("reciprocalRank", () => {
  it("1.0 when the first result is relevant", () => {
    expect(reciprocalRank(["a", "b"], ["a"])).toBe(1);
  });

  it("1/rank when the first relevant result is later", () => {
    expect(reciprocalRank(["x", "y", "a"], ["a"])).toBeCloseTo(1 / 3);
  });

  it("0 when no relevant doc is retrieved at all", () => {
    expect(reciprocalRank(["x", "y"], ["a"])).toBe(0);
  });

  it("uses the earliest-ranked relevant doc among several", () => {
    expect(reciprocalRank(["x", "b", "a"], ["a", "b"])).toBeCloseTo(1 / 2);
  });

  it("null for a query with no relevant docs", () => {
    expect(reciprocalRank(["a", "b"], [])).toBeNull();
  });
});

describe("ndcgAtK", () => {
  it("1.0 for a perfectly-ordered ranking", () => {
    expect(ndcgAtK(["a", "b", "x"], ["a", "b"], 3)).toBeCloseTo(1);
  });

  it("less than 1.0 when relevant docs are out of ideal order", () => {
    const score = ndcgAtK(["x", "a", "b"], ["a", "b"], 3);
    expect(score).not.toBeNull();
    expect(score as number).toBeLessThan(1);
    expect(score as number).toBeGreaterThan(0);
  });

  it("0 when no relevant doc appears within k", () => {
    expect(ndcgAtK(["x", "y", "z"], ["a"], 3)).toBe(0);
  });

  it("ignores relevant docs beyond k", () => {
    // Only 1 of 2 relevant docs is reachable within k=1, so the ideal DCG
    // at k=1 is based on 1 relevant slot, and it's filled -> perfect score.
    expect(ndcgAtK(["a", "x", "b"], ["a", "b"], 1)).toBeCloseTo(1);
  });

  it("null for a query with no relevant docs", () => {
    expect(ndcgAtK(["a", "b"], [], 3)).toBeNull();
  });
});

describe("meanOf", () => {
  it("averages defined values", () => {
    expect(meanOf([1, 0.5, 0])).toBeCloseTo(0.5);
  });

  it("excludes nulls rather than treating them as 0", () => {
    expect(meanOf([1, null, 0])).toBeCloseTo(0.5);
  });

  it("null when every value is excluded", () => {
    expect(meanOf([null, null])).toBeNull();
  });
});
