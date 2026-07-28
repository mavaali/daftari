// Real-model smoke test for local-bge-m3 (spec 2026-07-26-contextual-
// chunking-reranker-design.md §3.2). Downloads the ~600MB q8 ONNX weights on
// first run — a 600MB download has no business in default `npm test`, so
// this whole file is skipped unless DAFTARI_BGE_SMOKE is set in env:
//
//   DAFTARI_BGE_SMOKE=1 npx vitest run test/search/local-bge-m3-smoke.test.ts
//
// This is the §3.2 latency spike's SANITY half (ordering makes sense over a
// fixture query + 5 passages). The MEASURED half (published per-50-pair CPU
// latency, the actual merge precondition for Part B) is a throwaway script
// run from the scratchpad per the plan, not this committed test.

import { describe, expect, it } from "vitest";
import {
  localBgeM3Provider,
  resetLocalBgeM3ForTests,
} from "../../src/search/providers/local-bge-m3.js";

describe.skipIf(!process.env.DAFTARI_BGE_SMOKE)("local-bge-m3 (real model smoke)", () => {
  it("scores an obviously-relevant passage above an obviously-irrelevant one", async () => {
    resetLocalBgeM3ForTests();
    const warm = await localBgeM3Provider.warm();
    expect(warm.ok).toBe(true);
    expect(localBgeM3Provider.isReady()).toBe(true);

    const query = "What is the capital of France?";
    const passages = [
      "Paris is the capital and most populous city of France.",
      "The mitochondria is the powerhouse of the cell.",
      "Quarterly revenue grew 12% driven by cloud infrastructure spend.",
    ];
    const result = await localBgeM3Provider.rerank(query, passages);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(passages.length);
    const [parisScore, mitoScore, revenueScore] = result.value;
    expect(parisScore).toBeGreaterThan(mitoScore as number);
    expect(parisScore).toBeGreaterThan(revenueScore as number);
  }, 120_000);
});
