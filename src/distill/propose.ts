// src/distill/propose.ts
//
// Proposal emitter (U4). Maps each ExtractedClaim to a `vault_stage_action`
// "write" proposal at status:draft / confidence:low / provenance:synthesized,
// stamped with the distill run_id. Routes through stageActionWithConflictCheck
// so inter-proposal conflicts and the staged-action queue's built-in guards
// fire without any new gate.
//
// Design note on the tier-0 canonical gate:
//   The tier-0 canonical gate fires at RATIFY time (vault_ratify) when a
//   staged write proposal declares status:canonical in its merged post-state.
//   It does NOT fire at stage time. The emitter enforces R3 by construction:
//   every proposal is hardcoded to status:draft. The human gate (vault_ratify)
//   is the existing boundary — no new gate is introduced here.
//
// Collection:
//   Defaulting to "distill". This is a named constant (DISTILL_COLLECTION)
//   so a future config hook can override it without touching call sites.

import { join } from "node:path";
import { dump } from "js-yaml";
import type { AccessContext } from "../access/rbac.js";
import { type StageOutcome, stageActionWithConflictCheck } from "../curation/staged-actions.js";
import { slugifyKey } from "../import/langgraph-store.js";
import { vaultSearch } from "../tools/search.js";
import type { ExtractedClaim } from "./extract.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Target collection for all distill proposals. */
export const DISTILL_COLLECTION = "distill";

/** The proposing agent identity, recorded on every proposal. */
export const DISTILL_AGENT = "agent:distill";

/**
 * Maximum number of overlap paths attached to a proposal rationale (U8).
 * Small and bounded: the hint is advisory context for the ratifier, not a
 * full search result set.
 */
export const OVERLAP_HINT_TOP_K = 3;

// ---------------------------------------------------------------------------
// Overlap-hint types and factory (U8, R5)
// ---------------------------------------------------------------------------

/**
 * A function that, given a claim statement, returns the vault-relative paths
 * of documents that are likely to overlap with the claim (no LLM, no tension
 * scan — pure local index query). An empty return means no overlaps found.
 *
 * Errors thrown by this function are caught by proposeAllClaims and cause a
 * graceful no-hint degradation (the claim still stages).
 */
export type OverlapSearchFn = (statement: string) => Promise<string[]>;

/**
 * Build an overlap-search function backed by the vault's hybrid search index.
 * The CLI wires this into proposeAllClaims; tests inject stubs instead.
 *
 * Design note: vaultSearch is query-based (statement → top-K existing docs).
 * vaultSearchRelated is path-based and requires an already-indexed document.
 * Distilled claims do not exist in the index yet, so vaultSearch is the
 * correct primitive — confirmed deviation from the plan's `vault_search_related`
 * wording.
 *
 * @param vaultRoot Absolute path to the vault root.
 * @param access    Optional RBAC context forwarded to vaultSearch.
 */
