// Search-path tools: vault_search, vault_search_related, vault_reindex.
//
// Like the read-path tools, each exposes a pure logic function (returns
// Result, never throws) plus an MCP ToolDefinition. The logic functions own
// the index-db lifecycle: they open the SQLite index, run the query, and close
// it. If the index is empty (first run after a fresh clone) they trigger a
// reindex first, so search works without an explicit setup step.

import { type AccessContext, canRead } from "../access/rbac.js";
import { currentConsumesEdges } from "../curation/consumes.js";
import {
  compiledUpstreamStaleness,
  loadCompiledStaleContext,
  splitUpstreamVisibility,
} from "../curation/edge-staleness.js";
import { recordReads } from "../curation/read-log.js";
import { structuralDecay } from "../curation/structural.js";
import { sourceReadable } from "../curation/tension-access.js";
import { bucketHiddenDownstream } from "../curation/tension-blast.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { contestedFor } from "../search/contested.js";
import {
  applyCoveragePass,
  DEFAULT_COVERAGE_OPTIONS,
  enforceTokenCap,
} from "../search/coverage.js";
import { resolveCurrentSource } from "../search/current-source.js";
import {
  DEFAULT_WEIGHTS,
  type HybridHit,
  type HybridSearchResult,
  type HybridWeights,
  hybridSearch,
  type RelatedSearchResult,
  relatedSearch,
} from "../search/hybrid.js";
import {
  getIndexStatus,
  indexingBusyMessage,
  markIndexError,
  markIndexing,
  markIndexReady,
  onceIndexReady,
} from "../search/index-state.js";
import { type ReindexResult, reindexVault } from "../search/reindex.js";
import { getProvider } from "../search/vector.js";
import { documentCount, type IndexDb, openIndexDb } from "../storage/index-db.js";
import type { ToolDefinition } from "./read.js";

// All tool-side opens pass the active provider's dim so the sqlite-vec
// table matches the embeddings the search will query. A read-only tool
// that opens after a provider switch would otherwise face a vec table
// sized for the *previous* provider's vectors.
//
// Exported so other index-backed tools (vault_themes) reuse the same
// dim-aware open path.
export function openIndexForActiveProvider(vaultRoot: string): Result<IndexDb, Error> {
  return openIndexDb(vaultRoot, getProvider().dim);
}

// Read-only index handle for RBAC collection lookups. openIndexForActiveProvider
// ONLY — never ensureIndexReady, which reindexes on an empty index; visibility
// gates must never reindex. Open failure degrades to null: visibility then
// gates on the pure first-segment rule (fail-closed), and the tool call
// itself never fails for RBAC-lookup reasons.
export function openIndexForAccessOrNull(vaultRoot: string): IndexDb | null {
  const opened = openIndexForActiveProvider(vaultRoot);
  return opened.ok ? opened.value : null;
}

// Gate every index-backed tool on the current indexing state.
//
// - "indexing": refuse with a progress-bearing message. The server is still
//   embedding the vault from cold; the client should retry shortly.
// - "error":    refuse with the prior failure so the client sees a real
//   diagnostic instead of an empty / partial result set.
// - "ready":    fall through to the per-tool logic, with one fallback: if
//   the SQLite index is empty (a direct test invocation that never went
//   through main(), or a vault whose .daftari directory was wiped) trigger
//   a synchronous reindex so search still works without an explicit
//   --reindex step.
//
// Exported so other index-backed tools (vault_themes) reuse the same
// readiness gate.
export async function ensureIndexReady(vaultRoot: string): Promise<Result<void, Error>> {
  const status = getIndexStatus();
  if (status.status === "indexing") {
    return err(new Error(indexingBusyMessage(status)));
  }
  if (status.status === "error") {
    return err(new Error(`vault index is in error state: ${status.error ?? "unknown"}`));
  }
  const dbResult = openIndexForActiveProvider(vaultRoot);
  if (!dbResult.ok) return dbResult;
  const empty = documentCount(dbResult.value) === 0;
  dbResult.value.close();
  if (empty) {
    markIndexing();
    const reindexed = await reindexVault(vaultRoot);
    if (!reindexed.ok) {
      markIndexError(reindexed.error.message);
      return reindexed;
    }
    markIndexReady();
  }
  return ok(undefined);
}

function parseWeights(raw: unknown): HybridWeights {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const bm25 = obj.bm25;
    const vector = obj.vector;
    if (
      typeof bm25 === "number" &&
      typeof vector === "number" &&
      bm25 >= 0 &&
      vector >= 0 &&
      bm25 + vector > 0
    ) {
      return { bm25, vector };
    }
  }
  return DEFAULT_WEIGHTS;
}

