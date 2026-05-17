// Hybrid search: combine BM25 lexical ranking with vector semantic ranking.
//
// Each ranker produces raw scores on its own scale, so both are min-normalised
// to [0, 1] (divide by the top score) before being mixed by weight. Default
// weighting is an even 0.5 / 0.5 split.
//
// Vector ranking is best-effort. If the query cannot be embedded (model
// unavailable) or the index holds no embeddings, the search degrades to
// lexical-only and reports vectorUsed: false rather than failing.

import { computeDecay, type DecayState } from "../curation/decay.js";
import { ok, type Result } from "../frontmatter/types.js";
import {
  getAllChunks,
  getAllDocuments,
  getChunksForPath,
  getDocument,
  type IndexDb,
} from "../storage/index-db.js";
import { buildBm25, searchBm25, tokenize } from "./bm25.js";
import { cosineSimilarity, embedQuery, meanEmbedding } from "./vector.js";

export interface HybridWeights {
  bm25: number;
  vector: number;
}

export const DEFAULT_WEIGHTS: HybridWeights = { bm25: 0.5, vector: 0.5 };

export interface HybridHit {
  path: string;
  title: string;
  collection: string;
  status: string;
  score: number;
  bm25Score: number;
  vectorScore: number;
  snippet: string;
  decay: DecayState | null;
}

export interface HybridSearchResult {
  query: string;
  count: number;
  vectorUsed: boolean;
  weights: HybridWeights;
  hits: HybridHit[];
}

const SNIPPET_RADIUS = 140;

// Pulls a readable excerpt from a document body, centred on the earliest
// occurrence of any query term. Falls back to the document head when no term
// is found (e.g. a purely semantic match).
function makeSnippet(content: string, queryTokens: string[]): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "";
  const lower = collapsed.toLowerCase();

  let hitAt = -1;
  for (const term of queryTokens) {
    const at = lower.indexOf(term);
    if (at !== -1 && (hitAt === -1 || at < hitAt)) hitAt = at;
  }

  if (hitAt === -1) {
    return collapsed.length > SNIPPET_RADIUS * 2
      ? `${collapsed.slice(0, SNIPPET_RADIUS * 2)}…`
      : collapsed;
  }

  const start = Math.max(0, hitAt - SNIPPET_RADIUS);
  const end = Math.min(collapsed.length, hitAt + SNIPPET_RADIUS);
  let snippet = collapsed.slice(start, end);
  if (start > 0) snippet = `…${snippet}`;
  if (end < collapsed.length) snippet = `${snippet}…`;
  return snippet;
}

// Divides every score by the largest so the top hit becomes 1.0. An empty or
// all-zero map normalises to all zeros.
function normalize(scores: Map<string, number>): Map<string, number> {
  let max = 0;
  for (const v of scores.values()) if (v > max) max = v;
  if (max === 0) return new Map([...scores].map(([k]) => [k, 0]));
  return new Map([...scores].map(([k, v]) => [k, v / max]));
}

interface RankOptions {
  weights: HybridWeights;
  limit: number;
  excludePath?: string;
}

