// local-bge-m3 — BAAI/bge-reranker-v2-m3 cross-encoder, ONNX q8, run locally
// via @huggingface/transformers (onnx-community/bge-reranker-v2-m3-ONNX).
// Zero new dependencies: @huggingface/transformers is already ^4.2.0
// (package.json), the same runtime local-minilm.ts uses for embeddings.
//
// Score = sigmoid of the single logit per (query, passage) pair, tokenized
// as a (query, passage) text_pair and scored in fixed sub-batches of
// RERANK_BATCH_SIZE — the same peak-memory argument as local-minilm's
// EMBED_BATCH_SIZE: an unbounded batch pads every pair to the batch's
// longest sequence, so peak activation memory would scale with the whole
// rerank pool (bounded at RERANK_POOL, src/tools/search.ts) rather than
// staying flat.
//
// The model loads lazily and is memoised for the process; a warm-up entry
// point exists so the server can pay that cost in the background rather
// than on the first rerank-enabled search — spec Decision 8, and the C5
// revision that the search path must NEVER trigger a synchronous model load
// inside a tool call (isReady() gates that; see rerank-provider.ts and
// src/tools/search.ts). A load or inference failure returns Result.err so
// the caller degrades to the fused order — reranking, like embedding, is
// never load-bearing for the server staying up.
//
// Deliberately does NOT touch index-state.ts's model markers: those narrate
// the EMBEDDING model's warming lifecycle for tools that distinguish
// "warming embeddings" from "indexing"; a warming reranker is a separate
// concern that never blocks or is blocked by indexing (plan §3.2).

import { err, ok, type Result } from "../../frontmatter/types.js";
import type { RerankProvider } from "../rerank-provider.js";

export const LOCAL_BGE_M3_ID = "local-bge-m3";
const HF_MODEL = "onnx-community/bge-reranker-v2-m3-ONNX";

// Sub-batch size for (query, passage) pairs scored per model call. See file
// header — mirrors local-minilm.ts's EMBED_BATCH_SIZE rationale exactly.
const RERANK_BATCH_SIZE = 8;

// Minimal shape of the transformers.js pieces this module actually calls,
// so the rest of the file (and its tests, via the RerankProvider seam) never
// depends on @huggingface/transformers' full type surface.
interface TokenizedInputs {
  input_ids: unknown;
  attention_mask: unknown;
}
type Tokenizer = (
  queries: string[],
  opts: { text_pair: string[]; padding: boolean; truncation: boolean },
) => TokenizedInputs;
type SequenceClassifier = (
  inputs: TokenizedInputs,
) => Promise<{ logits: { data: ArrayLike<number> } }>;

interface Model {
  tokenizer: Tokenizer;
  classify: SequenceClassifier;
}

let modelPromise: Promise<Model> | null = null;

async function getModel(): Promise<Model> {
  if (!modelPromise) {
    modelPromise = (
      import("@huggingface/transformers") as Promise<{
        AutoTokenizer: { from_pretrained: (id: string) => Promise<Tokenizer> };
        AutoModelForSequenceClassification: {
          from_pretrained: (id: string, opts: { dtype: string }) => Promise<SequenceClassifier>;
        };
      }>
    )
      .then(async ({ AutoTokenizer, AutoModelForSequenceClassification }) => {
        const tokenizer = await AutoTokenizer.from_pretrained(HF_MODEL);
        const classify = await AutoModelForSequenceClassification.from_pretrained(HF_MODEL, {
          dtype: "q8",
        });
        return { tokenizer, classify };
      })
      .then(
        (model) => model,
        (e) => {
          // Reset the memoised promise so a later retry (e.g. network came
          // back) can succeed — a single transient failure must not poison
          // the process for its whole lifetime. Mirrors local-minilm.ts.
          modelPromise = null;
          throw e;
        },
      );
  }
  return modelPromise;
}

// True once the model has been loaded into memory. This IS isReady() on the
// RerankProvider interface — the search path checks it before ever
// attempting a rerank, so reranking never triggers a cold model load inside
// a tool call (C5).
export function isLocalBgeM3Loaded(): boolean {
  return modelPromise !== null;
}

// Test-only: clear the memoised model so a fresh import is forced on the
// next call. Production code must not invoke this.
export function resetLocalBgeM3ForTests(): void {
  modelPromise = null;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

async function warm(): Promise<Result<void, Error>> {
  try {
    await getModel();
    return ok(undefined);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`reranker model warm-up failed: ${reason}`));
  }
}

async function rerank(query: string, passages: string[]): Promise<Result<number[], Error>> {
  if (passages.length === 0) return ok([]);
  try {
    const model = await getModel();
    const scores: number[] = [];
    for (let start = 0; start < passages.length; start += RERANK_BATCH_SIZE) {
      const batch = passages.slice(start, start + RERANK_BATCH_SIZE);
      const inputs = model.tokenizer(
        batch.map(() => query),
        { text_pair: batch, padding: true, truncation: true },
      );
      const output = await model.classify(inputs);
      const logits = Array.from(output.logits.data);
      for (const logit of logits) scores.push(sigmoid(logit));
    }
    return ok(scores);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`rerank failed: ${reason}`));
  }
}

export const localBgeM3Provider: RerankProvider = {
  id: LOCAL_BGE_M3_ID,
  isReady: isLocalBgeM3Loaded,
  warm,
  rerank,
};
