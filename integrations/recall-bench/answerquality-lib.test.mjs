import { describe, it, expect } from "vitest";
import { mulberry32, shuffleSeeded } from "./answerquality-lib.mjs";

describe("mulberry32", () => {
  it("is deterministic for a fixed seed", () => {
    const a = mulberry32(42); const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  it("differs across seeds", () => {
    expect(mulberry32(1)()).not.toEqual(mulberry32(2)());
  });
  it("returns values in [0,1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 100; i++) { const v = r(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});

describe("shuffleSeeded", () => {
  it("is a deterministic permutation that preserves elements", () => {
    const xs = [1,2,3,4,5,6,7,8,9,10];
    const a = shuffleSeeded(xs, 99); const b = shuffleSeeded(xs, 99);
    expect(a).toEqual(b);
    expect([...a].sort((x,y)=>x-y)).toEqual(xs);
    expect(a).not.toEqual(xs);
  });
  it("does not mutate the input", () => {
    const xs = [1,2,3]; shuffleSeeded(xs, 1); expect(xs).toEqual([1,2,3]);
  });
});
