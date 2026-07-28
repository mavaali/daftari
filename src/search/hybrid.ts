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
// Each ranker still produces raw scores on its own scale. Two fusion modes
// combine them (spec 2026-07-26 fusion overhaul, Decision 1):
//   - "weighted" (relatedSearch's default): both halves are min-normalised
//     to [0, 1] (divide by the top score) and mixed by weight.
//   - "rrf" (hybridSearch's default): each half is converted to a rank list
//     and mixed via reciprocal rank fusion at k=60, SCALED by (k+1) so a
//     rank-1 contribution is 1.0 rather than textbook RRF's 1/61 — ordering-
//     identical to textbook RRF, but keeps fused scores in (0, 1] with a
//     top≈1 scale for downstream consumers (summaryLine's toFixed(3), the
//     rerank pool, vault hooks) that already calibrate against the weighted
//     mode's range. `bm25Score`/`vectorScore` on each hit carry these
//     per-ranker contributions (weighted: normalised score; rrf: scaled
//     reciprocal rank), unweighted; `score` applies the weights on top.
//
// Default weighting is an even 0.5 / 0.5 split.
//
// Vector ranking is best-effort. If the query cannot be embedded (model
// unavailable) or the index holds no embeddings, the search degrades to
// lexical-only and reports vectorUsed: false rather than failing.

import { computeDecay, type DecayState } from "../curation/decay.js";
import type { ValidityReport } from "../curation/validity.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import {
  embeddingToBlob,
  getChunksForPath,
  getDocument,
  getDocumentsByPaths,
  type IndexDb,
} from "../storage/index-db.js";
import { buildMatchQuery, tokenize } from "./bm25.js";
import type { ContestedTension } from "./contested.js";
import type { CurrentSource } from "./current-source.js";
import type { ValidAtSource } from "./valid-at-source.js";
import { embedQuery, getProvider, meanEmbedding } from "./vector.js";

export interface HybridWeights {
  bm25: number;
  vector: number;
}

export const DEFAULT_WEIGHTS: HybridWeights = { bm25: 0.5, vector: 0.5 };

// Fusion mode: how the lexical and vector rank lists are combined into one
// fused score (spec 2026-07-26 fusion overhaul, Decision 1). See the file
// header for the score-scale rationale.
export type FusionMode = "weighted" | "rrf";

// hybridSearch's own default. Flipped to "rrf" in PR 3, gated on the
// fusion-runner.mjs bench (docs/superpowers/specs/2026-07-26-retrieval-
// fusion-overhaul-design.md).
export const DEFAULT_FUSION: FusionMode = "weighted";

// relatedSearch's own default. Deliberately NOT flipped alongside
// DEFAULT_FUSION: relatedSearch is a materially different fusion problem (up
// to 64 prefix-OR'd source tokens, document granularity) with no bench arm
// exercising it. Callers can still opt in via `fusion: "rrf"`.
const RELATED_DEFAULT_FUSION: FusionMode = "weighted";

// RRF's rank-damping constant. Module-private and not configurable — RRF's
// whole appeal is that it needs no tuning; k=60 is the standard literature
// default.
const RRF_K = 60;

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
  // Valid time, evaluated against the caller's `valid_at`. Absent unless
  // `valid_at` was supplied; null when the document authors no interval.
  // Tool handler, not ranker — NEVER a score input: whether a fact held on a
  // date is a filter, not a relevance signal.
  validity?: ValidityReport | null;
  // The chain member whose interval covers `valid_at`, when this hit's does
  // not. Tool handler, not ranker.
  validAtSource?: ValidAtSource;
  currentSource?: CurrentSource; // populated by the tool handler, not the ranker
  contested?: ContestedTension[]; // unresolved tensions, capped at 3 — tool handler, not ranker
  contestedCount?: number; // TOTAL visible tensions (may exceed the cap)
  // #234: set when the doc has pending-broken compiled upstream edges the
  // caller can READ at serve time. Coarse by design (a bucket, never an
  // exact count); the incident classification is never derived from units
  // outside the caller's read scope — those contribute only to the generic
  // hiddenPendingUpstream bucket below, mirroring vault_read's visible /
  // hidden_pending split (#217). Absent = none. Tool handler, not ranker.
  pendingBrokenUpstream?: "some" | "many";
  // #234: pending changes (any class, severity withheld) on compiled
  // upstream edges to units the caller cannot read. Absent = none.
  hiddenPendingUpstream?: "some" | "many";
  // #8 structural decay, coarse per-hit booleans (linker names live on
  // vault_read's structural field, not here). Computed from the caller's
  // vantage — hidden linkers neither count nor leak. Absent = healthy.
  // Tool handler, not ranker.
  orphan?: boolean;
  deprecatedStillLinked?: boolean;
  viaCoverage?: boolean; // true when added by the coverage pass, not the ranker
  coverageReason?: "edge" | "entity-window"; // why it was added (stage 1 sets entity-window)
}

