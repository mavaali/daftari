// Real-model smoke test for local-qwen3 (spec 2026-07-26-embedding-refresh-
// quantization). Downloads the ~1.5GB q8 ONNX weights on first run — no
// business in default `npm test` — so this whole file is skipped unless
// DAFTARI_QWEN3_SMOKE is set in env:
//
//   DAFTARI_QWEN3_SMOKE=1 npx vitest run test/search/local-qwen3-smoke.test.ts
//
// This is a SANITY check only, and it is the file most likely to fail
// against the real model: local-transformers.ts's last-token pooling path
// (see its file header) is an UNVERIFIED [HYPOTHESIS] pending the governing
// spec's Phase 0 spike, which has not been run in this environment. If this
// file fails, the failure mode to check first is whether
// "pooling: none" on the feature-extraction pipeline actually returns a raw
// per-token [seq_len, hidden] tensor for this model — if not, local-
// transformers.ts needs the AutoModel/AutoTokenizer low-level API instead
// (the spec's named fallback), not a workaround here.

import { describe, expect, it } from "vitest";
import {
  isLocalQwen3Loaded,
  makeLocalQwen3Provider,
  resetLocalQwen3ForTests,
} from "../../src/search/providers/local-qwen3.js";
import { cosineSimilarity } from "../../src/search/vector.js";

describe.skipIf(!process.env.DAFTARI_QWEN3_SMOKE)("local-qwen3 (real model smoke)", () => {
  it("places semantically similar sentences closer than dissimilar ones, at dim=512", async () => {
    resetLocalQwen3ForTests();
    const provider = makeLocalQwen3Provider(512);
    const warm = await provider.warm();
    expect(warm.ok).toBe(true);
    expect(isLocalQwen3Loaded()).toBe(true);

    const result = await provider.embed([
      "a cat sat on the mat",
      "a kitten rested on the rug",
      "quarterly cloud infrastructure budget forecast",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [catA, catB, budget] = result.value;
    if (!catA || !catB || !budget) throw new Error("expected three embeddings");
    expect(catA.length).toBe(768); // embed() returns the exposed native dim
    expect(cosineSimilarity(catA, catB)).toBeGreaterThan(cosineSimilarity(catA, budget));
  }, 300_000);

  it("embedQuery() returns a configured-dim, unit-norm vector", async () => {
    resetLocalQwen3ForTests();
    const provider = makeLocalQwen3Provider(512);
    const result = await provider.embedQuery?.("What is the capital of France?");
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value.length).toBe(512);
    let norm = 0;
    for (const x of result.value) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 3);
  }, 300_000);
});
