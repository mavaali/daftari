import { describe, expect, it } from "vitest";
import {
  chunkText,
  cosineSimilarity,
  EMBEDDING_DIM,
  embed,
  meanEmbedding,
} from "../../src/search/vector.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
  });

  it("is -1 for opposite vectors", () => {
    expect(cosineSimilarity(new Float32Array([1, 1]), new Float32Array([-1, -1]))).toBeCloseTo(-1);
  });

  it("is 0 for length mismatch or a zero vector", () => {
    expect(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([1]))).toBe(0);
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });
});

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkText("a short paragraph")).toEqual(["a short paragraph"]);
  });

  it("splits long text into multiple chunks under the size cap", () => {
    const para = "word ".repeat(400); // ~2000 chars in one paragraph
    const chunks = chunkText(para);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 800)).toBe(true);
  });

  it("packs separate paragraphs together when they fit", () => {
    expect(chunkText("first para\n\nsecond para")).toEqual(["first para\n\nsecond para"]);
  });
});

describe("meanEmbedding", () => {
  it("averages component-wise", () => {
    const mean = meanEmbedding([new Float32Array([1, 0]), new Float32Array([0, 1])]);
    expect(mean && [...mean]).toEqual([0.5, 0.5]);
  });

  it("returns null for an empty input", () => {
    expect(meanEmbedding([])).toBeNull();
  });
});

describe("embed", () => {
  it("returns an empty array for empty input without loading the model", async () => {
    const result = await embed([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("embeds text and places semantically similar sentences closer", async () => {
    const result = await embed([
      "a cat sat on the mat",
      "a kitten rested on the rug",
      "quarterly cloud infrastructure budget forecast",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [catA, catB, budget] = result.value;
    if (!catA || !catB || !budget) throw new Error("expected three embeddings");
    expect(catA.length).toBe(EMBEDDING_DIM);
    const similar = cosineSimilarity(catA, catB);
    const dissimilar = cosineSimilarity(catA, budget);
    expect(similar).toBeGreaterThan(dissimilar);
  }, 60_000);
});