// Core ranker shared by query search and related-document search. queryTokens
// drives BM25; queryEmbedding (when present) drives vector similarity against
// every embedded chunk, taking each document's best-matching chunk.
function rankDocuments(
  db: IndexDb,
  queryTokens: string[],
  queryEmbedding: Float32Array | null,
  opts: RankOptions,
): { hits: HybridHit[]; vectorUsed: boolean } {
  const documents = getAllDocuments(db);
  const byPath = new Map(documents.map((d) => [d.path, d]));

  const bm25Model = buildBm25(documents.map((d) => ({ path: d.path, tokens: d.tokens })));
  const bm25Raw = new Map<string, number>();
  for (const hit of searchBm25(bm25Model, queryTokens)) {
    bm25Raw.set(hit.path, hit.score);
  }

  const vectorRaw = new Map<string, number>();
  let vectorUsed = false;
  if (queryEmbedding) {
    for (const chunk of getAllChunks(db)) {
      if (!chunk.embedding) continue;
      vectorUsed = true;
      const sim = cosineSimilarity(queryEmbedding, chunk.embedding);
      const prev = vectorRaw.get(chunk.path) ?? -Infinity;
      if (sim > prev) vectorRaw.set(chunk.path, sim);
    }
  }

  const bm25Norm = normalize(bm25Raw);
  const vectorNorm = normalize(vectorRaw);

  // With no usable vector signal, lexical ranking carries the full weight.
  const weights: HybridWeights = vectorUsed ? opts.weights : { bm25: 1, vector: 0 };

  const candidates = new Set<string>([...bm25Norm.keys(), ...vectorNorm.keys()]);

  const hits: HybridHit[] = [];
  for (const path of candidates) {
    if (path === opts.excludePath) continue;
    const doc = byPath.get(path);
    if (!doc) continue;
    const bm25Score = bm25Norm.get(path) ?? 0;
    const vectorScore = vectorNorm.get(path) ?? 0;
    const score = weights.bm25 * bm25Score + weights.vector * vectorScore;
    if (score <= 0) continue;
    hits.push({
      path,
      title: doc.title,
      collection: doc.collection,
      status: doc.status,
      score,
      bm25Score,
      vectorScore,
      snippet: makeSnippet(doc.content, queryTokens),
      decay: computeDecay({
        status: doc.status,
        confidence: doc.confidence,
        updated: doc.updated,
        created: doc.created,
        ttl_days: doc.ttlDays,
        superseded_by: doc.supersededBy,
      }),
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, opts.limit), vectorUsed };
}

export interface HybridSearchOptions {
  weights?: HybridWeights;
  limit?: number;
}

// Ranks vault documents against a free-text query.
export async function hybridSearch(
  db: IndexDb,
  query: string,
  options: HybridSearchOptions = {},
): Promise<Result<HybridSearchResult, Error>> {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const limit = options.limit ?? 10;
  const queryTokens = tokenize(query);

  const embedResult = await embedQuery(query);
  const queryEmbedding = embedResult.ok ? embedResult.value : null;

  const { hits, vectorUsed } = rankDocuments(db, queryTokens, queryEmbedding, {
    weights,
    limit,
    excludePath: undefined,
  });

  return ok({
    query,
    count: hits.length,
    vectorUsed,
    weights: vectorUsed ? weights : { bm25: 1, vector: 0 },
    hits,
  });
}

export interface RelatedSearchResult {
  path: string;
  count: number;
  vectorUsed: boolean;
  weights: HybridWeights;
  hits: HybridHit[];
}

// Finds documents related to an already-indexed document. The source document
// itself is the query: its BM25 tokens drive lexical similarity and the mean
// of its chunk embeddings drives semantic similarity. The source is excluded
// from its own results. Needs no embedding model — it reuses vectors already
// stored in the index.
export function relatedSearch(
  db: IndexDb,
  path: string,
  options: HybridSearchOptions = {},
): Result<RelatedSearchResult, Error> {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const limit = options.limit ?? 10;

  const doc = getDocument(db, path);
  if (!doc) {
    return {
      ok: false,
      error: new Error(`document not indexed: ${path} (try vault_reindex)`),
    };
  }

  const chunkVectors = getChunksForPath(db, path)
    .map((c) => c.embedding)
    .filter((e): e is Float32Array => e !== null);
  const queryEmbedding = meanEmbedding(chunkVectors);

  const { hits, vectorUsed } = rankDocuments(db, doc.tokens, queryEmbedding, {
    weights,
    limit,
    excludePath: path,
  });

  return ok({
    path,
    count: hits.length,
    vectorUsed,
    weights: vectorUsed ? weights : { bm25: 1, vector: 0 },
    hits,
  });
}
