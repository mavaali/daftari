// src/distill/state.ts
//
// Claim-level idempotency for the distill pipeline (U5, R4).
//
// .daftari/distill-state.json — per source-id: the content hash of the source
// at last emit, plus a claim_key -> landed_path map of claims whose proposals
// have LANDED (been ratified). Mirrors src/consolidate/state.ts: git-ignored,
// ephemeral, absent-or-corrupt ⇒ the empty default.
//
// Two clocks, deliberately different (the birthProcessed lesson — mark
// processed only after the durable event):
//
//   - content_hash advances after a COMPLETE emit. Staging is durable (the
//     proposals sit in the staged-actions jsonl), so an incomplete batch also
//     records its successful claim keys under pending_content_hash. A retry
//     emits only the failed remainder; a completed unchanged re-run is a free
//     no-op.
//   - claims[claim_key] advances only at LAND time (ratify), via
//     recordLandedClaim. A staged proposal is not landed; only a ratified one
//     is. The batch-ratify path (U9) is the intended caller.
//
// The upsert join (pure, no I/O):
//   - exact claim_key match in the landed map        ⇒ skip (already landed,
//     unchanged — the key embeds a hash of the statement, so same key means
//     same statement).
//   - anchor+slug prefix match, different hash8      ⇒ update-in-place: stage
//     a write to the SAME landed path. (F3: a `supersede` is reserved for a
//     meaning flip; detecting one needs an LLM judgment U5 doesn't have, so
//     every match+changed claim is an in-place update. Documented decision.)
//   - no match                                       ⇒ new write at a derived
//     path.
//   - an ambiguous prefix (two landed claims share it) is treated as no-match:
//     conservative — a duplicate proposal is visible and ratifiable; a wrong
//     in-place overwrite is not.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";
import { sha256Hex } from "../utils/hash.js";
import type { ExtractedClaim } from "./extract.js";
import { type OverlapSearchFn, type ProposeOutcome, proposeAllClaims } from "./propose.js";

// ---------------------------------------------------------------------------
// State shape + file I/O (mirrors src/consolidate/state.ts)
// ---------------------------------------------------------------------------

export interface DistillSourceState {
  /** Hash of the normalized source content at last emit. */
  content_hash: string;
  /** claim_key -> landed vault-relative path, recorded at ratify time only. */
  claims: Record<string, string>;
  /** Content hash for an incomplete emit whose successful claims must not be retried. */
  pending_content_hash?: string;
  /** Claims durably staged during the incomplete emit for pending_content_hash. */
  emitted_claim_keys?: string[];
  /** Exact failed remainder from an incomplete emit; authoritative on retry. */
  pending_claims?: ExtractedClaim[];
  /**
   * Per-scope emit hashes (83b1). A scoped pass (e.g. `--sender assistant`)
   * distills a different slice of the same file, so it keeps its own hash here
   * instead of sharing content_hash — otherwise the second sender's pass
   * matches the first's hash and no-ops. The landed `claims` map stays shared.
   */
  scope_hashes?: Record<string, string>;
  /**
   * Anchors of chunks whose extraction failed in a run that still landed
   * other chunks' claims (kphd). content_hash advanced past them, so the next
   * run over the unchanged source re-extracts only these. Absent ⇒ [].
   */
  failed_chunk_anchors?: string[];
  /** Per-scope variant of failed_chunk_anchors, keyed like scope_hashes. */
  scope_failed_chunk_anchors?: Record<string, string[]>;
}

export interface DistillState {
  /** Per stable source-id (the identity of the input, never a run-id). */
  sources: Record<string, DistillSourceState>;
}

function emptyState(): DistillState {
  return { sources: {} };
}

export function distillStatePath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "distill-state.json");
}

/**
 * Same sha256-sliced shape as consolidate's docContentHash.
 *
 * Line endings are normalized (CRLF and bare CR → LF) before hashing so that
 * the same logical file produces the same hash regardless of OS line endings.
 * The "normalized" comment in `content_hash`'s field declaration is therefore
 * accurate: a Windows checkout and a macOS checkout of the same file hash
 * identically and do not trigger a redundant re-distill.
 */
