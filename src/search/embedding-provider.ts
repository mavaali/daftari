// EmbeddingProvider — pluggable backend for chunk-to-vector conversion.
//
// The vault search index always stored its embeddings under a `model` column,
// but until this PR there was exactly one model: a locally-loaded MiniLM. The
// provider interface lets the vault owner pick between free-and-slow (local
// MiniLM, ~25 min cold reindex on a 44k-chunk vault) and fast-and-paid (an
// API-backed provider, ~2 min and ~$0.10 for the same vault). Because the
// embeddings cache is keyed by (content_hash, model), the paid cost is a
// one-time event per chunk text — a switch back to local doesn't re-embed
// anything; the old model's rows stay put and the new model populates its
// own row set.
//
// Contract (extended 2026-07-26 embedding-refresh-quantization spec, Phase
// 1b — Matryoshka truncation + int8 quantization):
//   - `id` is what gets written to embeddings.model AND the durable
//     `embeddings` cache key. Two providers with the same id would corrupt
//     the cache; treat it as a stable namespace. For a Matryoshka-truncatable
//     provider `id` is DIM-FREE (e.g. "local-embeddinggemma#p1") — the cache
//     stores the full native-dim vector once, and `dim` below is purely the
//     INDEX-time truncation target, not part of the cache identity. The
//     trailing `#pN` component is the provider's prompt-format revision:
//     bump it whenever the asymmetric prefix strings change so a prefix fix
//     behaves like a provider switch (cache miss, re-embed) rather than
//     silently leaving stale rows under a still-valid-looking id.
//   - `dim` is the CONFIGURED index dimension — the vec table width and the
//     length of vectors `embedQuery` returns. The cache stores the native
//     dim per row as defense-in-depth (see `nativeDim`), but the model id
//     alone scopes the join, so mixed-dim vectors for the same model id are
//     a bug — not an expected runtime state.
//   - `nativeDim` is the provider's full (untruncated) output width. Absent
//     (or equal to `dim`) means the provider has no Matryoshka truncation —
//     `embed()`'s output is already at `dim`. When present and greater than
//     `dim`, `embed()` returns NATIVE-dim vectors and callers apply
//     `toIndexDim` (src/search/vector.ts) at the single choke point where a
//     vector meets the index or a query.
//   - `warm()` is the eager-load entry point. For providers with no warm-up
//     cost (e.g. a stateless HTTP client), it can be a no-op that returns ok.
//   - `embed()` returns one Float32Array per input text, in input order, all
//     of NATIVE dim (== `dim` when `nativeDim` is absent). Doc-side prompt
//     prefixing (if any) is applied internally. `onProgress` (if given)
//     fires after each sub-batch. Errors are returned as Result.err — the
//     caller (reindex / search) is responsible for degrading gracefully to
//     lexical-only ranking.
//   - `embedQuery()` is the query-side counterpart: applies the provider's
//     query prompt prefix (if any) and returns a vector already at
//     CONFIGURED `dim` (native output truncated via `toIndexDim`
//     internally). Providers with no asymmetric prefix and no truncation
//     may omit it — callers fall back to `embed([text])` + `toIndexDim`.
//   - `isLoaded()` reports whether the underlying model is resident in
//     memory. Absent means "always loaded" (stateless providers, e.g. an
//     HTTP client) — `isModelLoaded()` in vector.ts treats a missing
//     `isLoaded` as `true`.

import type { Result } from "../frontmatter/types.js";

export interface EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  readonly nativeDim?: number;
  warm(): Promise<Result<void, Error>>;
  embed(
    texts: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Result<Float32Array[], Error>>;
  embedQuery?(text: string): Promise<Result<Float32Array, Error>>;
  isLoaded?(): boolean;
}
