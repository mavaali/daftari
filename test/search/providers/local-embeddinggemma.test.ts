// local-embeddinggemma provider coverage (spec 2026-07-26-embedding-refresh-
// quantization, Phase 1c). Mirrors local-minilm.test.ts's shape (id, dim,
// embed shape) but mocks @huggingface/transformers entirely — this provider
// downloads a ~600MB q8 ONNX model on first real use, which has no business
// in default `npm test` (see the file header of local-transformers.ts and
// the governing spec's Phase 0, which has NOT been run against a real model
// in this environment). A real-model smoke test exists separately, gated
// behind DAFTARI_EMBEDDINGGEMMA_SMOKE (not run here).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deterministic fake "mean-pooled, normalized" extractor: each input text
// maps to a fixed-length vector derived from its char codes, so different
// texts (e.g. prefixed vs unprefixed) produce distinguishably different
// output — enough to assert the provider applied its prompt prefix without
// needing real semantics.
const FAKE_NATIVE_DIM = 768;
function fakeVectorFor(text: string): Float32Array {
  const v = new Float32Array(FAKE_NATIVE_DIM);
  for (let i = 0; i < FAKE_NATIVE_DIM; i++) {
    v[i] = Math.sin(i + 1) * ((text.charCodeAt(i % text.length) ?? 1) + 1);
  }
  // L2-normalize, matching what pooling:"mean", normalize:true would return.
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += (v[i] as number) * (v[i] as number);
  const inv = 1 / Math.sqrt(norm || 1);
  for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) * inv;
  return v;
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
      // Mean-pooling batched shape: [batch, dim] flattened.
      const data = new Float32Array(texts.length * FAKE_NATIVE_DIM);
      texts.forEach((t, i) => {
        data.set(fakeVectorFor(t), i * FAKE_NATIVE_DIM);
      });
      return { data, dims: [texts.length, FAKE_NATIVE_DIM] };
    };
  }),
}));

// Imported AFTER the mock is registered (vitest hoists vi.mock calls above
// imports automatically).
const {
  makeLocalEmbeddingGemmaProvider,
  isLocalEmbeddingGemmaLoaded,
  resetLocalEmbeddingGemmaForTests,
} = await import("../../../src/search/providers/local-embeddinggemma.js");

describe("local-embeddinggemma provider", () => {
  beforeEach(() => {
    pipelineCalls.length = 0;
    failNext = false;
    resetLocalEmbeddingGemmaForTests();
  });
  afterEach(() => {
    resetLocalEmbeddingGemmaForTests();
  });

  it("exposes an id carrying #p1 and no dim, and the configured dim", () => {
    const provider = makeLocalEmbeddingGemmaProvider(512);
    expect(provider.id).toBe("local-embeddinggemma#p1");
    expect(provider.id).not.toContain("512");
    expect(provider.dim).toBe(512);
    expect(provider.nativeDim).toBe(768);
  });

  it("rejects an unsupported dim (not a trained Matryoshka point)", () => {
    expect(() => makeLocalEmbeddingGemmaProvider(384)).toThrow(/unsupported dim/);
  });

  it("embed() returns NATIVE-dim vectors with the document prefix applied", async () => {
    const provider = makeLocalEmbeddingGemmaProvider(512);
    const result = await provider.embed(["hello world"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.length).toBe(768);
    expect(pipelineCalls[0]?.texts[0]).toBe("title: none | text: hello world");
    expect(pipelineCalls[0]?.opts).toMatchObject({ pooling: "mean", normalize: true });
  });

  it("embedQuery() returns CONFIGURED-dim vectors with the query prefix applied", async () => {
    const provider = makeLocalEmbeddingGemmaProvider(512);
    expect(provider.embedQuery).toBeTypeOf("function");
    const result = await provider.embedQuery?.("what is the capital");
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value.length).toBe(512);
    expect(pipelineCalls[0]?.texts[0]).toBe("task: search result | query: what is the capital");
    // Truncated + renormalized: unit length.
    let norm = 0;
    for (const x of result.value) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 4);
  });

  it("embedQuery() at dim=768 (no truncation) returns the untruncated vector", async () => {
    const provider = makeLocalEmbeddingGemmaProvider(768);
    const result = await provider.embedQuery?.("q");
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value.length).toBe(768);
  });

  it("isLoaded() reflects the memoised extractor state", async () => {
    const provider = makeLocalEmbeddingGemmaProvider(512);
    expect(isLocalEmbeddingGemmaLoaded()).toBe(false);
    expect(provider.isLoaded?.()).toBe(false);
    await provider.warm();
    expect(isLocalEmbeddingGemmaLoaded()).toBe(true);
    expect(provider.isLoaded?.()).toBe(true);
  });

  it("a load failure returns Result.err and resets the memo so a retry can succeed", async () => {
    const provider = makeLocalEmbeddingGemmaProvider(512);
    failNext = true;
    const result = await provider.embed(["x"]);
    expect(result.ok).toBe(false);
    expect(provider.isLoaded?.()).toBe(false);

    // Retry succeeds — the memo was reset, not poisoned for the process.
    const retry = await provider.embed(["x"]);
    expect(retry.ok).toBe(true);
    expect(provider.isLoaded?.()).toBe(true);
  });
});
