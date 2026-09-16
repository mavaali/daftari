// src/distill/extract.ts
//
// Claim extraction (U3, distill stage 3). For each chunk, one budgeted
// `completeJson` call asks the internal LLM for discrete claims (decisions,
// facts, commitments). The caller supplies the client already wrapped in
// `withCallBudget` (see src/consolidate/call-budget.ts); when the budget is
// exhausted mid-run this stage returns the partial claim set with a
// `budget_exhausted: true` marker — it never throws.
//
// claim_key contract (load-bearing for U5's idempotent upsert): derived
// deterministically from the chunk's stable content anchor + a slug + short
// hash of the claim statement. Same source + same LLM output ⇒ same keys on
// a re-run. Never an ordinal, array index, or random value.

import { isBudgetExhaustedError } from "../consolidate/call-budget.js";
import type { LlmClient } from "../eval/llm.js";
import { sha256Hex } from "../utils/hash.js";
import type { Chunk } from "./chunk.js";

// --- public surface ----------------------------------------------------------

/**
 * Per-claim LLM extraction run metadata (6mf.6). Attached to every claim by
 * the producing chunk's `completeJson` call, so a later bead (f3h) can stamp
 * each emitted belief with the run that compiled it.
 *
 * Optional on ExtractedClaim and every field carries its own source's value —
 * two claims from different chunks may carry different metadata (e.g. one chunk
 * salvaged via retry at temp 0.2, another a clean first-try at 0). Additive and
 * consumed by nothing in this bead: propose.ts only needs to be able to READ
 * it; it does NOT yet write frontmatter from it.
 */
export interface ClaimRunMeta {
  /** Model the provider actually served (distinct from requestedModel). */
  servedModel?: string;
  /** Temperature actually sent for the producing call (0.2 iff salvaged via retry). */
  effectiveTemperature?: number;
  /** True iff the producing call went through completeJsonWithRetry's retry branch. */
  viaRetry?: boolean;
  /** The model this run requested (ExtractOpts.model). */
  requestedModel: string;
  /** Number of messages in the producing chunk's window. */
  chunkWindow: number;
  /** The per-call input character cap in effect for this run (ExtractOpts.inCallInputCap). */
  inputCap: number;
}

/** One extracted claim, keyed for idempotent upsert (U5). */
export interface ExtractedClaim {
  /** Stable within-source key: `<chunk anchor>:<statement slug>-<hash8>`. */
  claim_key: string;
  /** The claim itself, as a self-contained sentence. */
  statement: string;
  /**
   * Minimal frontmatter seed; the proposal stage (U4) completes it. Only a
   * title here by design — do not grow this into the full staged-action.
   */
  proposed_frontmatter: { title: string };
  /**
   * Optional per-claim LLM extraction run metadata (6mf.6). Populated by
   * extractClaims from the producing chunk's call; flows unchanged through the
   * upsert join into proposeAllClaims' inputs so a later bead can stamp it.
   * Optional so every existing constructor / mock stays valid.
   */
  run_meta?: ClaimRunMeta;
}

export interface ExtractOutcome {
  claims: ExtractedClaim[];
  /** True when withCallBudget cut the run short — claims are partial. */
  budget_exhausted: boolean;
  /** LLM calls attempted (including the one refused by the budget). */
  llmCalls: number;
  /** Per-chunk non-budget failures (LLM error or unusable response shape). */
  chunkErrors: Array<{ anchor: string; error: string }>;
}

export interface ExtractOpts {
  /** Model id for every extraction call. */
  model: string;
  /** Hard cap on total claims this run may produce (truncate + stop). */
  maxClaims: number;
  /** Max characters of rendered transcript per call (bounds token spend). */
  inCallInputCap: number;
}

// --- prompt ------------------------------------------------------------------

// Exported so the reader-provenance fingerprint (src/distill/reader-fingerprint.ts)
// can hash the EFFECTIVE extraction prompt contract — a change to this system
// text revs reader_prompt_version. Do not inline this back to a bare const.
export const EXTRACT_SYSTEM = `You extract discrete claims from a chat transcript window.

A claim is a decision, commitment, factual statement, or stated preference that
would be worth remembering after the conversation ends. Each claim must be a
single self-contained sentence, understandable without the transcript. Ground
every claim in what participants actually said — do not speculate, do not merge
unrelated points, and return an empty list when the window contains nothing
worth keeping (greetings, logistics chatter, media placeholders).

Paraphrase in your own words by default: a claim is a compiled belief, not a
transcript excerpt. Do not copy long verbatim spans from the window. If a short
exact quote is genuinely necessary, keep it brief and enclose only the quoted
words in double quotes.`;

// Exported alongside EXTRACT_SYSTEM: this schema object is what llm.ts's
// completeJsonWithRetry injects verbatim into the system prompt
// (`Return JSON matching:\n${JSON.stringify(opts.schema, null, 2)}`), so it is
// part of the effective prompt contract the reader fingerprint hashes. A schema
// change here revs reader_prompt_version.
export const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          statement: { type: "string", description: "One self-contained claim sentence." },
        },
        required: ["statement"],
      },
    },
  },
  required: ["claims"],
} as const;

