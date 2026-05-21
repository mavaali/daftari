// Local-MiniLM provider coverage (issue #38 PR 4).
//
// The provider wraps the same transformers.js path the vault has used since
// v1.0; these tests assert the EmbeddingProvider interface adapter is correct
// (id, dim, embed shape) without re-validating semantic quality (covered by
// the broader vector.test.ts suite).

import { describe, expect, it } from "vitest";
import {
  LOCAL_MINILM_DIM,
  LOCAL_MINILM_ID,
  localMinilmProvider,
} from "../../../src/search/providers/local-minilm.js";

describe("local-minilm provider", () => {
  it("exposes id 'local-minilm' and dim 384", () => {
    expect(localMinilmProvider.id).toBe(LOCAL_MINILM_ID);
    expect(localMinilmProvider.id).toBe("local-minilm");
    expect(localMinilmProvider.dim).toBe(LOCAL_MINILM_DIM);
    expect(localMinilmProvider.dim).toBe(384);
  });

  it("round-trips embed: one Float32Array per input, each of dim 384", async () => {
    const result = await localMinilmProvider.embed([
      "first probe sentence",
      "second probe sentence",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    for (const vec of result.value) {
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(384);
    }
  }, 60_000);

  it("warm() returns ok on a healthy load", async () => {
    const result = await localMinilmProvider.warm();
    expect(result.ok).toBe(true);
  }, 60_000);
});
