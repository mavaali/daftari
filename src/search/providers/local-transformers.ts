// local-transformers — shared factory for @huggingface/transformers-backed
// local embedding providers (spec 2026-07-26-embedding-refresh-quantization
// Phase 1a). Generalizes local-minilm.ts's shape (memoised lazy extractor,
// markModelWarming/Ready/Error, promise reset on failure, fixed sub-batches,
// Result-typed embed, warm() = load-and-return) to cover the two new
// Matryoshka-truncatable, asymmetric-prompt models: EmbeddingGemma-300M
// (mean pooling) and Qwen3-Embedding-0.6B (last-token pooling).
//
// local-minilm.ts is deliberately NOT refactored onto this factory — its
// exports are load-bearing across the codebase and its tests download the
// real (small) model on every `npm test` run; leaving it untouched keeps
// "vaults that never touch config keep today's behavior exactly" trivially
// true (disposition C8's independence posture applied to this file too).
//
// [HYPOTHESIS] The exact transformers.js call shape for last-token pooling
// (AutoTokenizer + a raw feature-extraction call per single text, no padding,
// so the last row of the returned per-token tensor IS the last real token —
// see poolLastToken below) is UNVERIFIED against a real model load: Phase 0
// of the governing spec (docs/superpowers/specs/2026-07-26-embedding-
// refresh-quantization-design.md) calls for a smoke spike that loads both
// models and compares against a Python sentence-transformers reference
// before this code path is trusted for a real vault. That spike has not been
// run in this environment (no model download). Kill condition: if the spike
// finds the feature-extraction pipeline cannot express "pooling: none" (raw
// per-token output) for either model, this file's last-token path needs the
// AutoModel/AutoTokenizer low-level API instead (the fallback the spec's
// Decision 1 names explicitly) — a follow-up change, not a silent
// workaround. Every test in this repo exercises this file through a mocked
// `@huggingface/transformers` import (see
// test/search/providers/local-embeddinggemma.test.ts and
// local-qwen3.test.ts); no test here downloads a real model.

import { err, ok, type Result } from "../../frontmatter/types.js";
import type { EmbeddingProvider } from "../embedding-provider.js";
import { markModelError, markModelReady, markModelWarming } from "../index-state.js";
import { l2Normalize, toIndexDim } from "../vector.js";

// See local-minilm.ts's EMBED_BATCH_SIZE comment for the peak-memory
// rationale. 8 is the same starting point; the Phase 0 spike may lower it
// for the larger models.
const DEFAULT_BATCH_SIZE = 8;

export type Pooling = "mean" | "last-token";

// ONNX dtype variants @huggingface/transformers accepts for a model load.
// Mirrored here (rather than imported from the package) so this file's
// public options type doesn't require pulling in the package's full type
// surface just to name "q8".
export type OnnxDtype =
  | "auto"
  | "fp32"
  | "fp16"
  | "q8"
  | "int8"
  | "uint8"
  | "q4"
  | "bnb4"
  | "q4f16";

export interface LocalTransformersOptions {
  // Cache/model id — dim-free, carries the provider's #pN prompt-revision
  // suffix (spec C5/C9). Written to embeddings.model and the durable cache
  // key.
  id: string;
  // Hugging Face repo id for the ONNX community export.
  hfModel: string;
  // ONNX dtype variant. The spike (Phase 0 gate 4) picks the dtype that
  // best balances reindex throughput against query latency; "q8" is this
  // file's default pending that measurement.
  dtype: OnnxDtype;
  // Full model output width.
  nativeDim: number;
  // Configured index dim (<=nativeDim). Equal to nativeDim means no
  // truncation.
  dim: number;
  pooling: Pooling;
  // Asymmetric prompt prefixes (spec Decision 1/C5). Empty string means no
  // prefix (Qwen3's document side, per the spec's working hypothesis).
  docPrefix: string;
  queryPrefix: string;
  batchSize?: number;
}