export function sourceContentHash(content: string): string {
  // Normalize: \r\n → \n, then any remaining \r → \n.
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return sha256Hex(normalized).slice(0, 16);
}

// Absent OR corrupt ⇒ the empty default. The state is ephemeral: losing it
// costs one redundant re-distill (surfaced as queue conflicts), never data.
export function readDistillState(vaultRoot: string): DistillState {
  const p = distillStatePath(vaultRoot);
  if (!existsSync(p)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<DistillState>;
    return { sources: raw.sources ?? {} };
  } catch {
    return emptyState();
  }
}

// Result-not-throw (house style): a failed state write is a recoverable
// degrade — the next run re-joins against stale state and the queue's conflict
// check catches any duplicates loudly. Partial-emit state uses the same write
// path, so a write failure is surfaced rather than hidden.
export function writeDistillState(vaultRoot: string, state: DistillState): Result<void, Error> {
  if (typeof vaultRoot !== "string" || vaultRoot.trim().length === 0) {
    return err(new Error("writeDistillState requires a non-empty vaultRoot"));
  }
  try {
    const p = distillStatePath(vaultRoot);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`);
    return ok(undefined);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot write distill state: ${reason}`));
  }
}

/**
 * Record that a claim's proposal has LANDED (ratified) at `landedPath`.
 * The mark-after-land hook: called by the ratify path, never at emit time.
 * An update-in-place lands at a path an older claim_key already maps to —
 * that older entry is removed so the map keeps one live key per path.
 */
export function recordLandedClaim(
  vaultRoot: string,
  sourceId: string,
  claimKey: string,
  landedPath: string,
): Result<void, Error> {
  const state = readDistillState(vaultRoot);
  const src = state.sources[sourceId] ?? { content_hash: "", claims: {} };
  for (const [key, path] of Object.entries(src.claims)) {
    if (path === landedPath && key !== claimKey) delete src.claims[key];
  }
  src.claims[claimKey] = landedPath;
  state.sources[sourceId] = src;
  return writeDistillState(vaultRoot, state);
}

// ---------------------------------------------------------------------------
// The pure join
// ---------------------------------------------------------------------------

export type ClaimAction =
  | { kind: "skip"; claim: ExtractedClaim; landedPath: string }
  | { kind: "update"; claim: ExtractedClaim; landedPath: string }
  | { kind: "new"; claim: ExtractedClaim };

// `<anchor>:<slug>-<hash8>` ⇒ `<anchor>:<slug>` — the claim's stable identity
// across statement edits. A key that doesn't carry the 8-char suffix is its
// own prefix (no partial matching for malformed keys).
function claimKeyPrefix(claimKey: string): string {
  const lastDash = claimKey.lastIndexOf("-");
  if (lastDash !== -1 && claimKey.length - lastDash - 1 === 8) {
    return claimKey.slice(0, lastDash);
  }
  return claimKey;
}

/** Join new claims against the landed map. Pure — no I/O, no LLM. */
export function joinClaims(
  prior: DistillSourceState | undefined,
  claims: ExtractedClaim[],
): ClaimAction[] {
  const landed = prior?.claims ?? {};
  // prefix -> landed paths sharing it (>1 ⇒ ambiguous ⇒ treat as no-match).
  const byPrefix = new Map<string, string[]>();
  for (const [key, path] of Object.entries(landed)) {
    const prefix = claimKeyPrefix(key);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), path]);
  }

  return claims.map((claim): ClaimAction => {
    const exact = landed[claim.claim_key];
    if (exact !== undefined) return { kind: "skip", claim, landedPath: exact };
    const siblings = byPrefix.get(claimKeyPrefix(claim.claim_key));
    if (siblings !== undefined && siblings.length === 1) {
      return { kind: "update", claim, landedPath: siblings[0] as string };
    }
    return { kind: "new", claim };
  });
}

// ---------------------------------------------------------------------------
// Failed-chunk retry manifest (kphd)
// ---------------------------------------------------------------------------

function scopedContentHash(sourceContent: string, scope: string | undefined): string {
  return sourceContentHash(scope ? `${scope}\u0000${sourceContent}` : sourceContent);
}

