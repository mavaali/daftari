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
  // Fallback: take last 8 chars of the key itself.
  return claimKey.slice(-8).replace(/[^a-z0-9]/g, "x");
}

// Derive the vault-relative path for a claim. Mirrors the langgraph adapter:
//   <collection>/<run_group>/<slug(title)>--<hash8>.md
// The run_group is the run_id slugified (keeps same-run claims co-located);
// falls back to "claims" if the run_id is empty or non-slug-friendly.
function derivePath(claim: ExtractedClaim, runId: string): string {
  const title = claim.proposed_frontmatter.title;
  const hash8 = hash8FromClaimKey(claim.claim_key);
  const runGroup = slugifyKey(runId) || "claims";
  return join(DISTILL_COLLECTION, runGroup, `${slugifyKey(title)}--${hash8}.md`);
}

// ---------------------------------------------------------------------------
// Note assembly (mirrors langgraph-store.ts deriveNotes)
// ---------------------------------------------------------------------------

function assembleBody(
  claim: ExtractedClaim,
  frontmatter: Record<string, unknown>,
  runId: string,
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
    `- **Run id:** \`${runId}\``,
    `- **Source ref:** \`distill:${runId}#${claim.claim_key}\``,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Core emitter
// ---------------------------------------------------------------------------

/**
 * Emit each claim as a `write` staged-action proposal at draft/low/synthesized,
 * stamped with `run_id`. Routes through `stageActionWithConflictCheck` so
 * inter-proposal conflicts are detected and logged. Never calls performWrite.
 *
 * @param vaultRoot  Absolute path to the vault root.
 * @param claims     Extracted claims from the extraction stage (U3).
 * @param runId      Distill run identifier, stamped on every proposal.
 */
export async function proposeAllClaims(
  vaultRoot: string,
  claims: ExtractedClaim[],
  runId: string,
): Promise<ProposeOutcome> {
  const results: ClaimProposalResult[] = [];
  const errors: Array<{ claim_key: string; error: string }> = [];

  for (const claim of claims) {
    const targetPath = derivePath(claim, runId);

    // R3: frontmatter is hardcoded to draft/low/synthesized. No caller can
    // override these — the emitter owns the invariant.
    const frontmatter: Record<string, unknown> = {
      title: claim.proposed_frontmatter.title,
      domain: "accumulation",
      collection: DISTILL_COLLECTION,
      status: "draft",
      confidence: "low",
      provenance: "synthesized",
      proposed_by: DISTILL_AGENT,
      sources: [`distill:${runId}#${claim.claim_key}`],
      superseded_by: null,
      ttl_days: null,
    };

    const body = assembleBody(claim, frontmatter, runId);

    const staged = await stageActionWithConflictCheck(vaultRoot, {
      actionType: "write",
      targetPath,
      proposedBy: DISTILL_AGENT,
      rationale: claim.statement,
      proposedDiff: { frontmatter, body },
      runId,
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
