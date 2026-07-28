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

// Paragraph-packing loop, private to this module. Blank-line-separated
// paragraphs are packed greedily up to CHUNK_MAX_CHARS; a single paragraph
// longer than the cap is hard-split. Always returns at least one chunk for
// non-empty input; an all-whitespace input returns [].
//
// Reused verbatim (this WAS chunkText's whole body pre-contextual-chunking)
// as the within-SECTION packer for chunkDocument below — a heading boundary
// always starts a new chunk (spec 2026-07-26 Decision 1), so packing never
// spans two sections. This function itself is section-agnostic; it just packs
// whatever text blob it's given.
function packParagraphs(text: string): string[] {
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
  return chunks;
}

// --- Contextual chunking (spec 2026-07-26 contextual-chunking-reranker) ---

export interface ChunkInput {
  title: string;
  collection: string;
  tags: string[];
  body: string;
}

export interface DocumentChunk {
  text: string; // verbatim body slice, exactly what chunks.text stores
  context: string; // one-line breadcrumb, <=160 chars
}

// Single source of truth for the retrieval identity of a chunk — used by BOTH
// the content_hash and the embedding input so they can never drift. See spec
// Decision 2: the context is part of the chunk's retrieval identity, so it is
// hashed and embedded together with the body text.
export function embeddingInput(c: DocumentChunk): string {
  return c.context.length > 0 ? `${c.context}\n\n${c.text}` : c.text;
}

const CONTEXT_MAX_CHARS = 160;
const CONTEXT_MAX_TAGS = 5;

