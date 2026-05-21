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
// Contract:
//   - `id` is what gets written to embeddings.model. Two providers with the
//     same id would corrupt the cache; treat it as a stable namespace.
//   - `dim` is the vector dimension. The cache stores it per row as defense-
//     in-depth, but the model id alone scopes the join, so mixed-dim vectors
//     for the same model id are a bug — not an expected runtime state.
//   - `warm()` is the eager-load entry point. For providers with no warm-up
//     cost (e.g. a stateless HTTP client), it can be a no-op that returns ok.
//   - `embed()` returns one Float32Array per input text, in input order, all
//     of length `dim`. `onProgress` (if given) fires after each sub-batch.
//     Errors are returned as Result.err — the caller (reindex / search) is
//     responsible for degrading gracefully to lexical-only ranking.

import type { Result } from "../frontmatter/types.js";

export interface EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  warm(): Promise<Result<void, Error>>;
  embed(
    texts: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Result<Float32Array[], Error>>;
}
