// Provisional scheduler constants. EVERY value here is a calibration target
// (spec §10 — calibrate from shadow data); the loop runs on these placeholders
// until Stage 5. Single-sourced + exported so calibration has one home, mirroring
// EDGE_* / SHADOW_* in the curation layer.

// Review interval f(aged strength): MIN · 2^strength, hard-capped by MAX (the
// max-interval backstop — nothing rests longer than this without re-derivation).
export const CONSOLIDATE_MIN_INTERVAL_DAYS = 1;
export const CONSOLIDATE_MAX_INTERVAL_DAYS = 90; // aligns with EDGE_HALF_LIFE_DAYS

export function reviewIntervalDays(strength: number): number {
  const grown = CONSOLIDATE_MIN_INTERVAL_DAYS * 2 ** Math.max(0, strength);
  return Math.min(grown, CONSOLIDATE_MAX_INTERVAL_DAYS);
}

// Event-blast attenuation: a forward path's reach = ∏(edge strengths); it stops
// where the product drops below this floor (spec §3.1, C-Q2).
export const CONSOLIDATE_PATH_STRENGTH_FLOOR = 0.1;

// Compute-budget partition (spec §3.3). Fractions of the per-session budget.
// backstop is GUARANTEED; periphery is blast-blind fairness; birth is one-time
// cold-start population. Provisional — tuned against B coverage metrics (§6.2).
export const CONSOLIDATE_SLICE_FRACTIONS = {
  backstop: 0.25,
  main: 0.45,
  periphery: 0.15,
  birth: 0.15,
} as const;

// Stage 1 has no LLM calls, so "budget" = max queue items emitted per session.
// With Component A (Stage 2) this becomes the re-derivation-call cap.
export const CONSOLIDATE_DEFAULT_BUDGET = 50;

// --- Stage 2 (Component A) ----------------------------------------------------

// Panel size M: votes cast per due edge per session (spec §4.1, brief item 2).
// Starting M=2 — provisional, TBD — calibrate from shadow data.
export const CONSOLIDATE_PANEL_SIZE = 2;

// Birth-mode neighbor retrieval: top-K embedding neighbors per unprocessed doc
// (spec §4.0). 20 = the K in the §10.2 recall@20 kill condition.
export const CONSOLIDATE_BIRTH_TOP_K = 20;

// Default LLM model for re-derivation. Haiku 4.5 — cheapest tier where the
// task is "detect derivation," not "subtle reasoning." Override via the
// DAFTARI_CONSOLIDATE_MODEL env var when calibrating against bigger models.
export const CONSOLIDATE_DEFAULT_MODEL = "claude-haiku-4-5-20251001";

// The agent principal Stage 2 attributes its writes to (spec §8). The server
// is started as `--user agent:curation-loop --role curation-loop`; this string
// is the free-text `agent` claim on edge_observe/contest (the authenticated
// principal is recorded separately by the shadow path).
export const CONSOLIDATE_AGENT = "agent:curation-loop";

// Prompt-framing axis (v1 = the only varied axis, see brief item 3). Three
// deterministic templates that re-derive the same edge claim from different
// directions. Each template is independent of the others by *framing*, not
// by model or input — whether that is enough to decorrelate votes is the
// load-bearing question the decorrelation report (brief item 8) decides.
export const CONSOLIDATE_PROMPT_TEMPLATES = ["forward", "reverse", "contrast"] as const;
export type ConsolidatePromptTemplate = (typeof CONSOLIDATE_PROMPT_TEMPLATES)[number];

// Decorrelation lift (brief item 8 / spec §10.2). `majority_accuracy −
// max(single_vote_accuracy)`. Retained as an informational metric: under the
// foundational-ordering prompt (which replaced the prompt-framing axes) the
// axes send an identical deterministic prompt, so lift is ~0 by construction —
// confirming the axes no longer decorrelate, the verdict doc's conclusion.
export const CONSOLIDATE_DECORRELATION_MIN_LIFT = 0.05;

// The report's PASS gate is now ACCURACY, not lift (spec §5 — it measures the
// foundational prompt's direction-recovery accuracy on the fixture). Matches the
// real-prose gate's 85% directional kill condition.
export const CONSOLIDATE_DIRECTION_MIN_ACCURACY = 0.85;

// LLM pricing — USD per million tokens, current as of 2026-06-16 for
// claude-haiku-4-5-20251001. VERIFY against current pricing before reading the
// cost-USD figure as gospel; this table is a recoverable mistake (the raw
// token counts ARE logged into the shadow journal, so historical sessions can
// be re-costed when prices move). Override per-model via the table; unknown
// models fall back to Haiku pricing with a flag in the report.
export const CONSOLIDATE_PRICING_PER_MTOKEN: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-opus-4-8": { input: 15.0, output: 75.0 },
  // OpenRouter slug for the same Haiku model (passthrough pricing).
  "anthropic/claude-haiku-4.5": { input: 1.0, output: 5.0 },
};

// Default model on the openrouter transport — the same Haiku the anthropic
// default resolves to, addressed by its OpenRouter slug.
export const CONSOLIDATE_DEFAULT_MODEL_OPENROUTER = "anthropic/claude-haiku-4.5";

// True when the model has its own pricing row (vs falling back to Haiku rates).
export function isModelPriced(model: string): boolean {
  return Object.hasOwn(CONSOLIDATE_PRICING_PER_MTOKEN, model);
}

export function estimateCostUSD(model: string, inputTokens: number, outputTokens: number): number {
  const p =
    CONSOLIDATE_PRICING_PER_MTOKEN[model] ??
    CONSOLIDATE_PRICING_PER_MTOKEN["claude-haiku-4-5-20251001"];
  // Clamp negatives: a bad token count must not produce a negative "cost".
  const inTok = Math.max(0, inputTokens);
  const outTok = Math.max(0, outputTokens);
  return (inTok * p.input + outTok * p.output) / 1_000_000;
}
