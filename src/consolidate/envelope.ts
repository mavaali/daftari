// The two-gate envelope (spec §5). PURE: callers assemble the context (I/O lives
// in the CLI's makeAdmit, a later task). An action is admitted iff BOTH the
// invariants gate AND the trust-budget gate pass. Gated actions surface (later
// tasks); they do NOT spend (deduct-on-admit happens in the caller).

export type EnvelopeActionType = "edge-observe" | "edge-contest";

// Actions A is allowed to take that do NOT delete (never-delete invariant).
const NON_DELETING_ACTIONS: ReadonlySet<EnvelopeActionType> = new Set([
  "edge-observe",
  "edge-contest",
]);

export interface EndpointState {
  path: string;
  // provenance-required: false ⇒ unknown/broken metadata ⇒ refuse.
  provenanceKnown: boolean;
  // premise-freshness: true when computeDecay returns level "warn" or "deprecated".
  // Level "aging" is NOT blocking (the scarcity rule: a doc can still accrue edges
  // after aging past its freshness target — only formal staleness blocks).
  decayBlocking: boolean;
  // tension-respect: true ⇒ an unresolved tension touches this endpoint ⇒ refuse.
  hasUnresolvedTension: boolean;
}

export interface EnvelopeCtx {
  action: EnvelopeActionType;
  endpoints: EndpointState[]; // [from, to]
  impact: number; // I, precomputed via shadowImpact
  budget: number; // B0, precomputed via shadowBudget
}

export interface EnvelopeVerdict {
  admit: boolean;
  gate: "invariants" | "budget" | null; // which gate refused; null when admitted
  reason: string;
  impact: number; // echoed so the caller deducts the right amount on admit
}

export function evaluateEnvelope(ctx: EnvelopeCtx, spent: number): EnvelopeVerdict {
  // --- Invariants gate (first; §5.1) ---
  //
  // Precondition failures (malformed context, non-finite/negative numerics) are
  // folded into the invariants gate because the correct behaviour is identical:
  // refuse, never spend. A separate gate variant isn't worth rippling through the
  // journal for inputs that are unreachable when metrics are computed normally.
  // The reason string carries the specific signal for any journal reader.

  // Precondition: callers must supply exactly 2 endpoints ([from, to]).
  if (ctx.endpoints.length < 2) {
    return {
      admit: false,
      gate: "invariants",
      reason: `precondition: expected 2 endpoints (from, to), got ${ctx.endpoints.length}`,
      impact: ctx.impact,
    };
  }

  // Precondition: callers must supply finite, non-negative numeric values.
  // NaN/Infinity would silently corrupt the budget comparison.
  if (
    !Number.isFinite(ctx.impact) ||
    !Number.isFinite(ctx.budget) ||
    !Number.isFinite(spent) ||
    ctx.impact < 0 ||
    ctx.budget < 0 ||
    spent < 0
  ) {
    return {
      admit: false,
      gate: "invariants",
      reason: `precondition: non-finite or negative numeric input (impact/budget/spent)`,
      impact: ctx.impact,
    };
  }

  // never-delete (defensive assert).
  if (!NON_DELETING_ACTIONS.has(ctx.action)) {
    return {
      admit: false,
      gate: "invariants",
      reason: `never-delete: action '${ctx.action}' is not permitted`,
      impact: ctx.impact,
    };
  }
  // Per-endpoint checks run in spec §5.1 priority order:
  // 1. provenance-required  2. premise-freshness (decayBlocking)  3. tension-respect
  for (const ep of ctx.endpoints) {
    if (!ep.provenanceKnown) {
      return {
        admit: false,
        gate: "invariants",
        reason: `provenance-required: ${ep.path} has unknown/broken provenance`,
        impact: ctx.impact,
      };
    }
    if (ep.decayBlocking) {
      return {
        admit: false,
        gate: "invariants",
        reason: `premise-freshness: ${ep.path} is stale/deprecated`,
        impact: ctx.impact,
      };
    }
    if (ep.hasUnresolvedTension) {
      return {
        admit: false,
        gate: "invariants",
        reason: `tension-respect: ${ep.path} has an unresolved tension`,
        impact: ctx.impact,
      };
    }
  }
  // --- Trust-budget gate (§5.2; strict > matches shadow.ts would_gate) ---
  if (spent + ctx.impact > ctx.budget) {
    return {
      admit: false,
      gate: "budget",
      reason: `trust-budget exhausted: spent ${spent.toFixed(3)} + I ${ctx.impact.toFixed(3)} > B0 ${ctx.budget.toFixed(3)}`,
      impact: ctx.impact,
    };
  }
  return { admit: true, gate: null, reason: "admitted", impact: ctx.impact };
}
