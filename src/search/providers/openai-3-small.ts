// openai-3-small — OpenAI `text-embedding-3-small` via the public REST API.
// 1536 dims. Trades local CPU + cold-start latency for paid network calls;
// the embeddings cache makes the cost a one-time event per chunk text.
//
// Trust model: the vault owner sets OPENAI_API_KEY in the environment of the
// MCP server process. The key is never read from config files or logged.
// Missing key is a hard config error (see config loader) so a "paid" provider
// can't silently fall back to free.
//
// Transport: native `fetch` (Node 20+ ships it globally). We deliberately
// don't depend on the `openai` SDK — a 30-line typed wrapper avoids
// dependency churn and a giant chain of transitive deps for what's a single
// HTTP endpoint.
//
// Batching: 96 inputs per request. OpenAI's documented max is 2048 but
// smaller batches keep the retry blast radius small (one batch failing
// doesn't lose 2000 vectors' worth of work) and let onProgress fire often
// enough to make a multi-thousand-chunk reindex visibly alive.
//
// Retries: exponential backoff on 429 / 5xx, max 3 retries. A definitive
// failure (4xx other than 429, or a 4th attempt failing) returns Result.err;
// callers degrade to BM25-only. We never throw from embed().

import { err, ok, type Result } from "../../frontmatter/types.js";
import type { EmbeddingProvider } from "../embedding-provider.js";

export const OPENAI_3_SMALL_ID = "openai-3-small";
export const OPENAI_3_SMALL_DIM = 1536;
const OPENAI_MODEL = "text-embedding-3-small";
const OPENAI_URL = "https://api.openai.com/v1/embeddings";

// Per-request batch size. OpenAI accepts up to 2048; we pick smaller so a
// transient 5xx is cheap to retry and progress reporting feels responsive.
const BATCH_SIZE = 96;

// Retry budget. 3 retries with exponential backoff covers the typical 429 /
// 5xx blip without making a hard failure feel like an indefinite hang.
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// Sleep with backoff. Exposed as a parameter so tests can stub it without
// waiting real wall time. The first retry waits BASE_BACKOFF_MS, the second
// 2x, the third 4x — total worst-case ~3.5s before giving up.
async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Normalise a vector to unit length in place. OpenAI's text-embedding-3-small
// returns L2-normalized vectors by default, so this is a defense-in-depth
// no-op for the happy path. We still do it because cosine similarity is
// stable iff inputs are normalized, and "the API silently returns un-
// normalized vectors" is exactly the class of upstream change we'd rather
// not be caught by.
function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    const x = vec[i] as number;
    norm += x * x;
  }
  if (norm === 0) return vec;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < vec.length; i++) {
    vec[i] = (vec[i] as number) * inv;
  }
  return vec;
}

// One HTTP call to /v1/embeddings for a single batch. Retries on 429/5xx
// with exponential backoff; surfaces a definitive failure as Result.err.
async function embedBatch(
  apiKey: string,
  inputs: string[],
): Promise<Result<Float32Array[], Error>> {
  let attempt = 0;
  let lastError: string = "unknown";
  while (attempt <= MAX_RETRIES) {
    let response: Response;
    try {
      response = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input: inputs, model: OPENAI_MODEL }),
      });
    } catch (e) {
      // Network-level failure (DNS, connection reset). Retry like a 5xx.
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_RETRIES) {
        await delay(BASE_BACKOFF_MS * 2 ** attempt);
        attempt += 1;
        continue;
      }
      return err(new Error(`openai embedding request failed: ${lastError}`));
    }

    if (response.ok) {
      let parsed: OpenAIEmbeddingResponse;
      try {
        parsed = (await response.json()) as OpenAIEmbeddingResponse;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return err(new Error(`openai embedding response not JSON: ${reason}`));
      }
      if (!parsed.data || parsed.data.length !== inputs.length) {
        return err(
          new Error(
            `openai embedding response had ${parsed.data?.length ?? 0} vectors ` +
              `for ${inputs.length} inputs`,
          ),
        );
      }
      const vectors: Float32Array[] = [];
      for (const item of parsed.data) {
        if (!Array.isArray(item.embedding) || item.embedding.length !== OPENAI_3_SMALL_DIM) {
          return err(
            new Error(
              `openai returned vector of dim ${item.embedding?.length ?? 0}, ` +
                `expected ${OPENAI_3_SMALL_DIM}`,
            ),
          );
        }
        const vec = new Float32Array(item.embedding);
        vectors.push(l2Normalize(vec));
      }
      return ok(vectors);
    }

    // Read the body for diagnostics; ignore body-read failures because the
    // status code is the load-bearing signal.
    let body = "";
    try {
      body = await response.text();
    } catch {
      // ignore
    }
    lastError = `${response.status} ${response.statusText} ${body}`.trim();
    if (!isRetryableStatus(response.status) || attempt >= MAX_RETRIES) {
      return err(new Error(`openai embedding request failed: ${lastError}`));
    }
    await delay(BASE_BACKOFF_MS * 2 ** attempt);
    attempt += 1;
  }
  return err(new Error(`openai embedding request failed: ${lastError}`));
}

// Factory: takes the API key explicitly so the provider object is pure data
// once constructed. The config loader validates the env var presence and
// passes the value here; that way a missing key surfaces at config load,
// not at first embed.
export function makeOpenAi3SmallProvider(apiKey: string): EmbeddingProvider {
  if (!apiKey) {
    throw new Error("makeOpenAi3SmallProvider: empty apiKey");
  }
  return {
    id: OPENAI_3_SMALL_ID,
    dim: OPENAI_3_SMALL_DIM,
    // Stateless HTTP — no warm-up cost. Returning ok keeps the warm path
    // uniform across providers so the server's startup wiring doesn't need
    // to special-case the provider.
    async warm() {
      return ok(undefined);
    },
    async embed(texts, onProgress) {
      if (texts.length === 0) return ok([]);
      const vectors: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += BATCH_SIZE) {
        const batch = texts.slice(start, start + BATCH_SIZE);
        const batchResult = await embedBatch(apiKey, batch);
        if (!batchResult.ok) return batchResult;
        for (const v of batchResult.value) vectors.push(v);
        if (onProgress) {
          try {
            onProgress(vectors.length, texts.length);
          } catch {
            // best-effort: a broken reporter must not stop the embed.
          }
        }
      }
      return ok(vectors);
    },
  };
}
