// local-embeddinggemma — google/embeddinggemma-300m run locally via
// @huggingface/transformers, using the local-transformers.ts factory (spec
// 2026-07-26-embedding-refresh-quantization Decision 1/2, Phase 1c).
// 768d native, Matryoshka-truncatable to 512 (default) or 768. Mean pooling,
// asymmetric document/query prompt prefixes.

import type { EmbeddingProvider } from "../embedding-provider.js";
import { makeLocalTransformersProvider } from "./local-transformers.js";

export const LOCAL_EMBEDDINGGEMMA_ID_PREFIX = "local-embeddinggemma";
const HF_MODEL = "onnx-community/embeddinggemma-300m-ONNX";
const NATIVE_DIM = 768;
// Matryoshka-trained points this provider exposes. 512 first — the spec's
// default. 384 is deliberately NOT offered: not a trained Matryoshka point
// for this model, so truncating there is off-distribution (spec Decision 2).
export const LOCAL_EMBEDDINGGEMMA_DIMS = [512, 768] as const;

// [TRAINING] The prefix strings below are working hypotheses from the
// governing spec's Decision 1, pending the Phase 0 spike's confirmation
// against the model card. If the spike corrects them, bump PROMPT_REVISION —
// the cache id carries it (`local-embeddinggemma#p1`), so a prefix fix
// behaves exactly like a provider switch: old rows under `#p1` become cache
// misses under `#p2` and are gc-eligible, never silently reused under a
// stale prefix (disposition C5). Kill condition: if the confirmed prefixes
// differ from these, PROMPT_REVISION must bump in the same change that
// corrects them — a prefix edit that does NOT bump this constant is a bug.
const PROMPT_REVISION = "p1";
const DOC_PREFIX = "title: none | text: ";
const QUERY_PREFIX = "task: search result | query: ";

let cached: Map<number, EmbeddingProvider & { resetForTests(): void }> | null = null;

function providerFor(dim: number): EmbeddingProvider & { resetForTests(): void } {
  if (!cached) cached = new Map();
  const existing = cached.get(dim);
  if (existing) return existing;
  const provider = makeLocalTransformersProvider({
    id: `${LOCAL_EMBEDDINGGEMMA_ID_PREFIX}#${PROMPT_REVISION}`,
    hfModel: HF_MODEL,
    dtype: "q8",
    nativeDim: NATIVE_DIM,
    dim,
    pooling: "mean",
    docPrefix: DOC_PREFIX,
    queryPrefix: QUERY_PREFIX,
  });
  cached.set(dim, provider);
  return provider;
}

// Constructs (or returns the memoised instance for) the provider at the
// given configured dim. One underlying transformers.js model load is shared
// across every dim requested in a process — the model always outputs
// NATIVE_DIM; only the choke-point truncation (toIndexDim) differs per dim,
// so a second instance at a different dim would otherwise pay a redundant
// model load for zero benefit.
export function makeLocalEmbeddingGemmaProvider(dim: number): EmbeddingProvider {
  if (!(LOCAL_EMBEDDINGGEMMA_DIMS as readonly number[]).includes(dim)) {
    throw new Error(
      `local-embeddinggemma: unsupported dim ${dim} ` +
        `(expected one of ${LOCAL_EMBEDDINGGEMMA_DIMS.join(", ")})`,
    );
  }
  return providerFor(dim);
}

// True once ANY dim variant's underlying model has been loaded — they share
// one transformers.js extractor per dim, but for the isModelLoaded()
// surface (a process-wide "is embedding warm" signal) any loaded instance
// counts.
export function isLocalEmbeddingGemmaLoaded(): boolean {
  if (!cached) return false;
  for (const provider of cached.values()) {
    if (provider.isLoaded?.()) return true;
  }
  return false;
}

// Test-only: clears every memoised dim variant so a fresh import is forced
// on the next call. Production code must not invoke this.
export function resetLocalEmbeddingGemmaForTests(): void {
  if (cached) {
    for (const provider of cached.values()) provider.resetForTests();
  }
  cached = null;
}
