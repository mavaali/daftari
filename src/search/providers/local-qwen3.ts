// local-qwen3 — Qwen/Qwen3-Embedding-0.6B run locally via
// @huggingface/transformers, using the local-transformers.ts factory (spec
// 2026-07-26-embedding-refresh-quantization Decision 1/2, Phase 1c).
// 1024d native — deliberately not offered; this provider exposes at most 768
// (spec text: "Qwen3's 1024d deliberately not offered yet; 768 is the max
// exposed"). Last-token pooling, instruction-prefixed query / bare document.

import type { EmbeddingProvider } from "../embedding-provider.js";
import { makeLocalTransformersProvider } from "./local-transformers.js";

export const LOCAL_QWEN3_ID_PREFIX = "local-qwen3-0.6b";
const HF_MODEL = "onnx-community/Qwen3-Embedding-0.6B-ONNX";
// The provider's exposed native ceiling — Qwen3-Embedding-0.6B natively
// outputs 1024d, but this provider caps at 768 (the spec's explicit
// deferral). toIndexDim truncates the model's real 1024d output down to
// this ceiling first (a Matryoshka-style truncation the spec treats as the
// provider's own "native" dim for cache/index purposes), then again to the
// caller's configured `dim` when that is smaller still.
const EXPOSED_NATIVE_DIM = 768;
export const LOCAL_QWEN3_DIMS = [512, 768] as const;

// [TRAINING] Working hypothesis pending the Phase 0 spike (see
// local-embeddinggemma.ts's PROMPT_REVISION comment for the full rationale —
// identical posture here). Qwen3's document side is unprefixed per the
// spec's working hypothesis; the query side carries an instruction prefix.
const PROMPT_REVISION = "p1";
const DOC_PREFIX = "";
const QUERY_PREFIX = "Instruct: Given a search query, retrieve relevant passages | Query: ";

let cached: Map<number, EmbeddingProvider & { resetForTests(): void }> | null = null;

function providerFor(dim: number): EmbeddingProvider & { resetForTests(): void } {
  if (!cached) cached = new Map();
  const existing = cached.get(dim);
  if (existing) return existing;
  const provider = makeLocalTransformersProvider({
    id: `${LOCAL_QWEN3_ID_PREFIX}#${PROMPT_REVISION}`,
    hfModel: HF_MODEL,
    dtype: "q8",
    nativeDim: EXPOSED_NATIVE_DIM,
    dim,
    pooling: "last-token",
    docPrefix: DOC_PREFIX,
    queryPrefix: QUERY_PREFIX,
  });
  cached.set(dim, provider);
  return provider;
}

export function makeLocalQwen3Provider(dim: number): EmbeddingProvider {
  if (!(LOCAL_QWEN3_DIMS as readonly number[]).includes(dim)) {
    throw new Error(
      `local-qwen3-0.6b: unsupported dim ${dim} (expected one of ${LOCAL_QWEN3_DIMS.join(", ")})`,
    );
  }
  return providerFor(dim);
}

export function isLocalQwen3Loaded(): boolean {
  if (!cached) return false;
  for (const provider of cached.values()) {
    if (provider.isLoaded?.()) return true;
  }
  return false;
}

// Test-only: clears every memoised dim variant so a fresh import is forced
// on the next call. Production code must not invoke this.
export function resetLocalQwen3ForTests(): void {
  if (cached) {
    for (const provider of cached.values()) provider.resetForTests();
  }
  cached = null;
}
