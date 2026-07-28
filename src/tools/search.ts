// Search-path tools: vault_search, vault_search_related, vault_reindex.
//
// Like the read-path tools, each exposes a pure logic function (returns
// Result, never throws) plus an MCP ToolDefinition. The logic functions own
// the index-db lifecycle: they open the SQLite index, run the query, and close
// it. If the index is empty (first run after a fresh clone) they trigger a
// reindex first, so search works without an explicit setup step.

import { type AccessContext, canRead, readableCollections } from "../access/rbac.js";
import { currentConsumesEdges } from "../curation/consumes.js";
import {
  compiledUpstreamStaleness,
  loadCompiledStaleContext,
  splitUpstreamVisibility,
} from "../curation/edge-staleness.js";
import { recordReads } from "../curation/read-log.js";
import { structuralDecay } from "../curation/structural.js";
import { TENSION_KINDS } from "../curation/tension.js";
import { sourceReadable } from "../curation/tension-access.js";
import { bucketHiddenDownstream } from "../curation/tension-blast.js";
import { computeValidity, type ValidityReport } from "../curation/validity.js";
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
  type PassageRef,
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
import { getRerankProvider, warmRerankModel } from "../search/rerank-provider.js";
import { classifyQuery, makeDfLookup, type RouteClass, routeWeights } from "../search/router.js";
import { resolveValidAtSource } from "../search/valid-at-source.js";
import { embeddingInput, getProvider } from "../search/vector.js";
import {
  type ChunkPassage,
  documentCount,
  getChunkByPathAndHash,
  getChunkTextsByRowids,
  getDocument,
  getFirstChunk,
  type IndexDb,
  openIndexDb,
} from "../storage/index-db.js";
import { loadConfig } from "../utils/config.js";
import { normalizeIsoDate } from "../utils/dates.js";
import type { ToolDefinition } from "./read.js";
import { clip } from "./summary.js";

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

// Distinguishes an ABSENT `weights` arg (null: the caller expressed no
// preference — the router, if on, may pick) from an INVALID one (present but
// malformed — a caller who tried to control weights and failed must never
// silently fall through to the router; that would make a typo behave like an
// opt-in to router-driven ranking the caller never asked for).
function parseExplicitWeights(raw: unknown): HybridWeights | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "object") {
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
  return "invalid";
}

// vault_search_related has no user query to classify — it is never routed,
// so an absent or invalid `weights` arg both fall back to the static
// default (today's exact parseWeights behaviour, unchanged).
function staticWeightsFallback(explicit: HybridWeights | "invalid" | null): HybridWeights {
  return explicit !== null && explicit !== "invalid" ? explicit : DEFAULT_WEIGHTS;
}

// Shared numeric-arg posture: a positive finite number floors and clamps to
// `max`; anything else silently takes `fallback`.
function clampPositiveInt(raw: unknown, max: number, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.floor(raw), max);
  }
  return fallback;
}

function parseLimit(raw: unknown): number {
  return clampPositiveInt(raw, 50, 10);
}

