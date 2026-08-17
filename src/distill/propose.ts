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
import type { ClaimRunMeta, ExtractedClaim } from "./extract.js";
import { refuseRawDistillOutput } from "./output-fence.js";
import { encodeReader, READER_PROMPT_VERSION } from "./reader-fingerprint.js";

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
 * The result of an overlap search (U8 + R7): the vault-relative paths of the
 * top-K likely-overlapping documents AND the fused search score of the single
 * top neighbor. The paths feed the proposal's rationale (advisory context for
 * the ratifier); the top score is the corroboration signal stamped onto the
 * staged proposal (R7) that the confidence gate reads later.
 */
export interface OverlapHint {
  /** Vault-relative paths of the top-K likely-overlapping documents. */
  paths: string[];
  /** Fused search score of the top neighbor, min-normalized to [0,1]; 0 if none. */
  topScore: number;
}

/**
 * A function that, given a claim statement, returns an OverlapHint: the
 * vault-relative paths of documents likely to overlap with the claim, plus the
 * top neighbor's fused search score (no LLM, no tension scan — pure local index
 * query). An empty `paths` array with `topScore: 0` means no overlaps found.
 *
 * Errors thrown by this function are caught by proposeAllClaims and cause a
 * graceful no-hint degradation (the claim still stages, corroboration 0).
 */
export type OverlapSearchFn = (statement: string) => Promise<OverlapHint>;

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
 * The returned top score is `hits[0].score` — the fused BM25/vector score,
 * already min-normalized to [0,1] by the hybrid ranker. It becomes the
 * proposal's corroboration signal (R7).
 *
 * @param vaultRoot Absolute path to the vault root.
 * @param access    Optional RBAC context forwarded to vaultSearch.
 */
