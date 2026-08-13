// src/distill/cost.ts
//
// Pre-flight cost estimation (--plan) and per-run receipt recording (--propose)
// for the distill pipeline. No LLM calls are made here — estimation is purely
// arithmetic over chunk metadata and config values.
//
// Design decisions recorded here (referenced in U6 task report):
//
// TOKEN HEURISTIC (pre-flight only):
//   Input tokens per call  ≈ min(chunkTextChars, inCallInputCap) / CHARS_PER_TOKEN
//   Output tokens per call ≈ CLAIMS_PER_CHUNK_ESTIMATE * OUTPUT_TOKENS_PER_CLAIM
//   CHARS_PER_TOKEN = 4 (conservative; English prose is ~4 chars/token).
//   CLAIMS_PER_CHUNK_ESTIMATE = 5 (a mid-range guess for a 30-message window).
//   OUTPUT_TOKENS_PER_CLAIM  = 30 (a single-sentence claim, ~20-40 tokens).
//   These are documented estimates, not calibrated values. Label: [HYPOTHESIS].
//   The actual token counts are not collected here (the LLM client returns them
//   in CompleteResult, but U3's extractClaims doesn't surface them through
//   ExtractOutcome). The receipt therefore uses the same heuristic for
//   actualCostUSD — see ACTUAL COST NOTE below.
//
// ZDR (zero-data-retention) FLAG:
//   Recorded as an explicit caller-supplied boolean, default false.
//   ZDR eligibility is account- and endpoint-specific, not transport-specific.
//   An `anthropic` transport does NOT automatically mean ZDR — it depends on
//   whether the caller's Anthropic account has ZDR enabled. Making it inferred
//   would silently overstate a privacy guarantee. The CLI (U7) passes it
//   explicitly; the receipt preserves whatever the caller asserts.
//
// TRUNCATION SIGNAL:
//   `truncated` is true when claimsProduced >= maxClaims OR budget_exhausted.
//   ExtractOutcome.budget_exhausted is a first-class signal from withCallBudget.
//   claimsProduced >= maxClaims covers the maxClaims-wall case (extract stops
//   at the cap; the LLM budget may not be spent). Both cases mean the run did
//   not see all chunks, so the downstream vault write is a partial import.
//
// ACTUAL COST NOTE:
//   ExtractOutcome does not carry per-call token counts (they are consumed
//   inside extractClaims but not threaded out). actualCostUSD therefore uses
//   the same per-call heuristic as the pre-flight estimate, scaled by the
//   actual llmCalls count. This is consistent with the estimate and is clearly
//   labeled an approximation. A future slice could add token tracking to
//   ExtractOutcome and replace the heuristic with real numbers.
//
// BUDGET ENFORCEMENT:
//   Hard caps (maxLlmCalls via withCallBudget, maxClaims inside extractClaims)
//   are enforced by U2/U3. This module RECORDS the actuals from ExtractOutcome
//   and ESTIMATES for pre-flight; it does not duplicate the cap logic.

import { randomUUID } from "node:crypto";
import { estimateCostUSD, isModelPriced } from "../consolidate/constants.js";
import type { LlmClient } from "../eval/llm.js";
import type { DistillConfig } from "../utils/config.js";
import type { Chunk } from "./chunk.js";
import type { ExtractOutcome } from "./extract.js";

// ---------------------------------------------------------------------------
// Token estimation constants (pre-flight heuristic)
// ---------------------------------------------------------------------------

/**
 * Conservative chars-per-token ratio for English prose.
 * 4 chars/token is the standard rule of thumb; actual ratio for chat
 * transcripts is typically 3.5–4.5. Using 4 avoids underestimating cost.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Estimated claims extracted per 30-message chunk — mid-range guess.
 * Used only for output-token estimation in the pre-flight plan.
 */
const CLAIMS_PER_CHUNK_ESTIMATE = 5;

/**
 * Estimated output tokens per extracted claim (a short self-contained sentence
 * serialized as JSON). 30 tokens ≈ a 20–40 token range midpoint.
 */