function parseLimit(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.floor(raw), 50);
  }
  return 10;
}

// #3: rerank pool size. 0 = feature off (the default — absent or invalid
// mirrors parseLimit's silent-fallback posture). Capped: the pool is token
// cost in the caller's context window, and past ~30 snippets judgment
// quality decays faster than recall improves.
const RERANK_CANDIDATES_MAX = 30;
function parseRerankCandidates(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.floor(raw), RERANK_CANDIDATES_MAX);
  }
  return 0;
}

// The agent-as-judge protocol text (#3), one fixed string like the #169
// supersede hint: the signal is the field's presence and a stable text is
// grep-able in agent traces. The server never calls a model — the same
// division of labor the tier-2 protocol settled: it prepares constrained
// judging context; the CALLING agent is the judge.
const RERANK_INSTRUCTIONS =
  "You are the reranker. The candidates below are the fused hybrid ranking " +
  "(BM25 + vector); their scores measure retrieval proximity, NOT whether a " +
  "candidate answers the query. Judge each candidate's snippet against the " +
  "query and reorder by how well it answers. Candidates ranked past the " +
  "returned hits may outrank them — promote them if they answer better. " +
  "Read any candidate you promote with vault_read before relying on it: " +
  "candidates carry no enrichment (tensions, staleness, structural flags); " +
  "the served hits and vault_read do.";

// #234 serve instrumentation, shared by every snippet-serving tool
// (vault_search AND vault_search_related — the broken-read rate's
// denominator counts serves, whichever tool served them). Each SERVED hit
// becomes one read-log entry carrying its pending-broken upstream count —
// the TRUE count, unfiltered, because the log is local operator telemetry —
// batched into a single append so N hits do not pay N fs writes.
//
// The caller-facing hit uses the shared #217 split (splitUpstreamVisibility):
// the "broken" (incident) classification is disclosed only for upstream
// units the caller can read — pendingBrokenUpstream buckets the VISIBLE
// broken count. Edges to unreadable units contribute only the generic
// hiddenPendingUpstream bucket, which never carries severity: an incident
// verdict derived from a hidden unit would leak that unit's change activity
// across the ACL boundary. The visible count is bucketed for hit-payload
// compactness, not disclosure — vault_read's exact pending_broken is the
// drill-down. Best-effort: a telemetry failure never fails the search.
async function annotateAndLogServedHits(
  vaultRoot: string,
  db: IndexDb,
  tool: string,
  hits: HybridHit[],
  access?: AccessContext,
): Promise<void> {
  if (hits.length === 0) return;
  // The newest-compile-group collapse is O(total edges); do it ONCE per
  // call, not per hit. Passing the pre-collapsed set through is sound
  // because currentConsumesEdges is idempotent. An empty consumes log
  // short-circuits before the provenance log is read at all — with zero
  // compiled edges every broken count is zero (same posture as vault_read).
  const loaded = await loadCompiledStaleContext(vaultRoot);
  const staleCtx = loaded
    ? { consumes: currentConsumesEdges(loaded.consumes), provenance: loaded.provenance }
    : null;
  const entries: Parameters<typeof recordReads>[1] = [];
  for (const hit of hits) {
    let broken: number | undefined;
    if (staleCtx) {
      const rows = compiledUpstreamStaleness(hit.path, staleCtx.consumes, staleCtx.provenance);
      broken = rows.filter((r) => r.staleness === "pending-broken").length;
      // `db` is the caller's already-open index handle — the same one the
      // other RBAC enrichments (resolveCurrentSource, contestedFor) read.
      const { visible, hiddenPending } = access
        ? splitUpstreamVisibility(rows, (unit) => sourceReadable(db, access, unit))
        : { visible: rows, hiddenPending: "none" as const };
      const visibleBroken = visible.filter((r) => r.staleness === "pending-broken").length;
      const brokenBucket = bucketHiddenDownstream(visibleBroken);
      if (brokenBucket !== "none") hit.pendingBrokenUpstream = brokenBucket;
      if (hiddenPending !== "none") hit.hiddenPendingUpstream = hiddenPending;
    }
    entries.push({
      tool,
      file: hit.path,
      ...(access?.user != null ? { principal: access.user } : {}),
      ...(broken !== undefined ? { broken_upstream: broken } : {}),
    });
  }
  await recordReads(vaultRoot, entries);
}

// ---------------------------------------------------------------------------
// vault_search
// ---------------------------------------------------------------------------

