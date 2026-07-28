// local-qwen3 provider coverage (spec 2026-07-26-embedding-refresh-
// quantization, Phase 1c). Mirrors local-embeddinggemma.test.ts's shape but
// exercises the LAST-TOKEN pooling path (opts.pooling: "none", raw per-token
// output) instead of mean pooling. Mocks @huggingface/transformers entirely
// — see local-embeddinggemma.test.ts's header for why. A real-model smoke
// test exists separately, gated behind DAFTARI_QWEN3_SMOKE (not run here).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real Qwen3-Embedding-0.6B outputs 1024d; this provider exposes at
// most 768d (local-qwen3.ts's EXPOSED_NATIVE_DIM) — the mock's raw output is
// deliberately WIDER than that so the tests exercise the capToNativeDim
// truncation path, not just the identity case.
const FAKE_RAW_DIM = 1024;
const SEQ_LEN = 5;

// Builds a fake [1, SEQ_LEN, FAKE_RAW_DIM] raw per-token tensor (flattened
// row-major) where token i's row is filled with the constant (i + 1) so the
// LAST row is trivially distinguishable from any earlier row.
function fakeRawTokens(): Float32Array {
  const data = new Float32Array(SEQ_LEN * FAKE_RAW_DIM);
  for (let tok = 0; tok < SEQ_LEN; tok++) {
    for (let d = 0; d < FAKE_RAW_DIM; d++) {
      data[tok * FAKE_RAW_DIM + d] = tok + 1;
    }
  }
  return data;
}

const pipelineCalls: Array<{ texts: string[]; opts: unknown }> = [];
let failNext = false;

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async () => {
    if (failNext) {
      failNext = false;
      throw new Error("simulated model load failure");
    }
    return async (texts: string[], opts: { pooling: "mean" | "none"; normalize: boolean }) => {
      pipelineCalls.push({ texts, opts });
      return { data: fakeRawTokens(), dims: [1, SEQ_LEN, FAKE_RAW_DIM] };
    };
  }),
}));

const { makeLocalQwen3Provider, isLocalQwen3Loaded, resetLocalQwen3ForTests } = await import(
  "../../../src/search/providers/local-qwen3.js"
);

describe("local-qwen3 provider", () => {
  beforeEach(() => {
    pipelineCalls.length = 0;
    failNext = false;
    resetLocalQwen3ForTests();
  });
  afterEach(() => {
    resetLocalQwen3ForTests();
  });

  it("exposes an id carrying #p1 and no dim, and caps nativeDim at the exposed ceiling", () => {
    const provider = makeLocalQwen3Provider(512);
    expect(provider.id).toBe("local-qwen3-0.6b#p1");
    expect(provider.id).not.toContain("512");
    expect(provider.dim).toBe(512);
    // Exposed ceiling (768), NOT the real model's native 1024 — the spec
    // text: "Qwen3's 1024d deliberately not offered yet".
    expect(provider.nativeDim).toBe(768);
  });

  it("rejects an unsupported dim", () => {
    expect(() => makeLocalQwen3Provider(1024)).toThrow(/unsupported dim/);
  });

  it("embed() last-token-pools the LAST row, caps to the exposed native dim, and normalizes", async () => {
    const provider = makeLocalQwen3Provider(512);
    const result = await provider.embed(["some document text"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    const vec = result.value[0];
    if (!vec) throw new Error("expected a vector");
    expect(vec.length).toBe(768); // capped, not the raw 1024
    // The last raw token row was constant (SEQ_LEN), so after L2-normalize
    // every component of the pooled (pre-truncation) vector is equal —
    // truncating a subset of equal components and renormalizing keeps them
    // equal, positive, and unit-norm.
    let norm = 0;
    for (const x of vec) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 4);
    expect(vec.every((x) => x > 0)).toBe(true);
    // Document side is unprefixed (bare document, per the spec hypothesis).
    expect(pipelineCalls[0]?.texts[0]).toBe("some document text");
    expect(pipelineCalls[0]?.opts).toMatchObject({ pooling: "none", normalize: false });
  });

  it("embedQuery() applies the instruction prefix and returns configured dim", async () => {
    const provider = makeLocalQwen3Provider(512);
    const result = await provider.embedQuery?.("capital of France");
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value.length).toBe(512);
    expect(pipelineCalls[0]?.texts[0]).toBe(
      "Instruct: Given a search query, retrieve relevant passages | Query: capital of France",
    );
  });

  it("isLoaded() reflects the memoised extractor state", async () => {
    const provider = makeLocalQwen3Provider(512);
    expect(isLocalQwen3Loaded()).toBe(false);
    await provider.warm();
    expect(isLocalQwen3Loaded()).toBe(true);
  });

  it("a load failure returns Result.err and resets the memo so a retry can succeed", async () => {
    const provider = makeLocalQwen3Provider(512);
    failNext = true;
    const result = await provider.embed(["x"]);
    expect(result.ok).toBe(false);
    expect(provider.isLoaded?.()).toBe(false);
    const retry = await provider.embed(["x"]);
    expect(retry.ok).toBe(true);
  });
});
