import { describe, it, expect } from "vitest";
import { mulberry32, shuffleSeeded, stratifiedSample } from "./answerquality-lib.mjs";

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

function mkRecs(n, relLen, idPrefix) {
  return Array.from({ length: n }, (_, i) => ({
    qa: { id: `${idPrefix}-${i}`, relevantDays: Array.from({ length: relLen }, (_, d) => d + 1) },
  }));
}

describe("stratifiedSample", () => {
  const pool = [
    ...mkRecs(30, 1, "s"),
    ...mkRecs(8, 2, "b2"), ...mkRecs(8, 3, "b3"), ...mkRecs(8, 4, "b4"),
    ...mkRecs(8, 5, "b5"), ...mkRecs(8, 6, "b6"), ...mkRecs(60, 7, "b7"),
  ];

  it("returns the requested single/multi counts and tags strata", () => {
    const out = stratifiedSample(pool, { nSingle: 20, nMulti: 30, multiBucketCap: 6, seed: 1 });
    expect(out.filter((r) => r.stratum === "single")).toHaveLength(20);
    expect(out.filter((r) => r.stratum === "multi")).toHaveLength(30);
  });

  it("caps any single multi-day bucket at multiBucketCap (so 7-day can't dominate)", () => {
    const out = stratifiedSample(pool, { nSingle: 0, nMulti: 30, multiBucketCap: 6, seed: 1 });
    const byLen = {};
    for (const r of out) { const L = r.qa.relevantDays.length; byLen[L] = (byLen[L] || 0) + 1; }
    for (const L of Object.keys(byLen)) expect(byLen[L]).toBeLessThanOrEqual(6);
  });

  it("is deterministic for a fixed seed", () => {
    const a = stratifiedSample(pool, { nSingle: 20, nMulti: 30, multiBucketCap: 6, seed: 7 });
    const b = stratifiedSample(pool, { nSingle: 20, nMulti: 30, multiBucketCap: 6, seed: 7 });
    expect(a.map((r) => r.qa.id)).toEqual(b.map((r) => r.qa.id));
  });

  it("never returns duplicates", () => {
    const out = stratifiedSample(pool, { nSingle: 20, nMulti: 30, multiBucketCap: 6, seed: 3 });
    expect(new Set(out.map((r) => r.qa.id)).size).toBe(out.length);
  });
});