// #3: rerank pool size. 0 = feature off (the default — absent or invalid
// mirrors parseLimit's silent-fallback posture). Capped: the pool is token
// cost in the caller's context window, and past ~30 snippets judgment
// quality decays faster than recall improves.
const RERANK_CANDIDATES_MAX = 30;
function parseRerankCandidates(raw: unknown): number {
  return clampPositiveInt(raw, RERANK_CANDIDATES_MAX, 0);
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

// ---------------------------------------------------------------------------
// Part B: local cross-encoder reranker (spec 2026-07-26-contextual-chunking-
// reranker-design.md Decisions 5-8). Unrelated to the #3 agent-as-judge pool
// above (RERANK_CANDIDATES_MAX / RERANK_INSTRUCTIONS) despite the shared
// vocabulary — that pool hands compact judging records to the CALLING agent;
// this stage runs a local ONNX model, INSIDE the server, and reorders the
// hits themselves before they are ever returned.
// ---------------------------------------------------------------------------

// How many of the fused, RBAC-and-validity-filtered hits get scored by the
// cross-encoder. A fixed pool bounds worst-case latency regardless of vault
// size — the reranker cannot move recall by construction (it only reorders
// within the pool), so widening it trades latency for no recall gain past
// what the fused order already surfaced.
const RERANK_POOL = 50;

// Wall-clock budget for one rerank call (spec C5). The in-flight ONNX
// inference is not cancellable, but the search must never hang on it: on
// timeout the fused order stands and `rerankUsed` stays false. One stderr
// warning per PROCESS (not per call) — a slow model is an operational fact
// worth one log line, not a warning storm on every subsequent search.
const RERANK_TIMEOUT_MS = 1500;

let rerankDegradeWarned = false;

// Races `promise` against a timeout that resolves to Result.err — never
// rejects, so the caller's `.ok` branch handles both a real provider error
// and a timeout identically (fused order stands either way).
async function withTimeout<T>(
  promise: Promise<Result<T, Error>>,
  ms: number,
): Promise<Result<T, Error>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Result<T, Error>>((resolve) => {
    timer = setTimeout(() => resolve(err(new Error(`rerank timed out after ${ms}ms`))), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Resolves passage TEXT for exactly the top RERANK_POOL permitted hits (C2) —
// never for the whole over-fetched candidate set. Lexical refs are batch-
// resolved in one call via getChunkTextsByRowids; vector and `first` refs are
// resolved per-hit (bounded at RERANK_POOL, so this is cheap). The passage
// string is embeddingInput(chunk) — the same context+text concatenation the
// embedding pipeline hashed, so the cross-encoder sees the exact retrieval
// unit that earned the hit its rank (spec §4.2). Missing refs, or a resolved
// ref whose chunk row is somehow gone, fall back to getFirstChunk and then,
// only as a last-resort defensive guard (an index inconsistency, not a
// passage strategy — chunkDocument guarantees >=1 chunk per indexed doc), to
// the hit's own served snippet, logging once so the inconsistency is visible.
function resolvePassages(
  db: IndexDb,
  pool: HybridHit[],
  passageRefs: Record<string, PassageRef> | undefined,
): string[] {
  const refs = passageRefs ?? {};
  const lexicalRowids = pool
    .map((h) => refs[h.path])
    .filter((r): r is Extract<PassageRef, { kind: "lexical" }> => r?.kind === "lexical")
    .map((r) => r.rowid);
  const lexicalTexts = getChunkTextsByRowids(db, lexicalRowids);

  return pool.map((h) => {
    const ref = refs[h.path];
    let passage: ChunkPassage | null = null;
    if (ref?.kind === "lexical") passage = lexicalTexts.get(ref.rowid) ?? null;
    else if (ref?.kind === "vector") passage = getChunkByPathAndHash(db, h.path, ref.contentHash);
    if (!passage) passage = getFirstChunk(db, h.path);
    if (!passage) {
      process.stderr.write(
        `daftari: warning: no chunk row found for reranked hit ${h.path} — index inconsistency, ` +
          "falling back to the served snippet\n",
      );
      return h.snippet;
    }
    return embeddingInput(passage);
  });
}

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

// Evaluates one hit's interval from the index. Returns null when the document
// authors no interval (valid-time-unknown) or is missing from the index —
// both mean "nothing to say", never "valid".
function validityForPath(db: IndexDb, path: string, at: string): ValidityReport | null {
  const doc = getDocument(db, path);
  if (!doc) return null;
  return computeValidity({ valid_from: doc.validFrom, valid_until: doc.validUntil }, at);
}

// vault_search's result shape: HybridSearchResult plus the optional `routed`
// diagnostic the tool handler attaches when (and only when) the query router
// chose the weights (spec 2026-07-26 fusion overhaul, Decision 2).
export interface VaultSearchResult extends HybridSearchResult {
  routed?: { class: RouteClass; signals: string[] };
}

export async function vaultSearch(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<VaultSearchResult, Error>> {
  const query = args.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    return {
      ok: false,
      error: new Error("vault_search requires a non-empty 'query' argument"),
    };
  }

  // A malformed valid_at is a caller bug, not something to paper over: a
  // silently-ignored date would return today's answers to a question about
  // the past, which is exactly the confusion this axis exists to remove.
  let validAt: string | null = null;
  if (args.valid_at !== undefined && args.valid_at !== null) {
    if (typeof args.valid_at !== "string") {
      return { ok: false, error: new Error("vault_search 'valid_at' must be a YYYY-MM-DD string") };
    }
    const normalized = normalizeIsoDate(args.valid_at);
    if (normalized === null) {
      return {
        ok: false,
        error: new Error(
          `vault_search 'valid_at' must be a YYYY-MM-DD date, got "${args.valid_at}"`,
        ),
      };
    }
    validAt = normalized;
  }
  const validOnly = args.valid_only === true;
  if (validOnly && validAt === null) {
    return {
      ok: false,
      error: new Error(
        "vault_search 'valid_only' requires 'valid_at' — there is no date to filter against",
      ),
    };
  }

  const ready = await ensureIndexReady(vaultRoot);
  if (!ready.ok) return ready;

  const dbResult = openIndexForActiveProvider(vaultRoot);
  if (!dbResult.ok) return dbResult;
  const db = dbResult.value;
  try {
    const limit = parseLimit(args.limit);

    // Weight resolution precedence (spec 2026-07-26 fusion overhaul,
    // Decision 2): an explicit VALID `weights` arg always wins. An explicit
    // INVALID `weights` arg gets the static default — a caller who expressed
    // intent to control weights and got the shape wrong must never silently
    // fall through to router-driven ranking. Only a genuinely ABSENT
    // `weights` arg considers the router, and only when `search.routing` is
    // on; a config LOAD failure degrades to the static default rather than
    // failing the search. `routed` stays undefined unless the router
    // actually chose the weights — it is absent for explicit weights,
    // routing-off, and config-load degrade alike, so its presence
    // distinguishes "the router picked lexical-only" from "embeddings
    // degraded" even though both can report vectorUsed: false.
    const explicitWeights = parseExplicitWeights(args.weights);
    const cfg = loadConfig(vaultRoot);
    const routingOn = cfg.ok && cfg.value.search.routing;
    let routed: { class: RouteClass; signals: string[] } | undefined;
    let weights: HybridWeights;
    if (explicitWeights !== null && explicitWeights !== "invalid") {
      weights = explicitWeights;
    } else if (explicitWeights === "invalid") {
      weights = DEFAULT_WEIGHTS;
    } else if (routingOn) {
      const classified = classifyQuery(query, {
        df: makeDfLookup(db),
        docCount: documentCount(db),
      });
      routed = classified;
      weights = routeWeights(classified.class);
    } else {
      weights = DEFAULT_WEIGHTS;
    }

    // Part B: resolve the reranker ONCE, before hybridSearch, so ref capture
    // (cheap) can be requested only when a reranker is actually configured —
    // capturing refs for a "none" search would be wasted work (C2's "skip ref
    // capture" revision).
    const reranker = getRerankProvider();

    // Over-fetch every ranked candidate so RBAC filtering happens BEFORE the
    // user-facing slice. If we sliced to `limit` first (the old behaviour),
    // restricted docs occupying the top-`limit` slots would be dropped by
    // canRead below and shrink the permitted page below `limit`, even though
    // more readable docs ranked just past the cut.
    const result = await hybridSearch(db, query, {
      weights,
      limit,
      overFetch: true,
      // Push the readable-collection allow-list into the vector KNN so a
      // restricted role's K budget is spent on chunks it can actually read
      // (2026-07-26 fusion spec, Decision 3). The canRead filter below stays:
      // pushdown is a recall fix, not the authorization boundary.
      readableCollections: access ? readableCollections(access.role) : undefined,
      capturePassageRefs: reranker !== null,
    });
    if (!result.ok) return result;

    // RBAC: drop hits in collections the role cannot read (only when an access
    // context is present), THEN slice to the user-facing limit. Filtering the
    // full candidate set first is what makes the page a full `limit` of
    // permitted results. Enrichment then runs on the surviving hits.
    const permittedRankedAll = access
      ? result.value.hits.filter((h) => canRead(access.role, h.collection))
      : result.value.hits;

    // Validity pass — annotate, then optionally filter, BOTH BEFORE the slice.
    // This is the same reasoning as the RBAC filter above: dropping expired
    // hits after slicing would shrink the page below `limit` whenever expired
    // docs occupy the top slots, and the caller would read the shortfall as a
    // thin result set rather than as filtering. Cheap — two nullable columns
    // already on IndexedDocument, no extra query.
    //
    // Runs only when `valid_at` is supplied: zero cost and zero output change
    // for every existing caller.
    let permittedRanked = permittedRankedAll;
    if (validAt !== null) {
      for (const hit of permittedRanked) {
        hit.validity = validityForPath(db, hit.path, validAt);
      }
      if (validOnly) {
        // `unknown` hits are KEPT. Absence of an authored interval is not
        // evidence that the claim was false then — dropping them would delete
        // every pre-adoption document from its own vault's results.
        permittedRanked = permittedRanked.filter(
          (h) =>
            h.validity == null ||
            (h.validity.state !== "expired" && h.validity.state !== "not-yet"),
        );
      }
    }

    // Part B rerank stage (spec Decision 7): between the RBAC/validity filter
    // and the slice. `permittedRanked` is the RBAC-and-validity-filtered fused
    // order; reranking it before the slice lets a fused-#12 hit with the top
    // rerank score land #1 in a limit-10 page. Coverage/current-source/
    // contested/structural and the token cap all run AFTER, over the
    // reranked page, unchanged — they are additive recall levers, not ranking
    // levers, and reranking after them would let a relevance model evict
    // recall insurance.
    let rerankUsed = false;
    let finalRanked = permittedRanked;
    if (reranker && !reranker.isReady()) {
      // Never block a tool call on a cold model load (C5): fire the warm in
      // the background and serve the fused order for THIS search.
      void warmRerankModel();
    }
    if (reranker?.isReady()) {
      const pool = permittedRanked.slice(0, RERANK_POOL);
      if (pool.length > 0) {
        const passages = resolvePassages(db, pool, result.value.passageRefs);
        const scored = await withTimeout(reranker.rerank(query, passages), RERANK_TIMEOUT_MS);
        if (scored.ok) {
          const order = scored.value
            .map((s, i) => ({ s, i }))
            .sort((a, b) => b.s - a.s)
            .map(({ i }) => pool[i])
            .filter((h): h is HybridHit => h !== undefined);
          finalRanked = [...order, ...permittedRanked.slice(RERANK_POOL)];
          rerankUsed = true;
        } else if (!rerankDegradeWarned) {
          // Fires for BOTH a provider Result.err and a timeout — either way
          // the fused order stands and rerankUsed stays false (Decision 8 +
          // C5). One line per process, not per call.
          rerankDegradeWarned = true;
          process.stderr.write(
            `daftari: warning: rerank degraded to fused order: ${scored.error.message}\n`,
          );
        }
      }
    }

    const ranked = finalRanked.slice(0, limit);

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
    // Coverage-added hits are annotated here rather than in the pass above,
    // and are deliberately NOT subject to valid_only: coverage is a recall
    // lever answering a different question, and silently filtering its
    // additions would make the widening non-deterministic.
    if (validAt !== null) {
      for (const hit of permitted) {
        if (hit.validity === undefined) hit.validity = validityForPath(db, hit.path, validAt);
      }
    }

    for (const hit of permitted) {
      const cs = resolveCurrentSource(db, hit.path, access);
      if (cs) hit.currentSource = cs;
      // Foreground the chain member covering `valid_at` when this hit's own
      // interval does not. No-ops when the hit covers the date itself.
      if (validAt !== null) {
        const vas = resolveValidAtSource(db, hit.path, validAt, access);
        if (vas) hit.validAtSource = vas;
      }
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

    // #3: opt-in agent-as-judge rerank pool — the top-K of the SAME fused
    // ranking the hits were sliced from (never coverage additions; those are
    // recall, not ranking). Drawn from `finalRanked` (spec Decision 7): when
    // Part B's cross-encoder is on, the agent judges the ALREADY-reranked
    // pool, not the pre-rerank fused order. Compact judging records only: no
    // enrichment joins, per the protocol text.
    const rerankK = parseRerankCandidates(args.rerank_candidates);
    const rerank =
      rerankK > 0
        ? {
            instructions: RERANK_INSTRUCTIONS,
            candidates: finalRanked.slice(0, rerankK).map((h, i) => ({
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

    // passageRefs is internal transport (Part B) — never serialized. The
    // outputSchema declares additionalProperties: false, and it would fail
    // client-side validation anyway; strip it explicitly rather than rely on
    // that alone.
    const { passageRefs: _passageRefs, ...resultRest } = result.value;
    return ok({
      ...resultRest,
      count: capped.length,
      hits: capped,
      rerankUsed,
      ...(routed ? { routed } : {}),
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
      weights: staticWeightsFallback(parseExplicitWeights(args.weights)),
      limit,
      overFetch: true,
      readableCollections: access ? readableCollections(access.role) : undefined,
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

// ---------------------------------------------------------------------------
// Output schemas (spec 2026-07-26, Decision 3)
//
// JSON Schema 2020-12 for each handler's ok-value. These describe what the
// handlers ALREADY return — HybridSearchResult / RelatedSearchResult
// (src/search/hybrid.ts) and VaultReindexResult — so a client can validate
// before parsing instead of guessing at the shape of `structuredContent`.
// ---------------------------------------------------------------------------

// Weights as they come back on a RESULT: both halves always present. Distinct
// from the input `weightsSchema` above, where both are optional — the ranker
// rewrites them to {bm25: 1, vector: 0} whenever the vector half is unused.
const weightsResultSchema = {
  type: "object",
  properties: {
    bm25: { type: "number" },
    vector: { type: "number" },
  },
  required: ["bm25", "vector"],
  additionalProperties: false,
};

// DecayState (src/curation/decay.ts). Null when the document is healthy.
const decaySchema = {
  type: ["object", "null"],
  description: "Decay verdict for the document, or null when nothing is wrong.",
  properties: {
    level: { type: "string", enum: ["deprecated", "warn", "aging"] },
    reasons: { type: "array", items: { type: "string" } },
    banner: {
      type: ["string", "null"],
      description: "Null for `aging` (scarcity rule); text for warn/deprecated.",
    },
  },
  required: ["level", "reasons", "banner"],
  additionalProperties: false,
};

// CurrentSource (src/search/current-source.ts) — a closed union discriminated
// on `kind`. Only `resolved` carries a path: an unreadable hop degrades to the
// path-free `restricted` marker rather than naming the successor.
const currentSourceSchema = {
  description:
    "Terminal current source for a superseded document, or the reason the " +
    "chain could not be followed to one.",
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "resolved" },
        path: { type: "string", description: "Vault-relative path of the current source." },
        title: { type: "string" },
        snippet: { type: "string", description: "Leading preview of the successor's body." },
        hops: { type: "integer", minimum: 1 },
      },
      required: ["kind", "path", "title", "snippet", "hops"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "A hop in the chain is unreadable; no path is disclosed.",
      properties: { kind: { const: "restricted" } },
      required: ["kind"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "dangling" },
        brokenAt: { type: "string", description: "Path whose superseded_by points at nothing." },
      },
      required: ["kind", "brokenAt"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "cycle" } },
      required: ["kind"],
      additionalProperties: false,
    },
  ],
};

// ContestedTension (src/search/contested.ts). `id` is absent only on legacy
// log entries.
const contestedTensionSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: [...TENSION_KINDS] },
    counterpart: { type: "string", description: "Vault-relative path of the other side." },
    claimSelf: { type: "string" },
    claimOther: { type: "string" },
    loggedAt: { type: "string", description: "Entry date, YYYY-MM-DD." },
  },
  required: ["kind", "counterpart", "claimSelf", "claimOther", "loggedAt"],
  additionalProperties: false,
};

// HybridHit. Everything past `decay` is enrichment attached by the tool
// handler, not the ranker, and every enrichment field is absent when it has
// nothing to say — absent is the "healthy / none" reading throughout.
const hybridHitSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Vault-relative document path." },
    title: { type: "string" },
    collection: { type: "string" },
    status: { type: "string" },
    score: { type: "number", description: "Fused bm25/vector score; larger is better." },
    bm25Score: { type: "number", description: "Lexical component of the fused score." },
    vectorScore: { type: "number", description: "Semantic component of the fused score." },
    snippet: { type: "string" },
    decay: decaySchema,
    currentSource: currentSourceSchema,
    contested: {
      type: "array",
      description: "Unresolved tensions involving this document, capped at 3.",
      items: contestedTensionSchema,
    },
    contestedCount: {
      type: "integer",
      description: "True total of visible tensions; may exceed the capped `contested` list.",
    },
    pendingBrokenUpstream: {
      type: "string",
      enum: ["some", "many"],
      description:
        "Coarse bucket of pending-broken compiled upstream edges the caller can read. " +
        "Absent = none. Never an exact count.",
    },
    hiddenPendingUpstream: {
      type: "string",
      enum: ["some", "many"],
      description:
        "Coarse bucket of pending changes on upstream edges the caller cannot read; " +
        "severity is withheld. Absent = none.",
    },
    orphan: { type: "boolean", description: "No inbound links from the caller's vantage." },
    deprecatedStillLinked: { type: "boolean" },
    viaCoverage: {
      type: "boolean",
      description: "True when the coverage pass added this doc rather than the ranker.",
    },
    coverageReason: { type: "string", enum: ["edge", "entity-window"] },
  },
  required: [
    "path",
    "title",
    "collection",
    "status",
    "score",
    "bm25Score",
    "vectorScore",
    "snippet",
    "decay",
  ],
  additionalProperties: false,
};

// RerankCandidate — deliberately WITHOUT the enrichment joins the served hits
// carry; the pool exists to be judged against the query.
const rerankCandidateSchema = {
  type: "object",
  properties: {
    rank: { type: "integer", minimum: 1, description: "1-based position in the fused ranking." },
    path: { type: "string" },
    title: { type: "string" },
    collection: { type: "string" },
    status: { type: "string" },
    score: { type: "number" },
    bm25Score: { type: "number" },
    vectorScore: { type: "number" },
    snippet: { type: "string" },
  },
  required: [
    "rank",
    "path",
    "title",
    "collection",
    "status",
    "score",
    "bm25Score",
    "vectorScore",
    "snippet",
  ],
  additionalProperties: false,
};

const flaggedDocumentSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    reason: { type: "string" },
  },
  required: ["path", "reason"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Compact `content` summaries + resource links (spec 2026-07-26, Decision 3)
//
// The full typed value ships on `structuredContent`; this channel is plain
// text meant to be READ by the model, never re-parsed as JSON. Search is the
// worst token offender in the pre-Decision-3 shape (full chunk bodies per
// hit, serialized twice), so the per-hit line carries identity + score +
// enough snippet to judge relevance, and nothing else.
// ---------------------------------------------------------------------------

// Snippet budget per summary line. Hit snippets run to ~280 chars; a line the
// model has to scan past defeats the point of the compact channel, and the
// full snippet is one field away on structuredContent.
const SUMMARY_SNIPPET_MAX = 160;

function summaryLine(rank: number, hit: HybridHit): string {
  // Snippets arrive whitespace-collapsed, so this is normally the whole
  // snippet; the split keeps the line single-line regardless.
  const head = (hit.snippet.split("\n", 1)[0] ?? "").trim();
  const snippet = clip(head, SUMMARY_SNIPPET_MAX);
  const tail = snippet.length > 0 ? ` — ${snippet}` : "";
  return `${rank}. ${hit.path} (${hit.score.toFixed(3)})${tail}`;
}

// A single trailing note for the annotations the per-hit lines omit, pointing
// at structuredContent for the detail. Null when there is nothing to say.
function annotationNote(hits: HybridHit[]): string | null {
  const parts: string[] = [];
  const coverage = hits.filter((h) => h.viaCoverage).length;
  if (coverage > 0) parts.push(`${coverage} added by the coverage pass`);
  const sourced = hits.filter((h) => h.currentSource !== undefined).length;
  if (sourced > 0) parts.push(`${sourced} superseded, current source attached`);
  return parts.length > 0 ? `(${parts.join("; ")} — see structuredContent)` : null;
}

function summarizeHits(header: string, hits: HybridHit[]): string {
  const lines = [header, ...hits.map((hit, i) => summaryLine(i + 1, hit))];
  const note = annotationNote(hits);
  if (note) lines.push(note);
  return lines.join("\n");
}

// Hit paths in rank order, plus the path of any RESOLVED current source — a
// `restricted` one carries no path by construction, so there is none to link
// and none to leak. Every path here survived the handler's canRead filter, so
// the emitted links are readable by construction.
function hitDocLinks(hits: HybridHit[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  const push = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };
  for (const hit of hits) {
    push(hit.path);
    if (hit.currentSource?.kind === "resolved") push(hit.currentSource.path);
  }
  return paths;
}

function summarizeReindex(value: unknown): string {
  const r = value as VaultReindexResult;
  const warnings = r.skipped.length + r.invalidFrontmatter.length;
  const lines = [
    `Reindexed ${r.vault}: ${r.documentCount} doc(s), ${r.chunkCount} chunk(s), ` +
      `vectors ${r.vectorEnabled ? "on" : "off"} — ${warnings} warning(s)`,
  ];
  const top = [...r.skipped, ...r.invalidFrontmatter].slice(0, 5);
  for (const f of top) lines.push(`  ${f.path} — ${f.reason}`);
  return lines.join("\n");
}

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
      "can surface candidates ranked past the returned hits. When the " +
      "vault's `search.routing` config is on and no explicit `weights` was " +
      "passed, a `routed` field reports the class the query router picked " +
      "and which signals fired — present only when the router chose the " +
      "weights, distinguishing a routed lexical-only result from one where " +
      "embeddings degraded. When `rerank.provider` is configured, hits are " +
      "additionally reordered by a local cross-encoder before slicing; " +
      "`rerankUsed` reports whether that actually happened (false covers " +
      "provider none, a cold model, an inference error, and a timeout alike).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query" },
        limit: {
          type: "number",
          description: "Maximum results to return (default 10, max 50)",
        },
        weights: weightsSchema,
        valid_at: {
          type: "string",
          description:
            "Bi-temporal query date (YYYY-MM-DD): annotate each hit with " +
            "whether its claim was true IN THE WORLD on that date, and " +
            "foreground the chain member that covers it when this one does " +
            "not. This asks 'what was true then', which is different from " +
            "'what did we write then' — use it for questions like 'what did " +
            "Plan Pro cost in February'. Omit for present-day search.",
        },
        valid_only: {
          type: "boolean",
          description:
            "With valid_at, drop hits whose claim had not started or had " +
            "already ended on that date. Documents that author no interval " +
            "are KEPT: the vault not knowing when a fact held is not evidence " +
            "the fact was false. Requires valid_at. Default false.",
        },
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
    outputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The query as issued." },
        count: {
          type: "integer",
          description: "Number of entries in `hits`, coverage additions included.",
        },
        vectorUsed: {
          type: "boolean",
          description: "False when the search degraded to lexical-only ranking.",
        },
        weights: weightsResultSchema,
        hits: { type: "array", items: hybridHitSchema },
        rerankUsed: {
          type: "boolean",
          description:
            "True iff the local cross-encoder reranker (rerank.provider config) actually " +
            "reordered the pool. False covers every degrade path uniformly: provider " +
            "'none', not-warm (a background warm was fired for next time), inference " +
            "error, timeout, and an empty pool.",
        },
        routed: {
          type: "object",
          description:
            "Present only when the query router chose the weights (search.routing " +
            "on, no explicit `weights` arg). Absent for explicit weights, " +
            "routing-off, and embedding-degrade alike.",
          properties: {
            class: { type: "string", enum: ["extreme-lexical", "lexical", "balanced"] },
            signals: {
              type: "array",
              description: "Every signal that fired, not just the ones that decided `class`.",
              items: { type: "string" },
            },
          },
          required: ["class", "signals"],
          additionalProperties: false,
        },
        rerank: {
          type: "object",
          description: "Present only when rerank_candidates was passed.",
          properties: {
            instructions: { type: "string" },
            candidates: { type: "array", items: rerankCandidateSchema },
          },
          required: ["instructions", "candidates"],
          additionalProperties: false,
        },
      },
      required: ["query", "count", "vectorUsed", "weights", "hits", "rerankUsed"],
      additionalProperties: false,
    },
    summarize: (value) => {
      const result = value as VaultSearchResult;
      const n = result.hits.length;
      const mode = result.vectorUsed ? "bm25+vector" : "bm25 only";
      const header =
        n === 0
          ? `No hits for "${result.query}" (${mode}).`
          : `${n} hit${n === 1 ? "" : "s"} for "${result.query}" (${mode}).`;
      let summary = summarizeHits(header, result.hits);
      if (result.routed) {
        summary += `\nRouted: ${result.routed.class}${
          result.routed.signals.length > 0 ? ` (${result.routed.signals.join(", ")})` : ""
        }`;
      }
      if (result.rerankUsed) summary += "\nReranked: local cross-encoder reordered this page.";
      // The rerank pool and its protocol text live on structuredContent; a
      // caller reading only `content` would otherwise never learn it opted in.
      return result.rerank
        ? `${summary}\nRerank pool: ${result.rerank.candidates.length} candidate(s) — you are the reranker; see structuredContent.rerank.`
        : summary;
    },
    docLinks: (value) => hitDocLinks((value as VaultSearchResult).hits),
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
    outputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The reference document, excluded from `hits`." },
        count: { type: "integer", description: "Number of entries in `hits`." },
        vectorUsed: {
          type: "boolean",
          description: "False when the search degraded to lexical-only ranking.",
        },
        weights: weightsResultSchema,
        hits: { type: "array", items: hybridHitSchema },
      },
      required: ["path", "count", "vectorUsed", "weights", "hits"],
      additionalProperties: false,
    },
    summarize: (value) => {
      const result = value as RelatedSearchResult;
      const n = result.hits.length;
      const mode = result.vectorUsed ? "bm25+vector" : "bm25 only";
      const header =
        n === 0
          ? `No documents related to ${result.path} (${mode}).`
          : `${n} document${n === 1 ? "" : "s"} related to ${result.path} (${mode}).`;
      return summarizeHits(header, result.hits);
    },
    docLinks: (value) => hitDocLinks((value as RelatedSearchResult).hits),
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
    outputSchema: {
      type: "object",
      properties: {
        vault: { type: "string", description: "Absolute path of the reindexed vault root." },
        documentCount: { type: "integer" },
        chunkCount: { type: "integer" },
        vectorEnabled: { type: "boolean" },
        skipped: {
          type: "array",
          description: "Files not indexed at all: unreadable, or malformed YAML frontmatter.",
          items: flaggedDocumentSchema,
        },
        invalidFrontmatter: {
          type: "array",
          description:
            "Files indexed but whose frontmatter violates the schema; the offending fields " +
            "were coerced to defaults for the index row. vault_lint is the repair path.",
          items: flaggedDocumentSchema,
        },
        indexedAt: { type: "string", description: "ISO-8601 timestamp." },
        embeddedCount: { type: "integer", description: "Chunks that needed a fresh embedding." },
        cacheHits: { type: "integer" },
        orphansRemoved: { type: "integer" },
      },
      required: [
        "vault",
        "documentCount",
        "chunkCount",
        "vectorEnabled",
        "skipped",
        "invalidFrontmatter",
        "indexedAt",
        "embeddedCount",
        "cacheHits",
        "orphansRemoved",
      ],
      additionalProperties: false,
    },
    summarize: summarizeReindex,
    handler: (vaultRoot) => vaultReindex(vaultRoot),
  },
];