export async function vaultSearch(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<HybridSearchResult, Error>> {
  const query = args.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    return {
      ok: false,
      error: new Error("vault_search requires a non-empty 'query' argument"),
    };
  }

  const ready = await ensureIndexReady(vaultRoot);
  if (!ready.ok) return ready;

  const dbResult = openIndexForActiveProvider(vaultRoot);
  if (!dbResult.ok) return dbResult;
  const db = dbResult.value;
  try {
    const limit = parseLimit(args.limit);
    // Over-fetch every ranked candidate so RBAC filtering happens BEFORE the
    // user-facing slice. If we sliced to `limit` first (the old behaviour),
    // restricted docs occupying the top-`limit` slots would be dropped by
    // canRead below and shrink the permitted page below `limit`, even though
    // more readable docs ranked just past the cut.
    const result = await hybridSearch(db, query, {
      weights: parseWeights(args.weights),
      limit,
      overFetch: true,
    });
    if (!result.ok) return result;

    // RBAC: drop hits in collections the role cannot read (only when an access
    // context is present), THEN slice to the user-facing limit. Filtering the
    // full candidate set first is what makes the page a full `limit` of
    // permitted results. Enrichment then runs on the surviving hits.
    const permittedRanked = access
      ? result.value.hits.filter((h) => canRead(access.role, h.collection))
      : result.value.hits;
    const ranked = permittedRanked.slice(0, limit);

    // Coverage pass: conditionally widen the ranked set with same-entity docs in
    // the seeds' date window. Quiet (returns `ranked` unchanged) when no signal
    // fires. RBAC-filter the added docs identically — a coverage pull must never
    // surface a doc the caller could not retrieve directly.
    const widened = applyCoveragePass(db, ranked, DEFAULT_COVERAGE_OPTIONS);
    const permitted = access
      ? widened.filter((h) => (h.viaCoverage ? canRead(access.role, h.collection) : true))
      : widened;

    // Foreground the current source for any hit (ranked OR coverage-added) that
    // points at a successor. Additive and lossless. Do NOT gate this on
    // hit.status === "superseded": a deprecated doc can also carry a
    // superseded_by successor (set by vault_deprecate), so we key on the pointer
    // (inside resolveCurrentSource), not the status string. The resolver no-ops
    // for hits with no successor. This is the suppression lever composing with
    // the coverage recall lever.
    //
    // Contested post-join (same pass): surface unresolved tensions inline.
    // The feud benchmark measured this shape — inline beats a dedicated tool
    // the agent must choose to call. Advisory only; never a score input.
    for (const hit of permitted) {
      const cs = resolveCurrentSource(db, hit.path, access);
      if (cs) hit.currentSource = cs;
      const ct = contestedFor(vaultRoot, db, hit.path, access);
      if (ct) {
        hit.contested = ct.contested;
        hit.contestedCount = ct.contestedCount;
      }
      // #8: structural decay flags from the materialized inbound-link graph —
      // one indexed query per hit on the same open handle, vantage-filtered.
      const sd = structuralDecay({ db, path: hit.path, status: hit.status, access });
      if (sd?.orphan) hit.orphan = true;
      if (sd?.deprecated_still_linked) hit.deprecatedStillLinked = true;
    }

    // Token-cap backstop: evict coverage-added docs (stale first, then oldest) if
    // their combined snippets exceed the budget. Never drops ranked hits.
    const capped = enforceTokenCap(permitted, DEFAULT_COVERAGE_OPTIONS);

    await annotateAndLogServedHits(vaultRoot, db, "vault_search", capped, access);

    // #3: opt-in agent-as-judge rerank pool — the top-K of the SAME
    // RBAC-filtered fused ranking the hits were sliced from (never coverage
    // additions; those are recall, not ranking). Compact judging records
    // only: no enrichment joins, per the protocol text.
    const rerankK = parseRerankCandidates(args.rerank_candidates);
    const rerank =
      rerankK > 0
        ? {
            instructions: RERANK_INSTRUCTIONS,
            candidates: permittedRanked.slice(0, rerankK).map((h, i) => ({
              rank: i + 1,
              path: h.path,
              title: h.title,
              collection: h.collection,
              status: h.status,
              score: h.score,
              bm25Score: h.bm25Score,
              vectorScore: h.vectorScore,
              snippet: h.snippet,
            })),
          }
        : undefined;

    return ok({
      ...result.value,
      count: capped.length,
      hits: capped,
      ...(rerank ? { rerank } : {}),
    });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// vault_search_related
// ---------------------------------------------------------------------------

export async function vaultSearchRelated(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<RelatedSearchResult, Error>> {
  const path = args.path;
  if (typeof path !== "string" || path.trim().length === 0) {
    return {
      ok: false,
      error: new Error("vault_search_related requires a non-empty 'path' argument"),
    };
  }

  const ready = await ensureIndexReady(vaultRoot);
  if (!ready.ok) return ready;

  const dbResult = openIndexForActiveProvider(vaultRoot);
  if (!dbResult.ok) return dbResult;
  const db = dbResult.value;
  try {
    const limit = parseLimit(args.limit);
    // Over-fetch, then RBAC-filter, then slice — same ordering as vaultSearch so
    // restricted docs in the top-`limit` slots can't shrink the permitted page.
    const result = relatedSearch(db, path, {
      weights: parseWeights(args.weights),
      limit,
      overFetch: true,
    });
    if (!result.ok) return result;
    // RBAC: drop related hits in collections the role cannot read (when an
    // access context is present), THEN slice to the user-facing limit. The slice
    // runs unconditionally because over-fetch returned the full candidate set.
    const permitted = access
      ? result.value.hits.filter((h) => canRead(access.role, h.collection))
      : result.value.hits;
    const hits = permitted.slice(0, limit);

    await annotateAndLogServedHits(vaultRoot, db, "vault_search_related", hits, access);

    return ok({ ...result.value, count: hits.length, hits });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// vault_reindex
// ---------------------------------------------------------------------------

export interface VaultReindexResult extends ReindexResult {
  vault: string;
}

export async function vaultReindex(vaultRoot: string): Promise<Result<VaultReindexResult, Error>> {
  // Coalesce with any in-flight indexing pass — e.g. the startup-time
  // background reindex from main(). An agent that calls vault_reindex should
  // not get a busy error just because the server is finishing its own
  // startup work; wait for that pass to settle, then run the requested
  // reindex (which is cheap and idempotent against a hot cache).
  if (getIndexStatus().status === "indexing") {
    await new Promise<void>((resolve) => onceIndexReady(resolve));
  }
  markIndexing();
  const result = await reindexVault(vaultRoot);
  if (!result.ok) {
    markIndexError(result.error.message);
    return result;
  }
  markIndexReady();
  return ok({ ...result.value, vault: vaultRoot });
}

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------

const weightsSchema = {
  type: "object",
  description: "Optional ranking weights. Defaults to an even bm25/vector split.",
  properties: {
    bm25: { type: "number", description: "Lexical (BM25) weight, >= 0" },
    vector: { type: "number", description: "Semantic (vector) weight, >= 0" },
  },
  additionalProperties: false,
};

export const searchTools: ToolDefinition[] = [
  {
    name: "vault_search",
    title: "Search the vault",
    annotations: { readOnlyHint: true },
    description:
      "Hybrid search across the vault: BM25 lexical ranking combined with " +
      "vector semantic similarity. Returns ranked documents with snippets. " +
      "Falls back to lexical-only ranking if embeddings are unavailable. " +
      "Hits may carry `contested`: unresolved recorded tensions involving " +
      "the document, with both claims shown (`claimSelf`/`claimOther`), " +
      "capped at 3 per hit; `contestedCount` reports the true total. " +
      "Pass rerank_candidates to also receive a `rerank` block — the top-K " +
      "of the fused ranking as compact judging records plus instructions — " +
      "and act as the reranker yourself: fusion scores measure retrieval " +
      "proximity, not answer quality, so judging the pool against the query " +
      "can surface candidates ranked past the returned hits.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query" },
        limit: {
          type: "number",
          description: "Maximum results to return (default 10, max 50)",
        },
        weights: weightsSchema,
        rerank_candidates: {
          type: "number",
          description:
            "Opt-in agent-as-judge rerank: return the top-K fused candidates " +
            "(max 30) with judging context so YOU reorder by answer quality. " +
            "Omit to skip.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultSearch(vaultRoot, args, access),
  },
  {
    name: "vault_search_related",
    title: "Find related documents",
    annotations: { readOnlyHint: true },
    description:
      "Find documents related to a given vault document. Uses that " +
      "document's own text and embeddings as the query; the document itself " +
      "is excluded from results. Path is relative to the vault root.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative path of the reference document",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default 10, max 50)",
        },
        weights: weightsSchema,
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultSearchRelated(vaultRoot, args, access),
  },
  {
    name: "vault_reindex",
    title: "Rebuild search index",
    // Not read-only — it writes the SQLite index. But it operates on a
    // rebuildable derived cache, not the markdown source of truth, so
    // destructiveHint is false.
    annotations: { destructiveHint: false, idempotentHint: true },
    description:
      "Rebuild the search index from the markdown files on disk. The index " +
      "is a derived cache; this clears and rebuilds it, re-embedding all " +
      "document chunks. Run after bulk edits made outside Daftari.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: (vaultRoot) => vaultReindex(vaultRoot),
  },
];
