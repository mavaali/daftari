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
import { ensureMountIndexFresh, reindexMount } from "../federation/mount-index.js";
import {
  federatedPathOf,
  getMountRegistry,
  type LoadedMount,
  type MountRegistry,
  parseFederatedPath,
} from "../federation/mounts.js";
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
  extractRelatedSeed,
  type HybridHit,
  type HybridSearchResult,
  type HybridWeights,
  hybridSearch,
  type RelatedSearchResult,
  type RelatedSeed,
  relatedSearch,
  relatedSearchFromSeed,
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
import { resolveValidAtSource } from "../search/valid-at-source.js";
import { getProvider } from "../search/vector.js";
import { documentCount, getDocument, type IndexDb, openIndexDb } from "../storage/index-db.js";
import { normalizeIsoDate } from "../utils/dates.js";
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

// ---------------------------------------------------------------------------
// Federation (#297, spec Decision 4): scope resolution, per-mount pipelines,
// and cross-vault RRF fusion.
// ---------------------------------------------------------------------------

interface FederationScope {
  includeLocal: boolean;
  mounts: LoadedMount[];
}

// Resolves the optional `vaults` argument against the mount registry. Absent
// ⇒ local plus every available mount; an explicit list names exactly what it
// wants ("local" and/or declared aliases) and fails loud on an unknown alias
// or an explicitly named unavailable mount.
function resolveVaultScope(
  raw: unknown,
  registry: MountRegistry | null,
  tool: string,
): Result<FederationScope, Error> {
  if (registry === null) {
    if (raw !== undefined) {
      return err(new Error(`${tool} 'vaults' requires federation to be configured`));
    }
    return ok({ includeLocal: true, mounts: [] });
  }
  if (raw === undefined) {
    return ok({
      includeLocal: true,
      mounts: [...registry.mounts.values()].filter((m) => m.state === "ok"),
    });
  }
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    !raw.every((v): v is string => typeof v === "string")
  ) {
    return err(
      new Error(`${tool} 'vaults' must be a non-empty array of mount aliases (or "local")`),
    );
  }
  const scope: FederationScope = { includeLocal: false, mounts: [] };
  const seen = new Set<string>();
  for (const name of raw) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (name === "local") {
      scope.includeLocal = true;
      continue;
    }
    const mount = registry.mounts.get(name);
    if (!mount) {
      return err(new Error(`${tool} 'vaults' names unknown mount alias "${name}"`));
    }
    if (mount.root === null) {
      return err(new Error(`mount "${name}" is unavailable — its path was not found`));
    }
    scope.mounts.push(mount);
  }
  return ok(scope);
}

// The mount's principal-resolved identity in AccessContext shape, so the
// per-mount pipeline reuses the same helpers (currentSource's restricted
// degrade, readable-collection pushdown) the canonical path uses.
function mountAccess(mount: LoadedMount, user: string | undefined): AccessContext {
  return { user: user ?? "guest", roleName: mount.roleName, role: mount.role };
}

// Rewrites every addressable path a mount hit carries into `alias:path` form
// — the round-trip property: any path a federated tool returns is directly
// usable as the path argument to any federated read tool.
function labelMountHit(hit: HybridHit, alias: string): void {
  hit.vault = alias;
  hit.path = federatedPathOf(alias, hit.path);
  if (hit.currentSource?.kind === "resolved") {
    hit.currentSource = {
      ...hit.currentSource,
      path: federatedPathOf(alias, hit.currentSource.path),
    };
  }
  if (hit.validAtSource?.kind === "resolved") {
    hit.validAtSource = {
      ...hit.validAtSource,
      path: federatedPathOf(alias, hit.validAtSource.path),
    };
  }
}

// Cross-vault fusion (spec Decision 4): RRF over the per-vault FINAL rank
// lists. Rank fusion consumes only orderings, so it is indifferent to BM25
// magnitude differences across corpora; there is no cross-provider score
// problem because one embedding provider serves the whole process. Lists
// arrive in priority order (canonical first), which is the deterministic
// tiebreak for equal RRF scores.
const RRF_K = 60;

