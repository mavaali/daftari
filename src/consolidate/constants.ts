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