const OUTPUT_TOKENS_PER_CLAIM = 30;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Pre-flight estimate returned by `planDistill`. No LLM calls made.
 * All cost figures are labeled estimates; see the token heuristic note above.
 */
export interface DistillPlan {
  /** Number of chunks the source was split into. */
  chunkCount: number;
  /**
   * Estimated LLM calls: min(chunkCount, config.maxLlmCalls).
   * The actual call count may be lower if maxClaims is hit first.
   */
  estimatedLlmCalls: number;
  /**
   * Estimated USD spend, derived from the token heuristic.
   * Falls back to Haiku pricing for unknown models (same as estimateCostUSD).
   */
  estimatedCostUSD: number;
  /** Model id from config — the same model every extraction call will use. */
  model: string;
  /**
   * True when the model has its own pricing row in CONSOLIDATE_PRICING_PER_MTOKEN.
   * False means the estimate uses Haiku fallback pricing — treat with extra caution.
   */
  priced: boolean;
}

/** Input options for `buildReceipt`. */
export interface BuildReceiptOpts {
  /** The outcome from a completed extractClaims run. */
  outcome: ExtractOutcome;
  /** The distill config that governed this run. */
  config: DistillConfig;
  /**
   * Transport that made the LLM calls: "anthropic" | "openrouter".
   * Passed explicitly by the CLI (U7) from resolveDistillClient's transport.
   */
  provider: "anthropic" | "openrouter";
  /**
   * Zero-data-retention flag. Must be supplied explicitly by the caller —
   * never inferred from provider. See ZDR design note at the top of this file.
   * Default: false.
   */
  zdr: boolean;
  /** Optional source identifier (file path, channel id, etc.). */
  sourceId?: string;
}

/**
 * Per-run receipt recording actuals after a `--propose` run.
 * Persisted by the CLI (U7) so cost and provenance survive across sessions.
 */
export interface DistillReceipt {
  /** Unique identifier for this run (random UUID). */
  runId: string;
  /** Optional source that was distilled. */
  sourceId?: string;
  /** Model id used for every extraction call. */
  model: string;
  /** LLM transport used. */
  provider: "anthropic" | "openrouter";
  /**
   * Whether this run was made under a zero-data-retention arrangement.
   * This is caller-asserted, not verified by daftari. Default: false.
   */
  zdr: boolean;
  /** Total LLM calls attempted (from ExtractOutcome.llmCalls). */
  llmCalls: number;
  /** Number of claims produced (claims.length from ExtractOutcome). */
  claimsProduced: number;
  /**
   * True when the run was cut short — either:
   *   - claimsProduced >= config.maxClaims (maxClaims wall hit), OR
   *   - budget_exhausted (withCallBudget cut the run).
   * Both cases mean downstream vault writes are a partial import.
   */
  truncated: boolean;
  /**
   * Approximate USD cost. Uses the same per-call token heuristic as the
   * pre-flight estimate, scaled by actual llmCalls. See ACTUAL COST NOTE.
   */
  actualCostUSD: number;
  /** ISO 8601 timestamp when buildReceipt was called. */
  completedAt: string;
}

// ---------------------------------------------------------------------------
// planDistill — pre-flight estimate, zero LLM spend
// ---------------------------------------------------------------------------

/**
 * Compute a pre-flight estimate for a distill run.
 *
 * IMPORTANT: this function is pure (no async, no network). The `_llm` param
 * is accepted only so the caller can pass a spy/fake in tests and confirm it
 * was never invoked. Production callers may pass undefined or any LlmClient;
 * neither path results in a call.
 *
 * @param chunks   - Pre-computed chunks from chunkMessages().
 * @param config   - DistillConfig for this vault.
 * @param _llm     - Accepted but never called. Pass a throw-on-call spy in tests.
 */