function failedAnchorsFor(
  src: DistillSourceState | undefined,
  scope: string | undefined,
): string[] {
  return (scope ? src?.scope_failed_chunk_anchors?.[scope] : src?.failed_chunk_anchors) ?? [];
}

/**
 * Return `base` with the failed-chunk anchors for `scope` set to `anchors`,
 * carrying every other scope's anchors over from `prior`. Empty ⇒ the field is
 * omitted, so a clean source's state stays byte-identical to the old shape.
 */
function withFailedAnchors(
  base: DistillSourceState,
  prior: DistillSourceState | undefined,
  scope: string | undefined,
  anchors: string[],
): DistillSourceState {
  const next: DistillSourceState = { ...base };
  const unscoped = scope ? (prior?.failed_chunk_anchors ?? []) : anchors;
  if (unscoped.length > 0) next.failed_chunk_anchors = [...unscoped].sort();
  const scoped: Record<string, string[]> = { ...prior?.scope_failed_chunk_anchors };
  if (scope) {
    if (anchors.length > 0) scoped[scope] = [...anchors].sort();
    else delete scoped[scope];
  }
  if (Object.keys(scoped).length > 0) next.scope_failed_chunk_anchors = scoped;
  return next;
}

/**
 * Chunks to re-extract for an unchanged source (kphd): the anchors a prior
 * partial run recorded, or [] when the content changed (a full run follows)
 * or nothing failed. The CLI calls this before extraction to narrow the
 * chunk list; distillUpsert re-derives the same answer from state.
 */
export function pendingChunkRetry(
  vaultRoot: string,
  input: { sourceId: string; sourceContent: string; scope?: string },
): string[] {
  const prior = readDistillState(vaultRoot).sources[input.sourceId];
  if (prior === undefined) return [];
  const contentHash = scopedContentHash(input.sourceContent, input.scope);
  const priorHash = input.scope ? prior.scope_hashes?.[input.scope] : prior.content_hash;
  return priorHash === contentHash ? failedAnchorsFor(prior, input.scope) : [];
}

// ---------------------------------------------------------------------------
// The upsert orchestrator
// ---------------------------------------------------------------------------

export interface DistillUpsertInput {
  /** Stable identity of the ingested source (the idempotency key). */
  sourceId: string;
  /** Normalized source content — hashed for the whole-source fast path. */
  sourceContent: string;
  claims: ExtractedClaim[];
  /** Per-run trace stamp (StageActionInput.runId). Never the idempotency key. */
  runId: string;
  /**
   * Optional overlap-search function (U8/R5): given a claim statement, returns
   * vault-relative paths of likely overlapping documents. When provided, the
   * top-K paths are appended to each proposal's rationale so the ratifier can
   * see possible collisions. When absent, rationale is the statement alone
   * (original U4 behaviour, fully backward-compatible). All existing 4-field
   * callers remain valid — this field is optional.
   */
  overlapSearch?: OverlapSearchFn;
  /**
   * Optional target collection override (#506). Defaults to
   * propose.ts's DISTILL_COLLECTION when absent — every existing caller is
   * unaffected. Set by a selected-source connector's enrolled collection.
   */
  collection?: string;
  /** Injectable proposal writer used to verify atomic retry behavior. */
  proposeClaims?: typeof proposeAllClaims;
  /**
   * Optional idempotency scope within the source (83b1) — the `--sender`
   * filter. Scoped passes over the same file are tracked independently.
   */
  scope?: string;
  /**
   * Chunks whose extraction failed this run (ExtractOutcome.chunkErrors.length).
   * With zero claims, a non-zero count means the run learned nothing about the
   * source: its hash is NOT recorded, so the next run re-distills instead of
   * no-op'ing on a hash a failed run wrote (bead b4m3). Absent ⇒ 0.
   */
  extractionErrors?: number;
  /**
   * Anchors of the chunks counted in extractionErrors (kphd). Persisted when
   * the run still lands claims, so the next run retries just those chunks.
   * Absent ⇒ []; a clean run clears any previously recorded anchors.
   */
  failedChunkAnchors?: string[];
}

