// Vector (semantic) search half of hybrid search.
//
// Documents are split into chunks; each chunk is embedded via the active
// EmbeddingProvider (defaults to local-minilm: 384-dim sentence-transformers
// all-MiniLM-L6-v2 run locally via @huggingface/transformers). Similarity is
// cosine distance. Embeddings come back L2-normalised, so cosine reduces to a
// dot product, but cosineSimilarity stays general for safety.
//
// The provider is selected by .daftari/config.yaml's `embeddings.provider`
// key and instantiated once per process (memoised by `setProvider` /
// `getProvider`). embed/embedQuery/warmModel/isModelLoaded delegate to the
// active provider, so the rest of the search stack (reindex.ts, hybrid.ts)
// is provider-agnostic.

import { err, ok, type Result } from "../frontmatter/types.js";
import type { EmbeddingProviderId } from "../utils/config.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import {
  isLocalMinilmLoaded,
  LOCAL_MINILM_DIM,
  localMinilmProvider,
  resetLocalMinilmForTests,
} from "./providers/local-minilm.js";
import { makeOpenAi3SmallProvider } from "./providers/openai-3-small.js";

// EMBEDDING_MODEL and EMBEDDING_DIM are retained as deprecated plain
// constants pointing at the local-minilm provider's values. They were the
// single embedding identity before this PR; reindex.ts, hybrid.ts and the
// tests imported them as literals (SQL binds, length comparisons). New code
// must read `getProvider().id` and `getProvider().dim` instead — these
// exports are scheduled for removal next release.
//
// @deprecated Use `getProvider().id` instead.
export const EMBEDDING_MODEL = "local-minilm";

// @deprecated Use `getProvider().dim` instead.
export const EMBEDDING_DIM = LOCAL_MINILM_DIM;

// Texts are embedded in fixed-size sub-batches; see provider implementations.
// The constant lives here for tests that probe the local-minilm batching
// behaviour. (No provider exposes this directly through the interface
// because batching is an implementation detail.)
export const EMBED_BATCH_SIZE = 8;

const CHUNK_MAX_CHARS = 800;

// Splits a document body into embeddable chunks. Paragraphs (blank-line
// separated) are packed greedily up to CHUNK_MAX_CHARS; a single paragraph
// longer than the cap is hard-split. Always returns at least one chunk so an
// empty body still produces a (possibly empty) vector slot.
export function chunkText(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let current = "";
  for (const para of paragraphs) {
    if (para.length > CHUNK_MAX_CHARS) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < para.length; i += CHUNK_MAX_CHARS) {
        chunks.push(para.slice(i, i + CHUNK_MAX_CHARS));
      }
      continue;
    }
    if (current.length + para.length + 2 > CHUNK_MAX_CHARS && current) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text.trim()];
}

// Cosine similarity in [-1, 1]. Mismatched lengths or a zero vector yield 0.
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Mean of a set of vectors — used to represent a whole document by averaging
// its chunk embeddings. Returns null when there is nothing to average.
export function meanEmbedding(vectors: Float32Array[]): Float32Array | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0]?.length ?? 0;
  if (dim === 0) return null;
  const sum = new Float32Array(dim);
  for (const v of vectors) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) sum[i] = (sum[i] as number) + (v[i] as number);
  }
  for (let i = 0; i < dim; i++) sum[i] = (sum[i] as number) / vectors.length;
  return sum;
}

// --- Provider selection ----------------------------------------------------

// The active provider for this process. Memoised so a server run uses one
// provider for its whole lifetime; switching providers means restarting the
// server (and the next reindex populates a fresh row set under the new
// provider's id — the old rows stay in the cache as cheap insurance for
// switching back).
let activeProvider: EmbeddingProvider = localMinilmProvider;

// Resolves the active provider from a config id. The OPENAI_API_KEY presence
// has already been validated by loadConfig; if it's somehow missing here we
// fail loud rather than constructing a broken provider.
function instantiateProvider(id: EmbeddingProviderId): EmbeddingProvider {
  switch (id) {
    case "local-minilm":
      return localMinilmProvider;
    case "openai-3-small": {
      const key = process.env.OPENAI_API_KEY;
      if (!key) {
        throw new Error("OPENAI_API_KEY is not set — cannot construct openai-3-small provider");
      }
      return makeOpenAi3SmallProvider(key);
    }
  }
}

// Called once at server startup (after loadConfig). Idempotent for the same
// id — subsequent calls with the same id are no-ops, so test code can call
// it freely without thrashing. A different id replaces the provider; tests
// rely on this.
export function setProvider(id: EmbeddingProviderId): void {
  if (activeProvider.id === id) return;
  activeProvider = instantiateProvider(id);
}

// Returns the active provider. Default is local-minilm; setProvider() (which
// the server's main() invokes after loadConfig) swaps in another.
export function getProvider(): EmbeddingProvider {
  return activeProvider;
}

// Test-only: install an arbitrary provider object. Used by reindex tests
// that need to simulate a provider switch without paying the network or
// model-load cost. Resets the local-minilm memoised extractor too so a
// later swap back to local-minilm starts cold.
export function setProviderForTests(provider: EmbeddingProvider): void {
  activeProvider = provider;
}

// Test-only: revert to the default local-minilm provider and clear its
// memoised extractor. Production code must not call this.
export function resetProviderForTests(): void {
  activeProvider = localMinilmProvider;
  resetLocalMinilmForTests();
}

// --- Provider-delegating surface (kept for back-compat) -------------------

// Returns true once the active provider's underlying model is loaded. For
// providers with no warm-up cost (e.g. the stateless OpenAI HTTP client)
// this is always true; for local-minilm it tracks the transformers.js
// extractor promise.
export function isModelLoaded(): boolean {
  if (activeProvider.id === "local-minilm") return isLocalMinilmLoaded();
  // Stateless / always-ready providers are "loaded" by definition.
  return true;
}

// Eagerly loads the active provider so the first user search does not pay
// the cold start. Intended to be invoked as a background `void warmModel()`
// after startup completes. Returns Result rather than throwing — a warm
// failure must never crash the server.
export async function warmModel(): Promise<Result<void, Error>> {
  return activeProvider.warm();
}

// Test-only: clear the local-minilm memoised extractor so a fresh import is
// forced on the next call. Production code must not invoke this. Kept under
// the historic name for the existing lazy-model-load tests.
export function resetExtractorForTests(): void {
  resetLocalMinilmForTests();
}

// Embeds texts via the active provider. Returns one Float32Array per input,
// in input order. An empty input yields an empty array. `onProgress` (if
// given) fires after each sub-batch.
export async function embed(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Result<Float32Array[], Error>> {
  if (texts.length === 0) return ok([]);
  return activeProvider.embed(texts, onProgress);
}

// Convenience wrapper for embedding a single query string.
export async function embedQuery(text: string): Promise<Result<Float32Array, Error>> {
  const result = await embed([text]);
  if (!result.ok) return result;
  const first = result.value[0];
  if (!first) return err(new Error("embedding produced no vector"));
  return ok(first);
}