// Minimal shape of the transformers.js pieces this module calls, mirroring
// local-minilm.ts's `Extractor` type — keeps the rest of the file (and its
// tests, via a mocked "@huggingface/transformers" import) independent of the
// package's full type surface.
type Extractor = (
  texts: string[],
  opts: { pooling: "mean" | "none"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

export interface LocalTransformersProvider extends EmbeddingProvider {
  // Test-only: clears the memoised extractor promise so a fresh import is
  // forced on the next call. Production code must not invoke this.
  resetForTests(): void;
}

// Extracts the last real token's embedding from a [seq_len, hidden] raw
// per-token tensor. Correct WITHOUT an attention mask only when the input
// was NOT padded — which is guaranteed by embedLastToken below calling the
// extractor with a batch of exactly one text at a time, so there is nothing
// to pad against. This trades the sub-batch throughput local-minilm gets
// from mean pooling for correctness simplicity: a padding-aware last-token
// selection would need the tokenizer's attention mask threaded through the
// pipeline call, which the feature-extraction pipeline does not expose
// directly (see the file header's kill condition).
function poolLastToken(data: Float32Array, dims: number[]): Float32Array {
  const hidden = dims[dims.length - 1] ?? 0;
  const seqLen = dims[dims.length - 2] ?? 1;
  const lastTokenStart = (seqLen - 1) * hidden;
  return data.slice(lastTokenStart, lastTokenStart + hidden);
}

export function makeLocalTransformersProvider(
  opts: LocalTransformersOptions,
): LocalTransformersProvider {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  let extractorPromise: Promise<Extractor> | null = null;

  async function getExtractor(): Promise<Extractor> {
    if (!extractorPromise) {
      markModelWarming();
      extractorPromise = (
        import("@huggingface/transformers").then(({ pipeline }) =>
          pipeline("feature-extraction", opts.hfModel, { dtype: opts.dtype }),
        ) as Promise<Extractor>
      ).then(
        (extractor) => {
          markModelReady();
          return extractor;
        },
        (e) => {
          const reason = e instanceof Error ? e.message : String(e);
          markModelError(reason);
          extractorPromise = null;
          throw e;
        },
      );
    }
    return extractorPromise;
  }

  function isLoaded(): boolean {
    return extractorPromise !== null;
  }

  function resetForTests(): void {
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

  // Embeds a single prefixed text and returns its NATIVE-dim vector,
  // unnormalized-or-not per pooling mode (mean pooling normalizes inside the
  // pipeline call; last-token pooling normalizes explicitly afterward, since
  // "pooling: none" returns raw hidden states).
  async function embedOneNative(prefixedText: string, extractor: Extractor): Promise<Float32Array> {
    if (opts.pooling === "mean") {
      const output = await extractor([prefixedText], { pooling: "mean", normalize: true });
      const dim = output.dims[output.dims.length - 1] ?? opts.nativeDim;
      return capToNativeDim(output.data.slice(0, dim));
    }
    // last-token: single-item call (no padding), raw per-token output, then
    // manual last-token selection + L2 normalize. See poolLastToken's
    // correctness note above.
    const output = await extractor([prefixedText], { pooling: "none", normalize: false });
    return capToNativeDim(l2Normalize(poolLastToken(output.data, output.dims)));
  }

  // Caps a raw pooled vector at `opts.nativeDim`, truncating + re-
  // normalizing when the underlying model's real output is wider than the
  // dim this provider EXPOSES (local-qwen3.ts sets nativeDim=768 while the
  // real model outputs 1024d — spec text: "Qwen3's 1024d deliberately not
  // offered yet"). Identity when the raw output already matches (Gemma:
  // real 768d == exposed 768d). Reuses toIndexDim so this is the same
  // truncate-and-renormalize math the index-facing choke point uses, not a
  // second implementation of it.
  function capToNativeDim(vec: Float32Array): Float32Array {
    return toIndexDim(vec, opts.nativeDim);
  }

  async function embed(
    texts: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Result<Float32Array[], Error>> {
    if (texts.length === 0) return ok([]);
    try {
      const extractor = await getExtractor();
      const vectors: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize);
        if (opts.pooling === "mean") {
          // Mean pooling batches cleanly (padding does not corrupt a mean
          // taken with the pipeline's own internal attention-masked
          // average), so this mirrors local-minilm.ts's batched call.
          const prefixed = batch.map((t) => `${opts.docPrefix}${t}`);
          const output = await extractor(prefixed, { pooling: "mean", normalize: true });
          const dim = output.dims[output.dims.length - 1] ?? opts.nativeDim;
          for (let i = 0; i < batch.length; i++) {
            vectors.push(capToNativeDim(output.data.slice(i * dim, (i + 1) * dim)));
          }
        } else {
          for (const text of batch) {
            vectors.push(await embedOneNative(`${opts.docPrefix}${text}`, extractor));
          }
        }
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

  async function embedQuery(text: string): Promise<Result<Float32Array, Error>> {
    try {
      const extractor = await getExtractor();
      const native = await embedOneNative(`${opts.queryPrefix}${text}`, extractor);
      return ok(toIndexDim(native, opts.dim));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(new Error(`query embedding failed: ${reason}`));
    }
  }

  return {
    id: opts.id,
    dim: opts.dim,
    nativeDim: opts.nativeDim,
    warm,
    embed,
    embedQuery,
    isLoaded,
    resetForTests,
  };
}
