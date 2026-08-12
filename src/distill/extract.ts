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

const EXTRACT_SYSTEM = `You extract discrete claims from a chat transcript window.

A claim is a decision, commitment, factual statement, or stated preference that
would be worth remembering after the conversation ends. Each claim must be a
single self-contained sentence, understandable without the transcript. Ground
every claim in what participants actually said — do not speculate, do not merge
unrelated points, and return an empty list when the window contains nothing
worth keeping (greetings, logistics chatter, media placeholders).`;

const EXTRACT_SCHEMA = {
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
  return statement.length <= TITLE_MAX ? statement : `${statement.slice(0, TITLE_MAX - 1)}…`;
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

    for (const statement of statements) {
      if (claims.length >= opts.maxClaims) break;
      const key = claimKey(chunk.anchor, statement);
      if (seenKeys.has(key)) continue; // same statement twice in one run
      seenKeys.add(key);
      claims.push({
        claim_key: key,
        statement,
        proposed_frontmatter: { title: titleOf(statement) },
      });
    }
  }

  return { claims, budget_exhausted: budgetExhausted, llmCalls, chunkErrors };
}