function extractUserBody(chunk: Chunk, inputCap: number): string {
  const transcript = chunk.text.length <= inputCap ? chunk.text : chunk.text.slice(0, inputCap);
  return `Transcript window (starts ${chunk.firstTs}):\n\n${transcript}`;
}

// --- claim_key derivation ----------------------------------------------------

// Lowercased, hyphen-separated slug of the statement, capped so keys stay
// short. Truncation collisions are disambiguated by the hash suffix below.
const SLUG_MAX = 48;
function slugify(statement: string): string {
  const slug = statement
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "claim";
}

function claimKey(anchor: string, statement: string): string {
  return `${anchor}:${slugify(statement)}-${sha256Hex(statement).slice(0, 8)}`;
}

// --- response parsing --------------------------------------------------------

// Pull usable statements out of the parsed LLM response. Malformed entries
// (non-object, missing/empty statement) are skipped, mirroring the adapter
// posture: never throw on bad model output. A response whose top-level shape
// is unusable returns err so the chunk is recorded as failed.
function parseStatements(parsed: unknown): string[] | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const claims = (parsed as { claims?: unknown }).claims;
  if (!Array.isArray(claims)) return null;
  const out: string[] = [];
  for (const entry of claims) {
    if (typeof entry !== "object" || entry === null) continue;
    const statement = (entry as { statement?: unknown }).statement;
    if (typeof statement !== "string") continue;
    const trimmed = statement.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

const TITLE_MAX = 80;
function titleOf(statement: string): string {
  if (statement.length <= TITLE_MAX) return statement;
  // Find the last space at or before TITLE_MAX to break on a word boundary.
  const lastSpace = statement.lastIndexOf(" ", TITLE_MAX);
  if (lastSpace > 0) return statement.slice(0, lastSpace);
  // No space found before TITLE_MAX (first word exceeds limit) — hard-cut.
  return statement.slice(0, TITLE_MAX);
}

// --- extraction pass ---------------------------------------------------------

/**
 * Extract claims from `chunks` — one LLM call per chunk, stopping early when
 * `maxClaims` is reached or the call budget is exhausted. `llm` should be the
 * resolveDistillClient client wrapped in `withCallBudget(client, maxLlmCalls)`.
 * Never throws; per-chunk failures land in `chunkErrors`.
 */
export async function extractClaims(
  chunks: Chunk[],
  llm: LlmClient,
  opts: ExtractOpts,
): Promise<ExtractOutcome> {
  const claims: ExtractedClaim[] = [];
  const seenKeys = new Set<string>();
  const chunkErrors: ExtractOutcome["chunkErrors"] = [];
  let budgetExhausted = false;
  let llmCalls = 0;

  for (const chunk of chunks) {
    if (claims.length >= opts.maxClaims) break;

    const res = await llm.completeJson({
      model: opts.model,
      system: EXTRACT_SYSTEM,
      user: extractUserBody(chunk, opts.inCallInputCap),
      schema: EXTRACT_SCHEMA,
      temperature: 0,
    });
    llmCalls++;

    if (!res.ok) {
      if (isBudgetExhaustedError(res.error)) {
        // Budget spent: stop cleanly with whatever we have. withCallBudget
        // already guarantees no network call happened for this chunk.
        budgetExhausted = true;
        break;
      }
      chunkErrors.push({ anchor: chunk.anchor, error: res.error.message });
      continue;
    }

    const statements = parseStatements(res.value.parsed);
    if (statements === null) {
      chunkErrors.push({
        anchor: chunk.anchor,
        error: `unusable response shape: ${res.value.text.slice(0, 120)}`,
      });
      continue;
    }

    // 6mf.6: capture the producing call's run metadata once per chunk and
    // attach it to every claim this chunk produced. servedModel /
    // effectiveTemperature / viaRetry come off the CompleteJsonResult (undefined
    // on mocks that don't set them); requestedModel / chunkWindow / inputCap are
    // the run's own knobs.
    const runMeta: ClaimRunMeta = {
      servedModel: res.value.servedModel,
      effectiveTemperature: res.value.effectiveTemperature,
      viaRetry: res.value.viaRetry,
      requestedModel: opts.model,
      chunkWindow: chunk.endIndex - chunk.startIndex + 1,
      inputCap: opts.inCallInputCap,
    };

    for (const statement of statements) {
      if (claims.length >= opts.maxClaims) break;
      const key = claimKey(chunk.anchor, statement);
      if (seenKeys.has(key)) continue; // same statement twice in one run
      seenKeys.add(key);
      claims.push({
        claim_key: key,
        statement,
        proposed_frontmatter: { title: titleOf(statement) },
        run_meta: runMeta,
      });
    }
  }

  return { claims, budget_exhausted: budgetExhausted, llmCalls, chunkErrors };
}
