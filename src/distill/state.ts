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
//   - content_hash advances at EMIT time. Staging is durable (the proposals
//     sit in the staged-actions jsonl), so an unchanged re-run must be a free
//     no-op — re-emitting would duplicate pending proposals.
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
// degrade — the next run re-joins against stale state and the queue's
// conflict check catches any duplicates loudly.
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
  /** Injectable proposal writer used to verify atomic retry behavior. */
  proposeClaims?: typeof proposeAllClaims;
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
  const contentHash = sourceContentHash(input.sourceContent);

  if (prior !== undefined && prior.content_hash === contentHash) {
    return ok({
      noop: true,
      skipped: [],
      updated: [],
      created: [],
      propose: null,
      stateWritten: true,
    });
  }

  const actions = joinClaims(prior, input.claims);
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
    toPropose.push(action.claim);
    if (action.kind === "update") {
      updated.push({ claim_key: action.claim.claim_key, landedPath: action.landedPath });
      pathOverrides[action.claim.claim_key] = action.landedPath;
    } else {
      created.push(action.claim.claim_key);
    }
  }

  const propose = await (input.proposeClaims ?? proposeAllClaims)(
    vaultRoot,
    toPropose,
    { sourceId: input.sourceId, runId: input.runId },
    pathOverrides,
    input.overlapSearch,
  );

  if (propose.errors.length > 0) {
    return ok({
      noop: false,
      skipped,
      updated,
      created,
      propose,
      stateWritten: false,
      stateError: "proposal staging was incomplete",
    });
  }

  // Advance the emit clock; the landed map only moves via recordLandedClaim.
  state.sources[input.sourceId] = {
    content_hash: contentHash,
    claims: prior?.claims ?? {},
  };
  const wrote = writeDistillState(vaultRoot, state);

  return ok({
    noop: false,
    skipped,
    updated,
    created,
    propose,
    stateWritten: wrote.ok,
    ...(wrote.ok ? {} : { stateError: wrote.error.message }),
  });
}
