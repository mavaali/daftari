// Hybrid search: combine FTS5 lexical ranking with sqlite-vec semantic
// ranking.
//
// Both halves are now SQL-native:
//   - The lexical half runs an FTS5 MATCH query over `documents_fts` and
//     reads SQLite's built-in BM25 score.
//   - The vector half runs a KNN query over the sqlite-vec `embeddings_vec`
//     virtual table, joining back to `chunks` to map content hashes onto
//     document paths.
//
// Each ranker still produces raw scores on its own scale, so both are
// min-normalised to [0, 1] (divide by the top score) before being mixed by
// weight. Default weighting is an even 0.5 / 0.5 split.
//
// Vector ranking is best-effort. If the query cannot be embedded (model
// unavailable) or the index holds no embeddings, the search degrades to
// lexical-only and reports vectorUsed: false rather than failing.

import { computeDecay, type DecayState } from "../curation/decay.js";
import { ok, type Result } from "../frontmatter/types.js";
import {
  embeddingToBlob,
  getAllDocuments,
  getChunksForPath,
  getDocument,
  type IndexDb,
} from "../storage/index-db.js";
import { buildMatchQuery, tokenize } from "./bm25.js";
import { embedQuery, getProvider, meanEmbedding } from "./vector.js";

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

// How many KNN neighbours to ask sqlite-vec for. The vec table is per-chunk,
// not per-document, so this is the chunk fan-out we will then collapse to
// best-per-document. A multiple of the user-facing limit keeps the hybrid
// fusion honest — if we only fetched `limit` chunks we'd risk every one
// belonging to the same document and starving the rest of the candidate set.
// 64 is empirically generous for typical limit ≤ 10; bump if vault chunk
// counts grow into the millions.
const VEC_KNN_K = 64;

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

// Runs an FTS5 MATCH against `documents_fts` and returns a path → score
// map. The FTS5 `bm25()` function is INVERSE (smaller = better, can be
// negative for strong hits), so we flip the sign to `larger = better` and
// then normalise the largest to 1.0 in the caller. A null query (no usable
// tokens after sanitization) returns an empty map.
function ftsRanking(db: IndexDb, query: string | null): Map<string, number> {
  if (query === null) return new Map();
  const rows = db
    .prepare(
      `SELECT d.path AS path, -bm25(documents_fts) AS score
         FROM documents_fts
         JOIN documents AS d ON d.rowid = documents_fts.rowid
        WHERE documents_fts MATCH ?
        ORDER BY bm25(documents_fts)`,
    )
    .all(query) as { path: string; score: number }[];
  const result = new Map<string, number>();
  for (const r of rows) {
    // Some rows may produce a negative flipped score if FTS5 returned a
    // positive bm25 (rare with prefix matches); shift to ensure the
    // normalize step sees only non-negative values.
    if (r.score > 0) result.set(r.path, r.score);
  }
  return result;
}

// Runs a KNN query against the sqlite-vec `embeddings_vec` mirror, joins
// against `chunks` to map content hashes onto document paths, and returns a
// path → best-similarity map. sqlite-vec returns a cosine *distance*
// (smaller = closer), so similarity is `1 - distance` clamped to [0, 1].
// We keep each document's best-matching chunk.
function vecRanking(
  db: IndexDb,
  queryEmbedding: Float32Array,
  modelId: string,
): Map<string, number> {
  const queryBlob = embeddingToBlob(queryEmbedding);
  const rows = db
    .prepare(
      `SELECT c.path AS path, v.distance AS distance
         FROM embeddings_vec AS v
         JOIN chunks AS c ON c.content_hash = v.content_hash
        WHERE v.embedding MATCH ?
          AND v.model = ?
          AND v.k = ?
        ORDER BY v.distance`,
    )
    .all(queryBlob, modelId, VEC_KNN_K) as { path: string; distance: number }[];
  const result = new Map<string, number>();
  for (const r of rows) {
    const sim = Math.max(0, 1 - r.distance);
    const prev = result.get(r.path) ?? -Infinity;
    if (sim > prev) result.set(r.path, sim);
  }
  return result;
}

interface RankOptions {
  weights: HybridWeights;
  limit: number;
  excludePath?: string;
}

// Core ranker shared by query search and related-document search.
// `matchQuery` is the FTS5 MATCH string (already prefix-OR'd, or null);
// `queryEmbedding` (when present) drives sqlite-vec KNN against every
// indexed chunk, keeping each document's best-matching chunk.
// `queryTokensForSnippet` is used purely to centre snippets on the first
// matching term — it doesn't drive ranking.
function rankDocuments(
  db: IndexDb,
  matchQuery: string | null,
  queryEmbedding: Float32Array | null,
  queryTokensForSnippet: string[],
  opts: RankOptions,
): { hits: HybridHit[]; vectorUsed: boolean } {
  const documents = getAllDocuments(db);
  const byPath = new Map(documents.map((d) => [d.path, d]));

  const bm25Raw = ftsRanking(db, matchQuery);

  let vectorRaw = new Map<string, number>();
  let vectorUsed = false;
  if (queryEmbedding) {
    const provider = getProvider();
    vectorRaw = vecRanking(db, queryEmbedding, provider.id);
    if (vectorRaw.size > 0) vectorUsed = true;
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
      snippet: makeSnippet(doc.content, queryTokensForSnippet),
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
  const matchQuery = buildMatchQuery(query);
  const snippetTokens = tokenize(query);

  const embedResult = await embedQuery(query);
  const queryEmbedding = embedResult.ok ? embedResult.value : null;

  const { hits, vectorUsed } = rankDocuments(db, matchQuery, queryEmbedding, snippetTokens, {
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
// itself is the query: its tokens drive an FTS5 MATCH for lexical
// similarity, and the mean of its chunk embeddings drives semantic
// similarity via sqlite-vec. The source is excluded from its own results.
// Needs no embedding model — it reuses vectors already stored in the index.
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

  const provider = getProvider();
  const chunkVectors = getChunksForPath(db, path, provider.id, provider.dim)
    .map((c) => c.embedding)
    .filter((e): e is Float32Array => e !== null);
  const queryEmbedding = meanEmbedding(chunkVectors);

  // Build the FTS5 match string from the source document's stored token
  // list (title + tags + body, tokenized at index time). Cap the token
  // count: a long document's full token list produces a MATCH string that
  // is mostly noise and forces FTS5 to do enormous work. The most
  // informative terms are typically the rarer ones, but since we don't
  // have IDF readily available here we use a simple truncate to the first
  // N unique tokens — title + early body — which is the same heuristic the
  // hand-rolled BM25 implicitly used.
  const sourceTokens = [...new Set(doc.tokens)].slice(0, 64);
  const matchQuery =
    sourceTokens.length === 0 ? null : sourceTokens.map((t) => `${t}*`).join(" OR ");

  const { hits, vectorUsed } = rankDocuments(db, matchQuery, queryEmbedding, doc.tokens, {
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