// #3: one entry of the agent-as-judge rerank pool. A compact judging record
// — identity, the fused rank and its component scores, and the ranker's
// snippet — deliberately WITHOUT the enrichment joins the served hits get
// (contested/structural/staleness): the pool exists to be judged against the
// query, and the agent reads any candidate it promotes via vault_read anyway.
export interface RerankCandidate {
  rank: number; // 1-based position in the fused ranking
  path: string;
  title: string;
  collection: string;
  status: string;
  score: number;
  bm25Score: number;
  vectorScore: number;
  snippet: string;
}

export interface HybridSearchResult {
  query: string;
  count: number;
  vectorUsed: boolean;
  weights: HybridWeights;
  hits: HybridHit[];
  // #3: present only when the caller opted in via rerank_candidates. The
  // CALLING AGENT is the reranker — the server prepares the pool and the
  // protocol, it never calls a model (the same agent-as-judge division the
  // tier-2 protocol settled). Tool handler, not ranker.
  rerank?: { instructions: string; candidates: RerankCandidate[] };
  // Part B (local cross-encoder reranker, spec 2026-07-26-contextual-
  // chunking-reranker-design.md Decision 5/7). Set by the TOOL HANDLER, not
  // this ranker — hybridSearch itself never reranks. `false` covers every
  // degrade path uniformly: provider `none`, not-warm skip, inference
  // Result.err, and timeout — the honest twin of `vectorUsed`. Absent from
  // relatedSearch's result (no rerank stage there, spec exclusion).
  rerankUsed?: boolean;
  // Internal transport only (Part B, C2/C4): populated when the caller
  // requested `capturePassageRefs`, one entry per hit in `hits`. The tool
  // handler consumes this to resolve passage TEXT for exactly the rerank
  // pool, then strips it before returning — outputSchema declares
  // additionalProperties: false, and leaking synthesized index-layer refs
  // would fail client-side validation anyway.
  passageRefs?: Record<string, PassageRef>;
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

// Rank-list construction for RRF. Sorts a score map descending (ties broken
// by path ascending, for deterministic ranks) and maps each entry to its
// scaled reciprocal-rank contribution (RRF_K + 1) / (RRF_K + rank), rank
// 1-based. The (RRF_K + 1) numerator is a constant multiple of textbook
// 1/(k + rank): ordering-identical, but contributions live in (0, 1] with
// rank 1 = 1.0, so fused scores keep the top≈1 scale downstream consumers
// (summaryLine's toFixed(3), the rerank pool, vault hooks) already
// calibrate against. An empty map returns an empty map.
function rrfContributions(scores: Map<string, number>): Map<string, number> {
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out = new Map<string, number>();
  ranked.forEach(([path], i) => {
    const rank = i + 1;
    out.set(path, (RRF_K + 1) / (RRF_K + rank));
  });
  return out;
}

// Wraps a prefix-OR'd FTS match string in an FTS5 column filter (e.g. "{title tags}"). Null query → null.
function columnRestrict(matchQuery: string | null, columns: string): string | null {
  return matchQuery === null ? null : `${columns} : (${matchQuery})`;
}

// Band boundary for the chunk-mode tiered lexical combine.
//
// Post-contextual-chunking semantics (spec 2026-07-26-contextual-chunking-
// reranker-design.md, Decision 2 — READ THIS BEFORE CHANGING TIER_SPLIT or
// tieredLexical): every chunk's context column now carries the document's
// title, collection, and tags, so a title- or tag-matching query enters the
// UPPER band via a genuine chunk match (chunkNorm), not just the lower-band
// fallback below. The upper band's meaning has therefore shifted from "any
// BODY match" to "any chunk match, including a context-only match" — the
// strict "body outranks title-only" guarantee now holds only for docs with
// NO context-column match at all. This is the mechanism the spec describes,
// not a bug: bm25(chunks_fts) spans both columns by default weight, which
// *is* contextual BM25.
//
// The `{title tags}` fallback tier below stays — it is spec Decision 2's
// explicitly-kept "strict, harmless fallback" for a doc whose chunks are
// somehow absent from chunks_fts (an index inconsistency, not the common
// case) — largely redundant now that title/tag tokens flow through the
// context column, but its retirement is deferred to the 2026-06-24
// chunk-BM25 native/title-tag regression suites per the spec's own text.
const TIER_SPLIT = 0.5;

// Tiered combine of two normalized lexical signals. chunkNorm is primary — any
// document with a real chunk match (body OR, since contextual chunking,
// title/collection/tag tokens via the context column) lands in the upper band,
// ordered by its chunk bm25 score. titleTagNorm docs that are NOT already
// chunk-matched land in the lower band, ordered by title/tag score — a strict
// fallback that surfaces docs the chunk ranker missed entirely (e.g. its
// chunks are absent from chunks_fts) without ever displacing a real chunk
// match. Both inputs are normalized to (0,1] (no zeros) by the callers, so
// upper band is strictly >0.5 and lower band is <=0.5: strict, tie-free
// separation. The `> 0` guards make that precondition self-enforcing rather
// than relying on the upstream invariant — a non-positive score never creates
// a band entry (so it can't floor a chunk match to exactly 0.5 and tie a
// title-only match).
function tieredLexical(
  chunkNorm: Map<string, number>,
  titleTagNorm: Map<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [p, c] of chunkNorm) if (c > 0) out.set(p, TIER_SPLIT + (1 - TIER_SPLIT) * c);
  for (const [p, t] of titleTagNorm) {
    if (out.has(p) || t <= 0) continue; // already body-matched, or no real title/tag signal
    out.set(p, TIER_SPLIT * t);
  }
  return out;
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
// `readableCollections` constrains the scan to the caller's readable
// collections *inside* the KNN (spec 2026-07-26 fusion, Decision 3). Without
// it the scan spends its K budget vault-wide and the tool handler's
// post-filter can reduce a restricted role's vector half to nothing — the
// starvation bug. Undefined means unfiltered (operator CLI, no access
// context); an EMPTY array means "reads nothing", which is a legitimate
// verdict for the deny-all guest and must not be confused with unfiltered.
//
// This is still omission, not redaction: unreadable documents never enter the
// candidate set, no remainder is computed or reported, and the result is
// shaped exactly as it would be in a vault where those collections do not
// exist (2026-07-14 spec).
// `bestHash` (Part B, C2/C4): the content_hash of each path's best-similarity
// chunk — a cheap ref, not the chunk text itself. Resolving passage TEXT for
// the whole over-fetched candidate set would pay per-candidate joins for an
// O(collection)-sized set to use ~50 (C2); the tool handler resolves text
// only for the top RERANK_POOL permitted hits via getChunkByPathAndHash.
function vecRanking(
  db: IndexDb,
  queryEmbedding: Float32Array,
  modelId: string,
  readableCollections?: string[],
): { scores: Map<string, number>; bestHash: Map<string, string> } {
  const queryBlob = embeddingToBlob(queryEmbedding);
  if (readableCollections !== undefined && readableCollections.length === 0) {
    return { scores: new Map(), bestHash: new Map() };
  }
  const collectionFilter =
    readableCollections === undefined
      ? ""
      : ` AND v.collection IN (${readableCollections.map(() => "?").join(",")})`;
  const rows = db
    .prepare(
      `SELECT c.path AS path, v.content_hash AS content_hash, v.distance AS distance
         FROM embeddings_vec AS v
         JOIN chunks AS c ON c.content_hash = v.content_hash
        WHERE v.embedding MATCH ?
          AND v.model = ?
          AND v.k = ?${collectionFilter}
        ORDER BY v.distance`,
    )
    .all(queryBlob, modelId, VEC_KNN_K, ...(readableCollections ?? [])) as {
    path: string;
    content_hash: string;
    distance: number;
  }[];
  const scores = new Map<string, number>();
  const bestHash = new Map<string, string>();
  for (const r of rows) {
    const sim = Math.max(0, 1 - r.distance);
    const prev = scores.get(r.path) ?? -Infinity;
    if (sim > prev) {
      scores.set(r.path, sim);
      bestHash.set(r.path, r.content_hash);
    }
  }
  return { scores, bestHash };
}

// snippet() excerpt budget, in tokens. ~48 stemmed tokens lands near the
// ~280 chars the JS fallback (SNIPPET_RADIUS * 2) produces, so lexical and
// fallback snippets read at comparable length.
const FTS_SNIPPET_TOKENS = 48;

// Chunk-level lexical ranking. Runs an FTS5 MATCH over `chunks_fts` (one row
// per chunk), reads the inverse bm25 (flip to larger=better), joins back to
// `chunks` on rowid to map onto document paths, and collapses to each
// document's BEST chunk score (max) — mirroring vecRanking's best-per-doc.
// A relevant topic's own chunk scores high even when its whole document is
// long and multi-topic. Null query (no usable tokens) returns empty maps.
//
// The same pass captures each document's excerpt via FTS5 snippet() from its
// best-scoring chunk (#108): the inverted index centres the excerpt on the
// actual match — stemmed variants included, which the JS fallback's literal
// indexOf cannot see — and no full body is scanned in JS. snippet() is
// legal here because chunks_fts is EXTERNAL-CONTENT (content='chunks') with
// a matching column name; documents_fts declares content_body over a base
// column named content, so the document-granularity path deliberately keeps
// the JS fallback instead of a schema migration.
function chunkFtsRanking(
  db: IndexDb,
  query: string | null,
): { scores: Map<string, number>; snippets: Map<string, string>; winners: Map<string, number> } {
  if (query === null) return { scores: new Map(), snippets: new Map(), winners: new Map() };
  const rows = db
    .prepare(
      `SELECT c.path AS path, chunks_fts.rowid AS crowid, -bm25(chunks_fts) AS score
         FROM chunks_fts
         JOIN chunks AS c ON c.rowid = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY bm25(chunks_fts)`,
    )
    .all(query) as { path: string; crowid: number; score: number }[];
  const scores = new Map<string, number>();
  // The winning chunk's FTS rowid per path — the snippet pass below is
  // restricted to exactly these rows, so snippet()'s tokenize/format cost is
  // paid once per DOCUMENT, not once per matched chunk. (A ROW_NUMBER()
  // window subquery would not help here: the projected snippet() is still
  // evaluated per inner row before the window filter, and FTS5 auxiliary
  // functions cannot move outside the MATCH cursor.) Also returned to the
  // caller (Part B, C2/C4): the reranker's passage resolution reuses these
  // same rowids via getChunkTextsByRowids instead of re-deriving a winner.
  const winners = new Map<string, number>();
  for (const r of rows) {
    // Some rows may produce a non-positive flipped score if FTS5 returned a
    // positive bm25 (rare with prefix matches); drop them so the normalize
    // step sees only positive values.
    // Note: BM25 scores here are computed over the CHUNK corpus (avgdl =
    // average chunk length), a different normalization base than ftsRanking's
    // document corpus. The two rankers are never mixed in the same call —
    // rankDocuments routes to exactly one based on lexicalGranularity — so
    // their raw scores are never directly compared.
    if (r.score <= 0) continue;
    const prev = scores.get(r.path) ?? -Infinity;
    if (r.score > prev) {
      scores.set(r.path, r.score);
      // Keying on the max KEPT score guarantees the snippet always comes
      // from the same chunk the document's score does.
      winners.set(r.path, r.crowid);
    }
  }

  const snippets = new Map<string, string>();
  if (winners.size > 0) {
    const ids = [...winners.values()];
    const placeholders = ids.map(() => "?").join(",");
    // Column 1 (`text`) ONLY — spec Decision 4. chunks_fts is (context, text);
    // targeting column 1 means a served snippet can never contain the
    // synthesized breadcrumb, even when the query matched ONLY in the context
    // column (a title/tag-only match). That case's snippet degrades to the
    // chunk's leading body text — acceptable, and strictly better than
    // showing invented lines.
    const snips = db
      .prepare(
        `SELECT c.path AS path, snippet(chunks_fts, 1, '', '', '…', ?) AS snip
           FROM chunks_fts
           JOIN chunks AS c ON c.rowid = chunks_fts.rowid
          WHERE chunks_fts MATCH ? AND chunks_fts.rowid IN (${placeholders})`,
      )
      .all(FTS_SNIPPET_TOKENS, query, ...ids) as { path: string; snip: string }[];
    for (const s of snips) {
      const collapsed = s.snip.replace(/\s+/g, " ").trim();
      if (collapsed.length > 0) snippets.set(s.path, collapsed);
    }
  }
  return { scores, snippets, winners };
}

// Part B (reranker) passage reference — a cheap POINTER to the chunk that
// carried a hit's ranking, not the chunk text itself (C2: resolving text for
// the whole over-fetched candidate set would pay per-candidate joins for a
// set sized O(collection) to use ~50). The tool handler resolves text for
// exactly the top RERANK_POOL permitted hits via the storage-layer lookups
// (getChunkTextsByRowids / getChunkByPathAndHash / getFirstChunk).
export type PassageRef =
  | { kind: "lexical"; rowid: number }
  | { kind: "vector"; contentHash: string }
  | { kind: "first" };

// Provenance choice (C4): a hit with both a lexical winner and a KNN-best
// chunk presents the chunk from whichever signal contributed the higher
// NORMALIZED score for that path — the cross-encoder judges the document on
// the chunk that is the reason it ranked. `lexicalNorm`/`vecNorm` are the
// within-ranker normalized (0,1] maps, independent of fusion mode (weighted
// vs RRF is a downstream combination detail, not a provenance decision).
// Only-one-signal-present → that one. Neither (a title/tag-tier-only hit,
// or document-granularity search) → the terminal `first` fallback.
function choosePassageRef(
  path: string,
  lexicalNorm: Map<string, number>,
  winners: Map<string, number>,
  vecNorm: Map<string, number>,
  bestHash: Map<string, string>,
): PassageRef {
  const lex = lexicalNorm.get(path) ?? 0;
  const vec = vecNorm.get(path) ?? 0;
  const hasLex = lex > 0 && winners.has(path);
  const hasVec = vec > 0 && bestHash.has(path);
  if (hasLex && hasVec) {
    return vec > lex
      ? { kind: "vector", contentHash: bestHash.get(path) as string }
      : { kind: "lexical", rowid: winners.get(path) as number };
  }
  if (hasLex) return { kind: "lexical", rowid: winners.get(path) as number };
  if (hasVec) return { kind: "vector", contentHash: bestHash.get(path) as string };
  return { kind: "first" };
}

interface RankOptions {
  weights: HybridWeights;
  limit: number;
  excludePath?: string;
  lexicalGranularity: "document" | "chunk";
  // Readable-collection allow-list pushed into the KNN scan; see vecRanking.
  readableCollections?: string[];
  fusion: FusionMode;
  // Part B: attach a cheap PassageRef per hit (see choosePassageRef) instead
  // of resolving passage text here. Off by default — ref capture is wasted
  // work when no reranker is configured (C2's "skip ref capture" revision).
  capturePassageRefs?: boolean;
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
): { hits: HybridHit[]; vectorUsed: boolean; passageRefs: Map<string, PassageRef> } {
  let bm25Norm: Map<string, number>;
  // Best-chunk excerpts from the lexical pass (#108); empty for the
  // document-granularity path, whose hits fall back to the JS scan.
  let lexicalSnippets = new Map<string, string>();
  // Raw (within-ranker-normalized) lexical/chunk signals, kept around ONLY
  // for choosePassageRef — bm25Norm below is the TIERED combine that feeds
  // the actual ranking; the passage-provenance choice wants the un-tiered
  // chunk signal specifically (C4).
  let chunkNormForRefs = new Map<string, number>();
  let chunkWinners = new Map<string, number>();
  if (opts.lexicalGranularity === "chunk") {
    // Body granularity (the dilution fix) TIERED with a clean title/tag signal
    // (the native-shape fix). Each is normalized to its own max to reconcile the
    // two FTS score scales; tieredLexical then ranks every chunk match (which,
    // since contextual chunking, includes title/collection/tag-only matches via
    // the context column — see the TIER_SPLIT comment) above every doc the
    // chunk ranker missed entirely. The title/tag signal reuses ftsRanking with
    // a column-restricted query so it scores title+tags only (no body dilution).
    const chunkRanked = chunkFtsRanking(db, matchQuery);
    lexicalSnippets = chunkRanked.snippets;
    chunkWinners = chunkRanked.winners;
    const chunkNorm = normalize(chunkRanked.scores);
    chunkNormForRefs = chunkNorm;
    const titleTagNorm = normalize(ftsRanking(db, columnRestrict(matchQuery, "{title tags}")));
    bm25Norm = tieredLexical(chunkNorm, titleTagNorm);
  } else {
    bm25Norm = normalize(ftsRanking(db, matchQuery));
  }

  let vectorRaw = new Map<string, number>();
  let vectorUsed = false;
  let vecBestHash = new Map<string, string>();
  if (queryEmbedding) {
    const provider = getProvider();
    const vecRanked = vecRanking(db, queryEmbedding, provider.id, opts.readableCollections);
    vectorRaw = vecRanked.scores;
    vecBestHash = vecRanked.bestHash;
    if (vectorRaw.size > 0) vectorUsed = true;
  }

  // With no usable vector signal, lexical ranking carries the full weight.
  const weights: HybridWeights = vectorUsed ? opts.weights : { bm25: 1, vector: 0 };

  // The two fusion modes differ only in how the lexical map (bm25Norm, built
  // above — untouched by fusion mode) meets the vector map. "weighted" keeps
  // today's cross-ranker normalize(); "rrf" replaces both with rank-based
  // scaled-reciprocal-rank contributions and never normalizes across
  // rankers. See rrfContributions and the file header.
  const lexScores = opts.fusion === "rrf" ? rrfContributions(bm25Norm) : bm25Norm;
  const vecNormForScore = normalize(vectorRaw);
  const vecScores = opts.fusion === "rrf" ? rrfContributions(vectorRaw) : vecNormForScore;

  const candidates = new Set<string>([...lexScores.keys(), ...vecScores.keys()]);

  // Fetch full rows for ONLY the candidate paths — not the whole vault. The
  // FTS + vector rankers above have already collapsed the vault to a small set
  // (typically < 100), so the expensive full-row read (content blob + JSON
  // tag/token parse in rowToDocument) is scoped to that set instead of running
  // O(vault) on every query. The related-search source path is excluded from
  // the fetch — the loop below skips it anyway, so its row is never needed.
  const fetchPaths = [...candidates].filter((path) => path !== opts.excludePath);
  const byPath = new Map(getDocumentsByPaths(db, fetchPaths).map((d) => [d.path, d]));

  const hits: HybridHit[] = [];
  const passageRefs = new Map<string, PassageRef>();
  for (const path of candidates) {
    if (path === opts.excludePath) continue;
    const doc = byPath.get(path);
    if (!doc) continue;
    const bm25Score = lexScores.get(path) ?? 0;
    const vectorScore = vecScores.get(path) ?? 0;
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
      // FTS5's excerpt for lexical hits (#108); the JS body scan remains the
      // fallback for vector-only and title/tag-only hits, which have no
      // matched body chunk to centre on.
      snippet: lexicalSnippets.get(path) ?? makeSnippet(doc.content, queryTokensForSnippet),
      decay: computeDecay({
        status: doc.status,
        confidence: doc.confidence,
        updated: doc.updated,
        created: doc.created,
        ttl_days: doc.ttlDays,
        superseded_by: doc.supersededBy,
      }),
    });
    if (opts.capturePassageRefs) {
      passageRefs.set(
        path,
        choosePassageRef(path, chunkNormForRefs, chunkWinners, vecNormForScore, vecBestHash),
      );
    }
  }

  // Deterministic tie-break in BOTH modes: exact fused-score ties are common
  // under RRF (many candidates share the same rank-derived contribution),
  // and insertion order otherwise descends from SQL row order with no
  // cross-run guarantee. Benign for weighted mode too — it only reorders
  // exact ties, which SQL row order previously broke arbitrarily.
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const sliced = hits.slice(0, opts.limit);
  // Trim passageRefs to exactly the paths in the sliced result — the map was
  // built over the full candidate set above.
  const slicedRefs = new Map<string, PassageRef>();
  if (opts.capturePassageRefs) {
    for (const h of sliced) {
      const ref = passageRefs.get(h.path);
      if (ref) slicedRefs.set(h.path, ref);
    }
  }
  return { hits: sliced, vectorUsed, passageRefs: slicedRefs };
}

