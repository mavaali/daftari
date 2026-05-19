// Vector (semantic) search half of hybrid search.
//
// Documents are split into chunks; each chunk is embedded into a 384-dim
// vector with the all-MiniLM-L6-v2 sentence-transformer (run locally via
// @huggingface/transformers — no network at query time once the model is cached).
// Similarity is cosine distance. Embeddings come back L2-normalised, so cosine
// reduces to a dot product, but cosineSimilarity stays general for safety.
//
// The model loads lazily and is memoised for the process. Loading can fail
// (e.g. no network on first run, before the model is cached); embed() surfaces
// that as Result.err so the caller can fall back to lexical-only ranking.

import { err, ok, type Result } from "../frontmatter/types.js";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

// Texts are embedded in fixed-size sub-batches rather than one call. The model
// pads every batch to its longest sequence and allocates activation tensors
// proportional to the batch size, so an unbounded batch makes peak memory
// scale with the whole vault — a few hundred documents is enough to exhaust
// RAM and stall in a GC death spiral. A small fixed batch keeps peak memory
// flat regardless of vault size.
//
// 8 was measured as the sweet spot: on CPU inference larger batches were both
// heavier (more activation memory) and slower (more compute wasted padding
// short chunks up to the batch's longest sequence), not faster.
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

type Extractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

let extractorPromise: Promise<Extractor> | null = null;

async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = import("@huggingface/transformers").then(({ pipeline }) =>
      pipeline("feature-extraction", EMBEDDING_MODEL),
    ) as Promise<Extractor>;
  }
  return extractorPromise;
}

// Embeds texts in EMBED_BATCH_SIZE sub-batches so peak memory stays flat
// regardless of how many texts are passed. Returns one Float32Array per input
// text, in input order. An empty input yields an empty array without loading
// the model. `onProgress` (if given) fires after each sub-batch with the count
// embedded so far and the total — used to drive reindex progress output.
export async function embed(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Result<Float32Array[], Error>> {
  if (texts.length === 0) return ok([]);
  try {
    const extractor = await getExtractor();
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
      const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
      const output = await extractor(batch, {
        pooling: "mean",
        normalize: true,
      });
      const dim = output.dims[output.dims.length - 1] ?? EMBEDDING_DIM;
      for (let i = 0; i < batch.length; i++) {
        vectors.push(output.data.slice(i * dim, (i + 1) * dim));
      }
      // Progress is a best-effort side channel: a failing reporter (e.g. a
      // closed stderr pipe) must never abort embedding the vault.
      if (onProgress) {
        try {
          onProgress(vectors.length, texts.length);
        } catch {
          // ignore — progress reporting is not load-bearing
        }
      }
    }
    return ok(vectors);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`embedding failed: ${reason}`));
  }
}

// Convenience wrapper for embedding a single query string.
export async function embedQuery(text: string): Promise<Result<Float32Array, Error>> {
  const result = await embed([text]);
  if (!result.ok) return result;
  const first = result.value[0];
  if (!first) return err(new Error("embedding produced no vector"));
  return ok(first);
}
