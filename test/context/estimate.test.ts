import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../src/context/estimate.js";

describe("estimateTokens — chars/4, ceil", () => {
  it("empty string is 0 tokens", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("divides length by 4 and rounds up", () => {
    expect(estimateTokens("a")).toBe(1); // 1/4 -> ceil -> 1
    expect(estimateTokens("abcd")).toBe(1); // 4/4 -> 1
    expect(estimateTokens("abcde")).toBe(2); // 5/4 -> ceil -> 2
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("a".repeat(401))).toBe(101);
  });

  it("is deterministic across repeated calls", () => {
    const s = "the quick brown fox jumps over the lazy dog";
    expect(estimateTokens(s)).toBe(estimateTokens(s));
  });
});