function rrfFuse(lists: HybridHit[][], limit: number): HybridHit[] {
  const scored: { hit: HybridHit; score: number; listIdx: number; rank: number }[] = [];
  lists.forEach((hits, listIdx) => {
    hits.forEach((hit, rank) => {
      scored.push({ hit, score: 1 / (RRF_K + rank + 1), listIdx, rank });
    });
  });
  scored.sort((a, b) => b.score - a.score || a.listIdx - b.listIdx || a.rank - b.rank);
  return scored.slice(0, limit).map((s) => s.hit);
}

// One mount's search pipeline: the same hybrid ranking, RBAC filtering,
// validity pass, coverage pass, and current-source foregrounding the
// canonical vault gets — under the MOUNT's granted role and against the
// mount's own index. Deliberately absent: contested/structural annotations
// and serve logging, which read or write vault state (documents only).
async function searchMount(
  mount: LoadedMount,
  opts: {
    query: string;
    weights: HybridWeights;
    limit: number;
    validAt: string | null;
    validOnly: boolean;
    user: string | undefined;
  },
): Promise<Result<{ hits: HybridHit[]; vectorUsed: boolean }, Error>> {
  if (mount.root === null) {
    return err(new Error(`mount "${mount.alias}" is unavailable — its path was not found`));
  }
  const fresh = await ensureMountIndexFresh(mount);
  if (!fresh.ok) return fresh;
  const dbResult = openIndexForActiveProvider(mount.root);
  if (!dbResult.ok) return dbResult;
  const db = dbResult.value;
  try {
    const result = await hybridSearch(db, opts.query, {
      weights: opts.weights,
      limit: opts.limit,
      overFetch: true,
      readableCollections: readableCollections(mount.role),
    });
    if (!result.ok) return result;

    let permitted = result.value.hits.filter((h) => canRead(mount.role, h.collection));
    if (opts.validAt !== null) {
      for (const hit of permitted) {
        hit.validity = validityForPath(db, hit.path, opts.validAt);
      }
      if (opts.validOnly) {
        permitted = permitted.filter(
          (h) =>
            h.validity == null ||
            (h.validity.state !== "expired" && h.validity.state !== "not-yet"),
        );
      }
    }
    const ranked = permitted.slice(0, opts.limit);

    const widened = applyCoveragePass(db, ranked, DEFAULT_COVERAGE_OPTIONS).filter((h) =>
      h.viaCoverage ? canRead(mount.role, h.collection) : true,
    );
    const access = mountAccess(mount, opts.user);
    for (const hit of widened) {
      if (opts.validAt !== null && hit.validity === undefined) {
        hit.validity = validityForPath(db, hit.path, opts.validAt);
      }
      const cs = resolveCurrentSource(db, hit.path, access);
      if (cs) hit.currentSource = cs;
      if (opts.validAt !== null) {
        const vas = resolveValidAtSource(db, hit.path, opts.validAt, access);
        if (vas) hit.validAtSource = vas;
      }
    }
    const capped = enforceTokenCap(widened, DEFAULT_COVERAGE_OPTIONS);
    for (const hit of capped) labelMountHit(hit, mount.alias);
    return ok({ hits: capped, vectorUsed: result.value.vectorUsed });
  } finally {
    db.close();
  }
}

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

  // Federation scope (#297). No registry ⇒ the canonical-only path below,
  // byte-identical to pre-federation behavior apart from the vault labels.
  const registry = getMountRegistry();
  const scope = resolveVaultScope(args.vaults, registry, "vault_search");
  if (!scope.ok) return scope;
  const { includeLocal, mounts } = scope.value;

  let localResult: HybridSearchResult | null = null;
  if (includeLocal) {
    const local = await searchLocalVault(vaultRoot, args, query, validAt, validOnly, access);
    if (!local.ok) return local;
    localResult = local.value;
    for (const hit of localResult.hits) hit.vault = "local";
  }
  if (mounts.length === 0) {
    return localResult
      ? ok(localResult)
      : err(new Error("vault_search 'vaults' selected no vault"));
  }

  // Per-vault pipelines, then RRF over the final rank lists (Decision 4).
  const limit = parseLimit(args.limit);
  const weights = parseWeights(args.weights);
  const lists: HybridHit[][] = [];
  if (localResult) lists.push(localResult.hits);
  let vectorUsed = localResult?.vectorUsed ?? false;
  for (const mount of mounts) {
    const m = await searchMount(mount, {
      query,
      weights,
      limit,
      validAt,
      validOnly,
      user: access?.user,
    });
    if (!m.ok) return err(new Error(`mount "${mount.alias}": ${m.error.message}`));
    lists.push(m.value.hits);
    vectorUsed = vectorUsed || m.value.vectorUsed;
  }
  const fused = rrfFuse(lists, limit);

  // #3 rerank over the SAME fused cross-vault ranking the hits came from,
  // still excluding coverage additions (recall, not ranking).
  const rerankK = parseRerankCandidates(args.rerank_candidates);
  const rerank =
    rerankK > 0
      ? {
          instructions: RERANK_INSTRUCTIONS,
          candidates: fused
            .filter((h) => !h.viaCoverage)
            .slice(0, rerankK)
            .map((h, i) => ({
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
    query,
    count: fused.length,
    vectorUsed,
    weights: localResult?.weights ?? (vectorUsed ? weights : { bm25: 1, vector: 0 }),
    hits: fused,
    ...(rerank ? { rerank } : {}),
  });
}

// The canonical vault's search pipeline — the pre-federation vault_search
// body, unchanged: ranking, RBAC filter, validity pass, coverage, current-
// source foregrounding, contested/structural enrichment, serve logging, and
// the local rerank pool.
async function searchLocalVault(
  vaultRoot: string,
  args: Record<string, unknown>,
  query: string,
  validAt: string | null,
  validOnly: boolean,
  access?: AccessContext,
): Promise<Result<HybridSearchResult, Error>> {
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
      // Push the readable-collection allow-list into the vector KNN so a
      // restricted role's K budget is spent on chunks it can actually read
      // (2026-07-26 fusion spec, Decision 3). The canRead filter below stays:
      // pushdown is a recall fix, not the authorization boundary.
      readableCollections: access ? readableCollections(access.role) : undefined,
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
      if (sd?.retired_still_linked) hit.retiredStillLinked = true;
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

  const registry = getMountRegistry();
  const scope = resolveVaultScope(args.vaults, registry, "vault_search_related");
  if (!scope.ok) return scope;
  const { includeLocal, mounts } = scope.value;
  const fed = registry ? parseFederatedPath(path, registry) : null;

  // Canonical seed, canonical-only scope: the pre-federation path, unchanged
  // apart from the vault labels.
  if (fed === null && mounts.length === 0) {
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
      for (const hit of hits) hit.vault = "local";

      await annotateAndLogServedHits(vaultRoot, db, "vault_search_related", hits, access);

      return ok({ ...result.value, count: hits.length, hits });
    } finally {
      db.close();
    }
  }

  // Federated: extract the seed from its HOME vault, then rank every in-scope
  // vault's candidates against it (Decision 4). Coherent across indexes
  // because one embedding provider serves the whole process.
  const limit = parseLimit(args.limit);
  const weights = parseWeights(args.weights);

  let seed: RelatedSeed;
  if (fed !== null && registry !== null) {
    const mount = registry.mounts.get(fed.alias);
    if (!mount || mount.root === null) {
      return err(new Error(`mount "${fed.alias}" is unavailable — its path was not found`));
    }
    const fresh = await ensureMountIndexFresh(mount);
    if (!fresh.ok) return fresh;
    const homeDbResult = openIndexForActiveProvider(mount.root);
    if (!homeDbResult.ok) return homeDbResult;
    const homeDb = homeDbResult.value;
    try {
      // Seed gate under the MOUNT's granted role — a caller must not use an
      // unreadable mount doc as a query proxy.
      const doc = getDocument(homeDb, fed.relPath);
      if (!doc) {
        return err(new Error(`document not indexed: ${path} (try vault_reindex)`));
      }
      if (!canRead(mount.role, doc.collection)) {
        return err(
          new Error(
            `access denied: role '${mount.roleName}' cannot read collection '${doc.collection}'`,
          ),
        );
      }
      const extracted = extractRelatedSeed(homeDb, fed.relPath);
      if (!extracted.ok) return extracted;
      seed = extracted.value;
    } finally {
      homeDb.close();
    }
  } else {
    const ready = await ensureIndexReady(vaultRoot);
    if (!ready.ok) return ready;
    const homeDbResult = openIndexForActiveProvider(vaultRoot);
    if (!homeDbResult.ok) return homeDbResult;
    const homeDb = homeDbResult.value;
    try {
      const extracted = extractRelatedSeed(homeDb, path);
      if (!extracted.ok) return extracted;
      seed = extracted.value;
    } finally {
      homeDb.close();
    }
  }

  const lists: HybridHit[][] = [];
  let vectorUsed = false;

  if (includeLocal) {
    const ready = await ensureIndexReady(vaultRoot);
    if (!ready.ok) return ready;
    const dbResult = openIndexForActiveProvider(vaultRoot);
    if (!dbResult.ok) return dbResult;
    const db = dbResult.value;
    try {
      const ranked = relatedSearchFromSeed(db, seed, fed === null ? path : null, {
        weights,
        limit,
        overFetch: true,
        readableCollections: access ? readableCollections(access.role) : undefined,
      });
      const permitted = access
        ? ranked.hits.filter((h) => canRead(access.role, h.collection))
        : ranked.hits;
      const hits = permitted.slice(0, limit);
      for (const hit of hits) hit.vault = "local";
      await annotateAndLogServedHits(vaultRoot, db, "vault_search_related", hits, access);
      lists.push(hits);
      vectorUsed = vectorUsed || ranked.vectorUsed;
    } finally {
      db.close();
    }
  }

  for (const mount of mounts) {
    if (mount.root === null) continue;
    const fresh = await ensureMountIndexFresh(mount);
    if (!fresh.ok) return err(new Error(`mount "${mount.alias}": ${fresh.error.message}`));
    const dbResult = openIndexForActiveProvider(mount.root);
    if (!dbResult.ok) return err(new Error(`mount "${mount.alias}": ${dbResult.error.message}`));
    const db = dbResult.value;
    try {
      const ranked = relatedSearchFromSeed(
        db,
        seed,
        fed !== null && fed.alias === mount.alias ? fed.relPath : null,
        { weights, limit, overFetch: true, readableCollections: readableCollections(mount.role) },
      );
      const hits = ranked.hits.filter((h) => canRead(mount.role, h.collection)).slice(0, limit);
      for (const hit of hits) labelMountHit(hit, mount.alias);
      lists.push(hits);
      vectorUsed = vectorUsed || ranked.vectorUsed;
    } finally {
      db.close();
    }
  }

  const fused = rrfFuse(lists, limit);
  return ok({
    path,
    count: fused.length,
    vectorUsed,
    weights: vectorUsed ? weights : { bm25: 1, vector: 0 },
    hits: fused,
  });
}

