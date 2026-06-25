import { describe, it, expect } from "vitest";
import { mulberry32, shuffleSeeded, stratifiedSample, pairedBootstrapCI, composite, assembleContext, answererPrompt, judgePrompt, JUDGE_SCHEMA } from "./answerquality-lib.mjs";

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

describe("composite", () => {
  it("sums correctness + completeness + hallucination (SP1 rubric, max 6)", () => {
    expect(composite({ correctness: 3, completeness: 2, hallucination: 1 })).toBe(6);
    expect(composite({ correctness: 0, completeness: 0, hallucination: 0 })).toBe(0);
  });
});

describe("pairedBootstrapCI", () => {
  it("mean equals the arithmetic mean of deltas", () => {
    const { mean } = pairedBootstrapCI([1, 1, 1, 1], { iters: 200, seed: 1, alpha: 0.05 });
    expect(mean).toBeCloseTo(1, 6);
  });
  it("CI brackets the mean and is deterministic", () => {
    const d = [0.2, -0.1, 0.3, 0.0, 0.5, -0.2, 0.4, 0.1];
    const a = pairedBootstrapCI(d, { iters: 500, seed: 9, alpha: 0.05 });
    const b = pairedBootstrapCI(d, { iters: 500, seed: 9, alpha: 0.05 });
    expect(a).toEqual(b);
    expect(a.lo).toBeLessThanOrEqual(a.mean);
    expect(a.hi).toBeGreaterThanOrEqual(a.mean);
  });
  it("all-zero deltas give a zero-width CI at zero", () => {
    const { mean, lo, hi } = pairedBootstrapCI([0, 0, 0], { iters: 100, seed: 2, alpha: 0.05 });
    expect(mean).toBe(0); expect(lo).toBe(0); expect(hi).toBe(0);
  });
});

describe("assembleContext", () => {
  const best = new Map([["a.md", "best chunk A"], ["b.md", "best chunk B"]]);
  const full = new Map([["a.md", "FULL A ".repeat(500)], ["c.md", "FULL C body here"]]);

  it("uses best chunk per path, in ranked order, each prefixed with its path", () => {
    const ctx = assembleContext(["a.md", "b.md"], best, full, { fallbackChars: 1500 });
    expect(ctx.indexOf("a.md")).toBeLessThan(ctx.indexOf("b.md")); // ranked order preserved
    expect(ctx).toContain("best chunk A");
    expect(ctx).toContain("best chunk B");
  });

  it("falls back to first fallbackChars of body when no chunk matched", () => {
    const ctx = assembleContext(["c.md"], best, full, { fallbackChars: 8 });
    expect(ctx).toContain("c.md");
    expect(ctx).toContain("FULL C b"); // first 8 chars
  });

  it("reports total chars and per-doc source for cost/validity logging", () => {
    const { text, totalChars, sources } = assembleContext(["a.md", "c.md"], best, full, { fallbackChars: 8 }, { detailed: true });
    expect(typeof text).toBe("string");
    expect(totalChars).toBe(text.length);
    expect(sources).toEqual([{ path: "a.md", source: "chunk" }, { path: "c.md", source: "fallback" }]);
  });
});

describe("prompts", () => {
  it("answerer prompt embeds context + question and instructs context-only answering", () => {
    const p = answererPrompt("CTX", "Q?");
    expect(p).toContain("CTX"); expect(p).toContain("Q?");
    expect(p.toLowerCase()).toContain("only the");
  });
  it("judge prompt embeds question, reference, candidate; schema has the three axes", () => {
    const p = judgePrompt("Q?", "REF", "CAND");
    expect(p).toContain("Q?"); expect(p).toContain("REF"); expect(p).toContain("CAND");
    expect(JUDGE_SCHEMA.required).toEqual(expect.arrayContaining(["correctness", "completeness", "hallucination", "reasoning"]));
  });
});
