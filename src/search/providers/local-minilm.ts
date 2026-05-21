// local-minilm — sentence-transformers/all-MiniLM-L6-v2 run locally via
// @huggingface/transformers. 384 dims, fully local, no network at query time
// once the model is cached. The default embedding provider.
//
// The model loads lazily and is memoised for the process; the first call pays
// a ~500ms-to-multi-second cold start (model file download on first run,
// CPU init thereafter). A warm-up entry point exists so the server can pay
// that cost in the background after startup rather than on the first user
// search. Failures (no network on first run, model download blocked) come
// back as Result.err so the caller can degrade to BM25-only — embedding is
// never load-bearing for the server staying up.

import { err, ok, type Result } from "../../frontmatter/types.js";
import type { EmbeddingProvider } from "../embedding-provider.js";
import { markModelError, markModelReady, markModelWarming } from "../index-state.js";

export const LOCAL_MINILM_ID = "local-minilm";
export const LOCAL_MINILM_DIM = 384;
const HF_MODEL = "Xenova/all-MiniLM-L6-v2";

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
const EMBED_BATCH_SIZE = 8;

type Extractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

let extractorPromise: Promise<Extractor> | null = null;

async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    // The model is being loaded for the first time. Surface that in the
    // process-wide IndexState so tools can tell a "warming embeddings" pause
    // apart from a real indexing pass. The state is best-effort signal — we
    // never let a state-machine wobble break embedding.
    markModelWarming();
    extractorPromise = (
      import("@huggingface/transformers").then(({ pipeline }) =>
        pipeline("feature-extraction", HF_MODEL),
      ) as Promise<Extractor>
    ).then(
      (extractor) => {
        markModelReady();
        return extractor;
      },
      (e) => {
        // Surface the failure but reset the cached promise so the next call
        // can try again — useful for the no-network-on-first-run case where
        // a later retry might succeed. Without the reset a single transient
        // failure would poison the process for its whole lifetime.
        const reason = e instanceof Error ? e.message : String(e);
        markModelError(reason);
        extractorPromise = null;
        throw e;
      },
    );
  }
  return extractorPromise;
}

// Returns true once the model has been loaded into memory (the memoised
// promise has resolved). Used by tests and by lazy-load coverage to assert
// that startup paths do not invoke the model when they should not.
export function isLocalMinilmLoaded(): boolean {
  return extractorPromise !== null;
}

// Test-only: clear the memoised extractor so a fresh import is forced on
// the next call. Production code must not invoke this — the model load is
// expensive and the whole point of the memo is that it survives the process.
export function resetLocalMinilmForTests(): void {
  extractorPromise = null;
}

async function warm(): Promise<Result<void, Error>> {
  try {
    await getExtractor();
    return ok(undefined);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`embedding model warm-up failed: ${reason}`));
  }
}

async function embed(
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
      const dim = output.dims[output.dims.length - 1] ?? LOCAL_MINILM_DIM;
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

export const localMinilmProvider: EmbeddingProvider = {
  id: LOCAL_MINILM_ID,
  dim: LOCAL_MINILM_DIM,
  warm,
  embed,
};