export interface HybridSearchOptions {
  weights?: HybridWeights;
  limit?: number;
  lexicalGranularity?: "document" | "chunk";
  // When true, return EVERY ranked candidate instead of just the top `limit`.
  // An RBAC-filtering caller sets this so it can drop restricted-collection
  // hits and THEN slice to its user-facing `limit` — otherwise restricted docs
  // occupying the top-`limit` slots would shrink the permitted set below
  // `limit` (results are ranked, then sliced, before the tool handler runs
  // canRead). The extra candidates cost nothing to materialize: rankDocuments
  // already builds a hit (snippet included) for every candidate before slicing.
  overFetch?: boolean;
  // Collections the caller may read. Pushed into the vector KNN so a
  // restricted role's K budget is spent on chunks it can actually read
  // (spec 2026-07-26 fusion, Decision 3). Undefined = unfiltered, as today;
  // the tool handler's post-rank canRead filter remains the authorization
  // boundary either way, and still covers the lexical half.
  readableCollections?: string[];
  // Fusion mode (spec 2026-07-26 fusion overhaul, Decision 1). Library-level
  // option — no MCP tool argument grows for it. hybridSearch defaults to
  // DEFAULT_FUSION; relatedSearch defaults to its own RELATED_DEFAULT_FUSION.
  fusion?: FusionMode;
  // Part B: attach a PassageRef per hit so the tool handler can resolve
  // rerank passage text without rankDocuments paying per-candidate joins for
  // the whole over-fetched set (C2). Only vaultSearch sets this, and only
  // when a reranker is actually configured — ref capture is wasted work
  // otherwise.
  capturePassageRefs?: boolean;
}