export function planDistill(
  chunks: Chunk[],
  config: DistillConfig,
  // _llm is accepted but never called — the leading underscore tells both
  // TypeScript and Biome that this is intentionally unused. Callers pass a
  // throw-on-call spy in tests to assert zero LLM spend.
  _llm: LlmClient,
): DistillPlan {
  const chunkCount = chunks.length;

  if (chunkCount === 0) {
    return {
      chunkCount: 0,
      estimatedLlmCalls: 0,
      estimatedCostUSD: 0,
      model: config.model,
      priced: isModelPriced(config.model),
    };
  }

  const estimatedLlmCalls = Math.min(chunkCount, config.maxLlmCalls);

  // Per-call input token estimate: chars of transcript fed to the LLM, capped
  // by inCallInputCap, then divided by CHARS_PER_TOKEN. We use the average
  // chunk text length, bounded by the cap.
  const totalChunkChars = chunks.reduce((sum, c) => sum + c.text.length, 0);
  const avgChunkChars = totalChunkChars / chunkCount;
  const inputCharsPerCall = Math.min(avgChunkChars, config.inCallInputCap);
  const inputTokensPerCall = Math.ceil(inputCharsPerCall / CHARS_PER_TOKEN);

  // Per-call output token estimate: a fixed guess at claims per chunk * tokens
  // per claim, bounded by the total maxClaims cap spread over the estimated
  // number of calls.
  const maxClaimsPerCall = Math.ceil(config.maxClaims / estimatedLlmCalls);
  const outputTokensPerCall = Math.min(
    CLAIMS_PER_CHUNK_ESTIMATE * OUTPUT_TOKENS_PER_CLAIM,
    maxClaimsPerCall * OUTPUT_TOKENS_PER_CLAIM,
  );

  const totalInputTokens = inputTokensPerCall * estimatedLlmCalls;
  const totalOutputTokens = outputTokensPerCall * estimatedLlmCalls;

  const estimatedCostUSD = estimateCostUSD(config.model, totalInputTokens, totalOutputTokens);

  return {
    chunkCount,
    estimatedLlmCalls,
    estimatedCostUSD,
    model: config.model,
    priced: isModelPriced(config.model),
  };
}

// ---------------------------------------------------------------------------
// buildReceipt — record actuals after a --propose run
// ---------------------------------------------------------------------------

/**
 * Build a `DistillReceipt` from the outcome of a completed extractClaims run.
 *
 * Call this after `extractClaims` returns, passing the full ExtractOutcome
 * and the runtime context (provider, zdr, config). The CLI (U7) persists the
 * receipt; this function only constructs it.
 */
export function buildReceipt(opts: BuildReceiptOpts): DistillReceipt {
  const { outcome, config, provider, zdr, sourceId } = opts;

  const claimsProduced = outcome.claims.length;

  // Truncation: the run was partial if the claim cap was hit OR the LLM call
  // budget was exhausted. See TRUNCATION SIGNAL design note.
  const truncated = outcome.budget_exhausted || claimsProduced >= config.maxClaims;

  // Actual cost: token heuristic applied to the real llmCalls count.
  // We don't have real token counts from ExtractOutcome (see ACTUAL COST NOTE).
  const actualCostUSD = costFromLlmCalls(outcome.llmCalls, config);

  return {
    runId: randomUUID(),
    ...(sourceId !== undefined ? { sourceId } : {}),
    model: config.model,
    provider,
    zdr,
    llmCalls: outcome.llmCalls,
    claimsProduced,
    truncated,
    actualCostUSD,
    completedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Estimate the cost of `n` actual LLM calls using the same per-call heuristic
 * as planDistill, but with the inCallInputCap as the assumed input size (a
 * conservative upper bound — actual inputs may be shorter).
 *
 * This is intentionally the same formula as planDistill so the estimate and
 * the receipt are directly comparable. When token counts become available from
 * ExtractOutcome, replace `inputTokensPerCall` with the real value.
 */
function costFromLlmCalls(llmCalls: number, config: DistillConfig): number {
  if (llmCalls === 0) return 0;

  // Conservative: assume every call hit the full inCallInputCap.
  const inputTokensPerCall = Math.ceil(config.inCallInputCap / CHARS_PER_TOKEN);
  const outputTokensPerCall = CLAIMS_PER_CHUNK_ESTIMATE * OUTPUT_TOKENS_PER_CLAIM;

  return estimateCostUSD(
    config.model,
    inputTokensPerCall * llmCalls,
    outputTokensPerCall * llmCalls,
  );
}