export function makeOverlapHinter(vaultRoot: string, access?: AccessContext): OverlapSearchFn {
  return async (statement: string): Promise<OverlapHint> => {
    const result = await vaultSearch(
      vaultRoot,
      { query: statement, limit: OVERLAP_HINT_TOP_K },
      access,
    );
    if (!result.ok) return { paths: [], topScore: 0 };
    const hits = result.value.hits.slice(0, OVERLAP_HINT_TOP_K);
    return {
      paths: hits.map((h) => h.path),
      topScore: hits.length > 0 ? hits[0].score : 0,
    };
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
  /**
   * Optional `created`/`updated` date (YYYY-MM-DD) for the emitted proposals.
   * Defaults to today. Set it when the source has a meaningful as-of date that
   * differs from the run date — e.g. the recall-bench distill arm stamps each
   * benchmark day's own date so temporal signals are correct and landed content
   * is date-stable across runs.
   */
  asOf?: string;
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
// Reader provenance frontmatter (f3h)
// ---------------------------------------------------------------------------

/**
 * The reader_* frontmatter fields stamped from a claim's run_meta. Every field
 * is a DECLARED-OPTIONAL schema extension (see docs/schema-extensions.md); the
 * fields land typed in a vault whose config declares them, untyped-but-preserved
 * otherwise, and never block a write (optional, advisory).
 *
 * null is never written for any field — a null on a declared extension DELETES
 * it (serializeDocument treats null as absent). So a value that would be null is
 * either given a sentinel (served_model → "unreported") or the field is OMITTED
 * (temperature, which is a number and cannot carry a sentinel).
 */
export interface ReaderFrontmatter {
  reader_model: string;
  reader_served_model: string;
  reader_temperature?: number;
  reader_via_retry: boolean;
  reader_prompt_version: string;
  reader_chunk_window: number;
  reader_input_cap: number;
  readers: string[];
}

/**
 * Build the reader_* frontmatter fields from a claim's run_meta. The prompt
 * version is READER_PROMPT_VERSION (the hash of the effective extraction prompt
 * contract at this build). `readers` carries exactly ONE entry at ingest — the
 * parentage SET a later merge bead unions.
 *
 * Locked field rules (see the bead spec):
 *   - reader_served_model uses the "unreported" sentinel when servedModel is
 *     undefined — NEVER null (null deletes the field).
 *   - reader_temperature is OMITTED when effectiveTemperature is undefined — a
 *     number field cannot hold a sentinel.
 *   - reader_via_retry defaults to false when viaRetry is undefined.
 */
export function buildReaderFrontmatter(runMeta: ClaimRunMeta): ReaderFrontmatter {
  const fm: ReaderFrontmatter = {
    reader_model: runMeta.requestedModel,
    reader_served_model: runMeta.servedModel ?? "unreported",
    reader_via_retry: runMeta.viaRetry ?? false,
    reader_prompt_version: READER_PROMPT_VERSION,
    reader_chunk_window: runMeta.chunkWindow,
    reader_input_cap: runMeta.inputCap,
    readers: [encodeReader(runMeta, READER_PROMPT_VERSION)],
  };
  // Omit reader_temperature entirely when unknown: a number can't hold a
  // sentinel and null would delete a declared extension.
  if (runMeta.effectiveTemperature !== undefined) {
    fm.reader_temperature = runMeta.effectiveTemperature;
  }
  return fm;
}

// ---------------------------------------------------------------------------
// Note assembly (mirrors langgraph-store.ts deriveNotes)
// ---------------------------------------------------------------------------

// Human-readable "Reader" subsection of the Provenance body, mirroring the
// reader_* frontmatter. Returns [] (no subsection) when the claim carries no
// run_meta, so a claim without reader provenance produces the original body.
function readerProvenanceLines(reader: ReaderFrontmatter | null): string[] {
  if (reader === null) return [];
  return [
    "",
    "### Reader",
    "",
    `- **Model (requested):** \`${reader.reader_model}\``,
    `- **Model (served):** \`${reader.reader_served_model}\``,
    ...(reader.reader_temperature !== undefined
      ? [`- **Effective temperature:** \`${reader.reader_temperature}\``]
      : []),
    `- **Via retry:** \`${reader.reader_via_retry}\``,
    `- **Prompt version:** \`${reader.reader_prompt_version}\``,
    `- **Chunk window:** \`${reader.reader_chunk_window}\``,
    `- **Input cap:** \`${reader.reader_input_cap}\``,
    `- **Readers:** \`${reader.readers.join(", ")}\``,
    "",
    "_This fingerprint identifies the run configuration; it does not guarantee " +
      "bit-identical re-extraction (temperature 0 is not seeded; provider/quantization " +
      "variance)._",
  ];
}

function assembleBody(
  claim: ExtractedClaim,
  frontmatter: Record<string, unknown>,
  ids: DistillIds,
  reader: ReaderFrontmatter | null,
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
    ...readerProvenanceLines(reader),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Proposal metadata builder (U8 rationale + R7 corroboration)
// ---------------------------------------------------------------------------

/**
 * Build the proposal's rationale AND corroboration score in one pass over the
 * overlap search.
 *
 * Rationale (U8, unchanged behavior): the statement is always the lead so
 * stageActionWithConflictCheck's firstSentence() extraction and the ratifier's
 * first read both land on the claim itself. A non-empty overlap `paths` list
 * appends a "Possible overlaps: ..." line separated by a blank line. An empty
 * list, a missing hinter, or a throwing overlapSearch produces the statement
 * alone — no "Possible overlaps:" line at all.
 *
 * Corroboration (R7): the top neighbor's fused search score, min-normalized to
 * [0,1]. Defaults to 0 when there is no hinter, no neighbor, a search error, or
 * a non-finite score. This is the confidence-gate signal a later review pass
 * reads off `proposedDiff.corroboration` — never computed or thresholded here.
 */
async function buildProposalMeta(
  statement: string,
  overlapSearch?: OverlapSearchFn,
): Promise<{ rationale: string; corroboration: number }> {
  if (!overlapSearch) return { rationale: statement, corroboration: 0 };
  let hint: OverlapHint;
  try {
    hint = await overlapSearch(statement);
  } catch {
    // Degrade to no-hint: a search failure must never block staging.
    return { rationale: statement, corroboration: 0 };
  }
  const corroboration = Number.isFinite(hint.topScore) ? hint.topScore : 0;
  // No neighbors ⇒ statement-only rationale, but keep the (well-defined) score.
  if (!hint.paths || hint.paths.length === 0) {
    return { rationale: statement, corroboration };
  }
  const safePaths = hint.paths
    .slice(0, OVERLAP_HINT_TOP_K)
    // Sanitize newlines in paths — a path containing \r or \n would break the
    // "statement is the lead" invariant that stageActionWithConflictCheck's
    // firstSentence() relies on.
    .map((p) => p.replace(/[\r\n]+/g, " "));
  return {
    rationale: `${statement}\n\nPossible overlaps: ${safePaths.join(", ")}`,
    corroboration,
  };
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
      // Required date field: stamp the as-of date (falling back to the emit
      // date) so the proposal is a complete, ratifiable document (vault_ratify
      // validates the full frontmatter before it lands the write — a proposal
      // missing `created` cannot be approved).
      created: ids.asOf ?? new Date().toISOString().slice(0, 10),
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

    // U11/R8: distill-and-discard fence. Refuse before staging any landing that
    // would write raw/source material (top-level raw/ path or tier: source) —
    // defense-in-depth against a bad path override or future refactor.
    const fence = refuseRawDistillOutput(targetPath, frontmatter);
    if (!fence.ok) {
      errors.push({ claim_key: claim.claim_key, error: fence.error.message });
      continue;
    }

    // f3h: the producing extraction call's run metadata reaches this point as
    // `claim.run_meta` (ClaimRunMeta | undefined) — servedModel,
    // effectiveTemperature, viaRetry, requestedModel, chunkWindow, inputCap. When
    // present, stamp the reader fingerprint onto the belief's frontmatter as
    // declared-optional schema_extensions (reader_*/readers). When ABSENT (older
    // paths, mocks that omit it), skip every reader field entirely — they are
    // optional and must not crash or write empty/null placeholders.
    const reader = claim.run_meta ? buildReaderFrontmatter(claim.run_meta) : null;
    if (reader) Object.assign(frontmatter, reader);

    const body = assembleBody(claim, frontmatter, ids, reader);

    // U8/R5 + R7: overlap-hint. Attach top-K likely-collision neighbor paths to
    // the rationale so the ratifier can see possible overlaps at a glance, and
    // stamp the top neighbor's fused search score as `corroboration`. No LLM or
    // tension-scan runs here — overlapSearch is a pure local index query
    // injected by the caller. A missing or throwing overlapSearch degrades to
    // no-hint (claim still stages, original rationale preserved, corroboration 0).
    const { rationale, corroboration } = await buildProposalMeta(claim.statement, overlapSearch);

    const staged = await stageActionWithConflictCheck(vaultRoot, {
      actionType: "write",
      targetPath,
      proposedBy: DISTILL_AGENT,
      rationale,
      // R7 carrier key: corroboration ∈ [0,1]. `proposedDiff` is `unknown` at
      // the staged-action type level, so this extra key is non-breaking; the
      // review-side reader parses it defensively.
      proposedDiff: { frontmatter, body, corroboration },
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