export interface DistillUpsertOutcome {
  /** True when the source content hash is unchanged — nothing was staged. */
  noop: boolean;
  /** claim_keys already landed unchanged — not re-emitted. */
  skipped: string[];
  /** Edited claims staged as update-in-place writes to their landed path. */
  updated: Array<{ claim_key: string; landedPath: string }>;
  /** claim_keys staged as new writes. */
  created: string[];
  /** The emitter outcome for the updated+created claims; null on no-op. */
  propose: ProposeOutcome | null;
  /** False when the state file could not be written (proposals still staged). */
  stateWritten: boolean;
  stateError?: string;
  /**
   * Anchors a prior partial run recorded for this unchanged source (kphd).
   * Non-empty ⇒ this run was a chunk retry rather than a whole-source no-op.
   */
  retryAnchors?: string[];
  /** Anchors the next run will retry, as recorded (or left) by this run. */
  pendingRetryAnchors?: string[];
}

/**
 * Re-distill join for one source: unchanged content hash ⇒ free no-op;
 * changed ⇒ per claim skip / update-in-place / new-write (R4). Skipped
 * claims are never re-emitted. Returns err only on input validation — a
 * failed state write degrades to `stateWritten: false` because the
 * proposals are already durably staged (retry would duplicate them).
 */
