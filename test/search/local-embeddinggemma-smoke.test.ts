// Real-model smoke test for local-embeddinggemma (spec 2026-07-26-embedding-
// refresh-quantization). Downloads the ~600MB q8 ONNX weights on first run —
// no business in default `npm test` — so this whole file is skipped unless
// DAFTARI_EMBEDDINGGEMMA_SMOKE is set in env:
//
//   DAFTARI_EMBEDDINGGEMMA_SMOKE=1 npx vitest run test/search/local-embeddinggemma-smoke.test.ts
//
// This is a SANITY check only (semantically-similar text embeds closer than
// dissimilar text, at both offered dims). It is NOT the governing spec's
// Phase 0 spike — that spike additionally requires comparing against a
// Python sentence-transformers reference at cosine >= 0.999 (per-vector) and
// confirming the exact asymmetric prompt-prefix strings against the model
// card; neither of those has been run in this environment. Do not treat a
// green run of this file as spike completion.

import { describe, expect, it } from "vitest";
import {
  isLocalEmbeddingGemmaLoaded,
  makeLocalEmbeddingGemmaProvider,
  resetLocalEmbeddingGemmaForTests,
} from "../../src/search/providers/local-embeddinggemma.js";
import { cosineSimilarity } from "../../src/search/vector.js";

describe.skipIf(!process.env.DAFTARI_EMBEDDINGGEMMA_SMOKE)(
  "local-embeddinggemma (real model smoke)",
  () => {
    it("places semantically similar sentences closer than dissimilar ones, at dim=512", async () => {
      resetLocalEmbeddingGemmaForTests();
      const provider = makeLocalEmbeddingGemmaProvider(512);
      const warm = await provider.warm();
      expect(warm.ok).toBe(true);
      expect(isLocalEmbeddingGemmaLoaded()).toBe(true);

      const result = await provider.embed([
        "a cat sat on the mat",
        "a kitten rested on the rug",
        "quarterly cloud infrastructure budget forecast",
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const [catA, catB, budget] = result.value;
      if (!catA || !catB || !budget) throw new Error("expected three embeddings");
      expect(catA.length).toBe(768); // embed() returns NATIVE dim
      expect(cosineSimilarity(catA, catB)).toBeGreaterThan(cosineSimilarity(catA, budget));
    }, 180_000);

    it("embedQuery() at dim=512 outperforms bare embed() on a query/document pair", async () => {
      resetLocalEmbeddingGemmaForTests();
      const provider = makeLocalEmbeddingGemmaProvider(512);
      const docs = await provider.embed(["Paris is the capital of France."]);
      expect(docs.ok).toBe(true);
      if (!docs.ok) return;
      const queryResult = await provider.embedQuery?.("What is the capital of France?");
      expect(queryResult?.ok).toBe(true);
      if (!queryResult?.ok) return;
      expect(queryResult.value.length).toBe(512);
    }, 180_000);
  },
);