// Ranks vault documents against a free-text query.
export async function hybridSearch(
  db: IndexDb,
  query: string,
  options: HybridSearchOptions = {},
): Promise<Result<HybridSearchResult, Error>> {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const limit = options.limit ?? 10;
  const fusion = options.fusion ?? DEFAULT_FUSION;
  // Default flipped to "chunk" in v1.29.0: chunk-level BM25 recovers the
  // multi-topic-document dilution gap (RB recall + SQuAD retrieval) and produces
  // better end-to-end answers where it out-retrieves document, with no regression
  // where it doesn't (docs/superpowers/results/2026-06-24-chunk-bm25-answer-quality.md).
  // Title/tag-safe via the tiered combine (#157). Callers opt back with "document".
  const lexicalGranularity = options.lexicalGranularity ?? "chunk";
  // Over-fetch returns all ranked candidates so an RBAC caller can filter then
  // slice; the plain path keeps the top-`limit` contract other callers rely on.
  const rankLimit = options.overFetch ? Number.POSITIVE_INFINITY : limit;
  const matchQuery = buildMatchQuery(query);
  const snippetTokens = tokenize(query);

  // Skip embedding when vector weight is zero — avoids vectorUsed:true being
  // reported for a pure-lexical call, which would misrepresent the ranking mode.
  let queryEmbedding: Float32Array | null = null;
  if (weights.vector > 0) {
    const embedResult = await embedQuery(query);
    queryEmbedding = embedResult.ok ? embedResult.value : null;
  }

  const { hits, vectorUsed, passageRefs } = rankDocuments(
    db,
    matchQuery,
    queryEmbedding,
    snippetTokens,
    {
      weights,
      limit: rankLimit,
      excludePath: undefined,
      lexicalGranularity,
      readableCollections: options.readableCollections,
      fusion,
      capturePassageRefs: options.capturePassageRefs,
    },
  );

  return ok({
    query,
    count: hits.length,
    vectorUsed,
    weights: vectorUsed ? weights : { bm25: 1, vector: 0 },
    hits,
    ...(options.capturePassageRefs ? { passageRefs: Object.fromEntries(passageRefs) } : {}),
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
  const fusion = options.fusion ?? RELATED_DEFAULT_FUSION;
  // See hybridSearch: over-fetch lets the RBAC-filtering tool handler drop
  // restricted hits before slicing to the user-facing limit.
  const rankLimit = options.overFetch ? Number.POSITIVE_INFINITY : limit;

  const doc = getDocument(db, path);
  if (!doc) {
    return err(new Error(`document not indexed: ${path} (try vault_reindex)`));
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
    limit: rankLimit,
    excludePath: path,
    lexicalGranularity: "document",
    readableCollections: options.readableCollections,
    fusion,
  });

  return ok({
    path,
    count: hits.length,
    vectorUsed,
    weights: vectorUsed ? weights : { bm25: 1, vector: 0 },
    hits,
  });
}