export async function distillUpsert(
  vaultRoot: string,
  input: DistillUpsertInput,
): Promise<Result<DistillUpsertOutcome, Error>> {
  if (input.sourceId.trim().length === 0) {
    return err(new Error("distillUpsert requires a non-empty sourceId"));
  }

  const state = readDistillState(vaultRoot);
  const prior = state.sources[input.sourceId];
  const scope = input.scope;
  const contentHash = scopedContentHash(input.sourceContent, scope);
  const priorHash = scope ? prior?.scope_hashes?.[scope] : prior?.content_hash;
  const hashUnchanged = prior !== undefined && priorHash === contentHash;
  const resumingPendingEmit =
    prior?.pending_content_hash === contentHash && (prior.pending_claims?.length ?? 0) > 0;
  // An unchanged hash is a free no-op unless a prior partial run left failed
  // chunks to retry (kphd) or a staging remainder for this very hash.
  const retryAnchors = hashUnchanged ? failedAnchorsFor(prior, scope) : [];

  if (hashUnchanged && retryAnchors.length === 0 && !resumingPendingEmit) {
    return ok({
      noop: true,
      skipped: [],
      updated: [],
      created: [],
      propose: null,
      stateWritten: true,
      retryAnchors: [],
      pendingRetryAnchors: [],
    });
  }

  // A run whose extraction errored and yielded nothing must leave no trace:
  // recording its hash would make the next (working) run over the same source
  // a silent no-op that discards every claim it extracts. A retry is exempt:
  // its hash is already recorded and the prior anchors stay pending.
  const extractionErrors = input.extractionErrors ?? 0;
  if (extractionErrors > 0 && input.claims.length === 0 && !hashUnchanged) {
    return ok({
      noop: false,
      skipped: [],
      updated: [],
      created: [],
      propose: null,
      stateWritten: false,
      stateError: `extraction failed for ${extractionErrors} chunk(s) and produced no claims; source state not recorded`,
      retryAnchors,
      pendingRetryAnchors: [],
    });
  }

  // The failed anchors belong to whichever claim batch is staged: a resumed
  // pending emit replays the batch (and failures) of the run that recorded it.
  const failedAnchors = resumingPendingEmit
    ? failedAnchorsFor(prior, scope)
    : (input.failedChunkAnchors ?? []);
  // LLM extraction is nondeterministic. Once any claim in a batch fails, the
  // exact failed remainder becomes the retry manifest: accepting a fresh
  // paraphrase could duplicate a successful claim or omit a failed one.
  const claims = resumingPendingEmit ? (prior?.pending_claims ?? []) : input.claims;
  const actions = joinClaims(prior, claims);
  const alreadyEmitted = new Set(
    prior?.pending_content_hash === contentHash ? (prior.emitted_claim_keys ?? []) : [],
  );
  const skipped: string[] = [];
  const updated: Array<{ claim_key: string; landedPath: string }> = [];
  const created: string[] = [];
  const toPropose: ExtractedClaim[] = [];
  const pathOverrides: Record<string, string> = {};

  for (const action of actions) {
    if (action.kind === "skip") {
      skipped.push(action.claim.claim_key);
      continue;
    }
    if (alreadyEmitted.has(action.claim.claim_key)) continue;
    toPropose.push(action.claim);
    if (action.kind === "update") {
      updated.push({ claim_key: action.claim.claim_key, landedPath: action.landedPath });
      pathOverrides[action.claim.claim_key] = action.landedPath;
    } else {
      created.push(action.claim.claim_key);
    }
  }

  const attempted = await (input.proposeClaims ?? proposeAllClaims)(
    vaultRoot,
    toPropose,
    { sourceId: input.sourceId, runId: input.runId, collection: input.collection },
    pathOverrides,
    input.overlapSearch,
  );

  const successfulClaimKeys = new Set(attempted.results.map((result) => result.claim_key));
  // A durable success wins over a contradictory error for the same claim.
  // Retrying that claim would create a duplicate proposal.
  const unresolvedErrors = attempted.errors.filter(
    (failure) => !successfulClaimKeys.has(failure.claim_key),
  );
  const reportedClaimKeys = new Set([
    ...successfulClaimKeys,
    ...unresolvedErrors.map((failure) => failure.claim_key),
  ]);
  const unaccounted = toPropose
    .filter((claim) => !reportedClaimKeys.has(claim.claim_key))
    .map((claim) => ({ claim_key: claim.claim_key, error: "proposal result was missing" }));
  const propose: ProposeOutcome = {
    ...attempted,
    errors: [...unresolvedErrors, ...unaccounted],
  };

  if (propose.errors.length > 0) {
    const emittedClaimKeys = new Set(alreadyEmitted);
    for (const result of propose.results) emittedClaimKeys.add(result.claim_key);
    const failedClaimKeys = new Set(propose.errors.map((failure) => failure.claim_key));
    state.sources[input.sourceId] = withFailedAnchors(
      {
        content_hash: prior?.content_hash ?? "",
        claims: prior?.claims ?? {},
        pending_content_hash: contentHash,
        emitted_claim_keys: [...emittedClaimKeys].sort(),
        pending_claims: toPropose.filter((claim) => failedClaimKeys.has(claim.claim_key)),
        ...(prior?.scope_hashes ? { scope_hashes: prior.scope_hashes } : {}),
      },
      prior,
      scope,
      failedAnchors,
    );
    const wrote = writeDistillState(vaultRoot, state);
    return ok({
      noop: false,
      skipped,
      updated,
      created,
      propose,
      stateWritten: wrote.ok,
      stateError: wrote.ok
        ? "proposal staging was incomplete"
        : `proposal staging was incomplete; ${wrote.error.message}`,
      retryAnchors,
      pendingRetryAnchors: wrote.ok ? failedAnchors : failedAnchorsFor(prior, scope),
    });
  }

  // Advance the emit clock; the landed map only moves via recordLandedClaim.
  state.sources[input.sourceId] = withFailedAnchors(
    scope
      ? {
          content_hash: prior?.content_hash ?? "",
          claims: prior?.claims ?? {},
          scope_hashes: { ...prior?.scope_hashes, [scope]: contentHash },
        }
      : {
          content_hash: contentHash,
          claims: prior?.claims ?? {},
          ...(prior?.scope_hashes ? { scope_hashes: prior.scope_hashes } : {}),
        },
    prior,
    scope,
    failedAnchors,
  );
  const wrote = writeDistillState(vaultRoot, state);

  return ok({
    noop: false,
    skipped,
    updated,
    created,
    propose,
    stateWritten: wrote.ok,
    ...(wrote.ok ? {} : { stateError: wrote.error.message }),
    retryAnchors,
    pendingRetryAnchors: wrote.ok ? failedAnchors : failedAnchorsFor(prior, scope),
  });
}