// ATX headings, levels 1-4 only (spec: #####/###### and setext headings
// degrade to plain text — the vault house style is ATX).
const ATX_HEADING_RE = /^(#{1,4})\s+(.*)$/;
const FENCE_RE = /^(```|~~~)/;

function stripHeadingText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

// Longest prefix of `text` (<=maxLen chars) such that `render(prefix + "…")`
// (or `render("…")` at zero chars) still fits within CONTEXT_MAX_CHARS. Used
// for both the innermost-heading and title tail-truncation steps below —
// binary search over the truncation point, not a plain slice, because the
// ellipsis and the surrounding breadcrumb literals shift where the cutoff
// needs to land.
function longestFittingPrefix(text: string, render: (candidate: string) => string): string {
  let lo = 0;
  let hi = text.length;
  let best = "…";
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = mid > 0 ? `${text.slice(0, mid)}…` : "…";
    if (render(candidate).length <= CONTEXT_MAX_CHARS) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// Builds the one-line breadcrumb context for a chunk:
//   {collection} › {doc title} › {H1} › {H2} › … · tags: a, b, c
//
// Tags are sorted lexicographically (so tag REORDER never perturbs the hash,
// C7) then capped at CONTEXT_MAX_TAGS; the tag suffix is omitted entirely for
// an untagged doc. The whole line is hard-capped at CONTEXT_MAX_CHARS;
// truncation, in order, is: (1) collapse every heading component except the
// innermost into a single "…", (2) tail-truncate the innermost heading,
// (3) drop the tag suffix, (4) tail-truncate the title. Collection and title
// always survive AS COMPONENTS (never dropped outright) — they are the
// highest-value disambiguators for the vault's short, similar-shaped docs.
function buildContext(
  input: { title: string; collection: string; tags: string[] },
  headingPath: string[],
): string {
  const sortedTags = [...input.tags].sort((a, b) => a.localeCompare(b)).slice(0, CONTEXT_MAX_TAGS);
  const tagsSuffix = sortedTags.length > 0 ? ` · tags: ${sortedTags.join(", ")}` : "";

  const render = (headings: string[], title: string, tags: string): string =>
    [input.collection, title, ...headings].join(" › ") + tags;

  let line = render(headingPath, input.title, tagsSuffix);
  if (line.length <= CONTEXT_MAX_CHARS) return line;

  // Step 1: collapse every heading but the innermost into a single "…".
  let headings = headingPath;
  if (headingPath.length > 1) {
    headings = ["…", headingPath[headingPath.length - 1] as string];
    line = render(headings, input.title, tagsSuffix);
    if (line.length <= CONTEXT_MAX_CHARS) return line;
  }

  // Step 2: tail-truncate the innermost heading.
  if (headings.length > 0) {
    const innermostIdx = headings.length - 1;
    const innermost = headings[innermostIdx] as string;
    const truncated = longestFittingPrefix(innermost, (candidate) =>
      render([...headings.slice(0, innermostIdx), candidate], input.title, tagsSuffix),
    );
    headings = [...headings.slice(0, innermostIdx), truncated];
    line = render(headings, input.title, tagsSuffix);
    if (line.length <= CONTEXT_MAX_CHARS) return line;
  }

  // Step 3: drop the tag suffix.
  line = render(headings, input.title, "");
  if (line.length <= CONTEXT_MAX_CHARS) return line;

  // Step 4: tail-truncate the title. Collection is never truncated.
  const truncatedTitle = longestFittingPrefix(input.title, (candidate) =>
    render(headings, candidate, ""),
  );
  return render(headings, truncatedTitle, "");
}

// Splits a document body into heading-aware, breadcrumb-contextualized
// chunks (spec 2026-07-26 Decision 1/2). Line-scans the body tracking fenced
// code blocks (``` / ~~~ toggles — a `#` line inside a fence is never a
// heading) and the open ATX heading stack (levels 1-4). A heading line closes
// the current section and starts a new one; the heading line itself remains
// part of ITS section's text (document content — snippets and FTS body text
// stay real, never synthesized). Within a section, paragraphs are packed
// exactly as before (packParagraphs) — no packing across section boundaries,
// ever, even when two small sections would fit in one chunk together (a
// chunk spanning two headings has no honest breadcrumb).
//
// Always returns >=1 chunk, preserving chunkText's old guarantee: an empty or
// whitespace-only body returns a single chunk with the trimmed (possibly
// empty) body and a heading-path-free breadcrumb.
export function chunkDocument(input: ChunkInput): DocumentChunk[] {
  const { title, collection, tags, body } = input;
  const lines = body.split("\n");

  const sections: { headingPath: string[]; text: string }[] = [];
  let currentPath: string[] = [];
  let currentLines: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  const flush = (): void => {
    // currentPath can hold sparse holes (e.g. a document that opens directly
    // at ## with no preceding #, or after a level drops back below one that
    // was never set) — filter them so the heading path is always a dense
    // sequence of the headings actually open, never "undefined › Section".
    const headingPath = currentPath.filter((h): h is string => typeof h === "string");
    sections.push({ headingPath, text: currentLines.join("\n") });
    currentLines = [];
  };

  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1] as string;
      } else if (line.trimStart().startsWith(fenceMarker)) {
        inFence = false;
      }
      currentLines.push(line);
      continue;
    }
    if (!inFence) {
      const headingMatch = ATX_HEADING_RE.exec(line);
      if (headingMatch) {
        flush();
        const level = (headingMatch[1] as string).length;
        const text = stripHeadingText(headingMatch[2] as string);
        currentPath = currentPath.slice(0, level - 1);
        currentPath[level - 1] = text;
        currentLines.push(line);
        continue;
      }
    }
    currentLines.push(line);
  }
  flush();

  const chunks: DocumentChunk[] = [];
  for (const section of sections) {
    if (section.text.trim().length === 0) continue; // empty preamble before an immediate heading
    const context = buildContext({ title, collection, tags }, section.headingPath);
    for (const text of packParagraphs(section.text)) {
      chunks.push({ text, context });
    }
  }

  if (chunks.length === 0) {
    chunks.push({ text: body.trim(), context: buildContext({ title, collection, tags }, []) });
  }
  return chunks;
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
