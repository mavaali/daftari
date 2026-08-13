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
import { type StageOutcome, stageActionWithConflictCheck } from "../curation/staged-actions.js";
import { slugifyKey } from "../import/langgraph-store.js";
import type { ExtractedClaim } from "./extract.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Target collection for all distill proposals. */
export const DISTILL_COLLECTION = "distill";

/** The proposing agent identity, recorded on every proposal. */
export const DISTILL_AGENT = "agent:distill";

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
 */
export async function proposeAllClaims(
  vaultRoot: string,
  claims: ExtractedClaim[],
  ids: DistillIds,
  pathOverrides?: Record<string, string>,
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

    const staged = await stageActionWithConflictCheck(vaultRoot, {
      actionType: "write",
      targetPath,
      proposedBy: DISTILL_AGENT,
      rationale: claim.statement,
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