export function makeOverlapHinter(vaultRoot: string, access?: AccessContext): OverlapSearchFn {
  return async (statement: string): Promise<string[]> => {
    const result = await vaultSearch(
      vaultRoot,
      { query: statement, limit: OVERLAP_HINT_TOP_K },
      access,
    );
    if (!result.ok) return [];
    return result.value.hits.slice(0, OVERLAP_HINT_TOP_K).map((h) => h.path);
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The two distill identifiers, deliberately distinct (U5). */
export interface DistillIds {
  /**
   * Stable identity of the ingested source (e.g. one chat export). The
   * idempotency key: the durable `sources` ref and the run-group folder are
   * derived from it so a re-distill joins on the same identifier.
   */
  sourceId: string;
  /** Per-run trace stamp (StageActionInput.runId). Never the idempotency key. */
  runId: string;
}

/** Per-claim staging outcome (the StageOutcome from the queue, or an error). */
export interface ClaimProposalResult extends StageOutcome {
  claim_key: string;
  targetPath: string;
}

/** Aggregate result for a proposeAllClaims call. */
export interface ProposeOutcome {
  /** Number of claims successfully staged. */
  proposed: number;
  /** Per-claim results (one entry per claim, success or skipped). */
  results: ClaimProposalResult[];
  /** Per-claim errors (claim_key + message). Claims that error are not in results. */
  errors: Array<{ claim_key: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Path derivation
// ---------------------------------------------------------------------------

// Pull the 8-char hash suffix already embedded at the end of the claim_key
// (format: `<anchor>:<slug>-<hash8>`). If the format is unexpected, fall
// back to a hash of the full key so paths remain collision-resistant.
function hash8FromClaimKey(claimKey: string): string {
  const lastDash = claimKey.lastIndexOf("-");
  if (lastDash !== -1 && claimKey.length - lastDash - 1 === 8) {
    return claimKey.slice(lastDash + 1);
  }
  // Fallback: take last 8 chars of the key itself. This branch is only
  // reachable if claim_key deviates from U3's documented
  // `<anchor>:<slug>-<sha256[:8]>` format — intentionally best-effort.
  return claimKey.slice(-8).replace(/[^a-z0-9]/g, "x");
}

// Derive the vault-relative path for a claim. Mirrors the langgraph adapter:
//   <collection>/<source_group>/<slug(title)>--<hash8>.md
// The source_group is the stable source-id slugified (keeps a source's claims
// co-located AND stable across runs — U5's re-distill join relies on it);
// falls back to "claims" if the source-id is empty or non-slug-friendly.
//
// Path-traversal safety: slugifyKey strips everything except [a-z0-9-], so
// none of the join components can contain ".." or path separators — the
// sanitizer is the invariant; don't remove it in a future refactor.
function derivePath(claim: ExtractedClaim, sourceId: string): string {
  const title = claim.proposed_frontmatter.title;
  const hash8 = hash8FromClaimKey(claim.claim_key);
  const sourceGroup = slugifyKey(sourceId) || "claims";
  // Fall back to the claim_key slug when the title is empty. slugifyKey
  // returns the sentinel "memory" for an empty/whitespace-only string — a
  // truthy value — so we cannot use || on its return value. Guard on the
  // raw title instead. Avoids every empty-title claim collapsing to
  // "memory", which makes U5's targetPath-based upsert join harder to
  // reason about and produces semantically useless names.
  const titleSlug = title.trim() ? slugifyKey(title) : slugifyKey(claim.claim_key);
  return join(DISTILL_COLLECTION, sourceGroup, `${titleSlug}--${hash8}.md`);
}

// ---------------------------------------------------------------------------
// Note assembly (mirrors langgraph-store.ts deriveNotes)
// ---------------------------------------------------------------------------

function assembleBody(
  claim: ExtractedClaim,
  frontmatter: Record<string, unknown>,
  ids: DistillIds,
): string {
  return [
    "---",
    dump(frontmatter).trimEnd(),
    "---",
    "",
    claim.statement.trim(),
    "",
    "## Provenance",
    "",
    `- **Pipeline:** distill (compile-on-ingest)`,
    `- **Claim key:** \`${claim.claim_key}\``,
    `- **Run id:** \`${ids.runId}\``,
    `- **Source ref:** \`distill:${ids.sourceId}#${claim.claim_key}\``,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Rationale builder (U8)
// ---------------------------------------------------------------------------

// Build the proposal rationale, optionally appending an overlap-hint line.
// The statement is always the lead so stageActionWithConflictCheck's
// firstSentence() extraction and the ratifier's first read both land on the
// claim itself. A non-empty overlap list appends a "Possible overlaps: ..."
// line separated by a blank line. An empty list or a throwing overlapSearch
// produces the statement alone — no "Possible overlaps:" line at all.
async function buildRationale(statement: string, overlapSearch?: OverlapSearchFn): Promise<string> {
  if (!overlapSearch) return statement;
  let paths: string[] = [];
  try {
    const raw = await overlapSearch(statement);
    paths = raw.slice(0, OVERLAP_HINT_TOP_K);
  } catch {
    // Degrade to no-hint: a search failure must never block staging.
    return statement;
  }
  if (paths.length === 0) return statement;
  return `${statement}\n\nPossible overlaps: ${paths.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Core emitter
// ---------------------------------------------------------------------------

/**
 * Emit each claim as a `write` staged-action proposal at draft/low/synthesized.
 * Routes through `stageActionWithConflictCheck` so inter-proposal conflicts
 * are detected and logged. Never calls performWrite.
 *
 * @param vaultRoot      Absolute path to the vault root.
 * @param claims         Extracted claims from the extraction stage (U3).
 * @param ids            Stable source-id (idempotency key) + per-run trace id.
 * @param pathOverrides  claim_key -> target path, for U5 update-in-place
 *                       proposals that must land on an already-landed path.
 * @param overlapSearch  Optional injected function (U8/R5): given a claim
 *                       statement, returns vault-relative paths of likely
 *                       overlapping documents. When provided, the top-K paths
 *                       are appended to the proposal rationale so the ratifier
 *                       can see possible collisions. No LLM or tension-scan
 *                       runs here — the function is a pure local index query.
 *                       When absent, rationale is the statement alone (the
 *                       original U4 behaviour, fully backward-compatible).
 *                       Errors thrown by overlapSearch degrade to no-hint;
 *                       the claim still stages.
 */
export async function proposeAllClaims(
  vaultRoot: string,
  claims: ExtractedClaim[],
  ids: DistillIds,
  pathOverrides?: Record<string, string>,
  overlapSearch?: OverlapSearchFn,
): Promise<ProposeOutcome> {
  const results: ClaimProposalResult[] = [];
  const errors: Array<{ claim_key: string; error: string }> = [];

  for (const claim of claims) {
    const targetPath = pathOverrides?.[claim.claim_key] ?? derivePath(claim, ids.sourceId);

    // R3: frontmatter is hardcoded to draft/low/synthesized. No caller can
    // override these — the emitter owns the invariant.
    const frontmatter: Record<string, unknown> = {
      title: claim.proposed_frontmatter.title,
      domain: "accumulation",
      collection: DISTILL_COLLECTION,
      status: "draft",
      confidence: "low",
      provenance: "synthesized",
      // proposed_by (vault document field) and proposedBy on the StageActionInput
      // below (the actor recorded on the JSONL staged-action record) are both set
      // to DISTILL_AGENT. They are DIFFERENT concepts — document metadata vs
      // queue actor — intentionally kept in sync. Update both together if either
      // ever needs to change.
      proposed_by: DISTILL_AGENT,
      // Keyed on the STABLE source-id (U5/R4) — a re-distill of the same
      // source in a later run must produce the same ref. Never the run-id.
      sources: [`distill:${ids.sourceId}#${claim.claim_key}`],
      superseded_by: null,
      ttl_days: null,
    };

    const body = assembleBody(claim, frontmatter, ids);

    // U8/R5: overlap-hint. Attach top-K likely-collision neighbor paths to
    // the rationale so the ratifier can see possible overlaps at a glance.
    // No LLM or tension-scan runs here — overlapSearch is a pure local index
    // query injected by the caller. A missing or throwing overlapSearch
    // degrades to no-hint (claim still stages, original rationale preserved).
    const rationale = await buildRationale(claim.statement, overlapSearch);

    const staged = await stageActionWithConflictCheck(vaultRoot, {
      actionType: "write",
      targetPath,
      proposedBy: DISTILL_AGENT,
      rationale,
      proposedDiff: { frontmatter, body },
      runId: ids.runId,
    });

    if (!staged.ok) {
      errors.push({ claim_key: claim.claim_key, error: staged.error.message });
      continue;
    }

    results.push({
      ...staged.value,
      claim_key: claim.claim_key,
      targetPath,
    });
  }

  return { proposed: results.length, results, errors };
}