// ---------------------------------------------------------------------------
// vault_reindex
// ---------------------------------------------------------------------------

export interface VaultReindexResult extends ReindexResult {
  vault: string;
}

export async function vaultReindex(
  vaultRoot: string,
  args: Record<string, unknown> = {},
): Promise<Result<VaultReindexResult, Error>> {
  // #297: `mount: <alias>` rebuilds one mount's index (under the canonical
  // .daftari/federation/<alias>/ redirect) — the manual freshness lever for
  // startup-only mounts. Named `mount`, not `vault`: the multi-vault router
  // package reserves a `vault` input property on every routed tool. The
  // default remains canonical-only, and the mount path deliberately bypasses
  // the global IndexState, which tracks the canonical index's lifecycle.
  if (args.mount !== undefined && args.mount !== "local") {
    if (typeof args.mount !== "string") {
      return err(new Error("vault_reindex 'mount' must be a mount alias string"));
    }
    const registry = getMountRegistry();
    if (!registry) {
      return err(new Error("vault_reindex 'mount' requires federation to be configured"));
    }
    const mount = registry.mounts.get(args.mount);
    if (!mount) {
      return err(new Error(`vault_reindex 'mount' names unknown mount alias "${args.mount}"`));
    }
    const rebuilt = await reindexMount(mount);
    if (!rebuilt.ok) return rebuilt;
    return ok({ ...rebuilt.value, vault: mount.alias });
  }

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
    path: {
      type: "string",
      description:
        "Vault-relative document path; for a federation mount hit, the " +
        "addressable '<alias>:<path>' form (#297).",
    },
    vault: {
      type: "string",
      description:
        'Which vault served the hit: a federation mount alias, or "local" ' +
        "for the canonical vault (#297).",
    },
    title: { type: "string" },
    collection: { type: "string" },
    status: { type: "string" },
    score: { type: "number", description: "Fused bm25/vector score; larger is better." },
    bm25Score: { type: "number", description: "Normalised lexical component." },
    vectorScore: { type: "number", description: "Normalised semantic component." },
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
    retiredStillLinked: { type: "boolean" },
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
  const snippet =
    head.length > SUMMARY_SNIPPET_MAX ? `${head.slice(0, SUMMARY_SNIPPET_MAX)}…` : head;
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
        vaults: {
          type: "array",
          items: { type: "string" },
          description:
            "Federation scope (#297): which vaults to search — mount aliases " +
            'and/or "local" for the canonical vault. Omit to search the local ' +
            "vault plus every available mount. Requires federation to be " +
            "configured.",
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
      required: ["query", "count", "vectorUsed", "weights", "hits"],
      additionalProperties: false,
    },
    summarize: (value) => {
      const result = value as HybridSearchResult;
      const n = result.hits.length;
      const mode = result.vectorUsed ? "bm25+vector" : "bm25 only";
      const header =
        n === 0
          ? `No hits for "${result.query}" (${mode}).`
          : `${n} hit${n === 1 ? "" : "s"} for "${result.query}" (${mode}).`;
      const summary = summarizeHits(header, result.hits);
      // The rerank pool and its protocol text live on structuredContent; a
      // caller reading only `content` would otherwise never learn it opted in.
      return result.rerank
        ? `${summary}\nRerank pool: ${result.rerank.candidates.length} candidate(s) — you are the reranker; see structuredContent.rerank.`
        : summary;
    },
    docLinks: (value) => hitDocLinks((value as HybridSearchResult).hits),
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
          description:
            "Vault-relative path of the reference document; with federation " +
            "configured, an '<alias>:<path>' form seeds from that mounted " +
            "vault (#297).",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default 10, max 50)",
        },
        weights: weightsSchema,
        vaults: {
          type: "array",
          items: { type: "string" },
          description:
            "Federation scope (#297): which vaults to rank candidates from — " +
            'mount aliases and/or "local". Omit for the local vault plus ' +
            "every available mount.",
        },
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
      "document chunks. Run after bulk edits made outside Daftari. With " +
      "federation configured, pass 'mount: <alias>' to rebuild one mount's " +
      "index instead — the manual freshness lever for startup-only mounts (#297).",
    inputSchema: {
      type: "object",
      properties: {
        // Named `mount`, not `vault`: the multi-vault router package reserves
        // a `vault` input property on every routed tool for its own dispatch.
        mount: {
          type: "string",
          description:
            "Federation mount alias to reindex instead of the local vault " +
            '(#297). Omit (or pass "local") for the canonical vault.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        vault: {
          type: "string",
          description:
            "Absolute path of the reindexed vault root, or the mount alias " +
            "for a federated reindex (#297).",
        },
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
    handler: (vaultRoot, args) => vaultReindex(vaultRoot, args),
  },
];
