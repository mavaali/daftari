// Four-slice priority partition + drain-under-ceiling (spec §3.3). Pure.
//
//   backstop  — guaranteed (the max-interval cap made real); oldest first.
//   main      — event + decay, ranked fragility × blast (blast = 1 in Stage 1).
//   periphery — reserved, blast-blind, pure staleness — the fairness floor.
//   birth     — reserved, FIFO over the unprocessed-doc queue.
//
// Periphery is taken BEFORE main so a flood of high-fragility main items can't
// swallow the fairness floor (spec §3.3 — the reserved slice is the *full* fix,
// not a mitigation). Backstop is served in full (it borrows, nothing borrows
// from it); backstopOverdueRemaining is nonzero only under total-budget
// starvation, which is exactly the §9 cron-alert condition.

import { EDGE_K_CAP } from "../curation/edges.js";
import type { DueEdge } from "./clocks.js";
import { CONSOLIDATE_SLICE_FRACTIONS } from "./constants.js";

export type Slice = "backstop" | "main" | "periphery" | "birth";
export type QueueItem =
  | { kind: "edge"; fromPath: string; toPath: string; reason: DueEdge["reason"]; slice: Slice }
  | { kind: "birth"; path: string; slice: "birth" };

export interface PrioritizeInput {
  edgeDue: DueEdge[];
  birth: string[];
  budget: number;
  // fromPath → days since last re-derivation (for periphery/backstop staleness ranking).
  ages: Record<string, number>;
}
export interface PrioritizeOutput {
  queue: QueueItem[];
  backstopOverdueRemaining: number;
}

const REASON_RANK: Record<DueEdge["reason"], number> = { backstop: 3, event: 2, decay: 1 };

export function prioritize(input: PrioritizeInput): PrioritizeOutput {
  const { birth, budget, ages } = input;
  const ek = (d: DueEdge) => `${d.fromPath}\n${d.toPath}`;

  // Dedup by the full edge (from,to) — the edge is the review unit (§4); two
  // edges sharing a `from` (a←b and a←c) are distinct work. Keep the strongest
  // reason (backstop > event > decay) when one edge is due for several.
  const best = new Map<string, DueEdge>();
  for (const d of input.edgeDue) {
    const k = ek(d);
    const prev = best.get(k);
    if (!prev || REASON_RANK[d.reason] > REASON_RANK[prev.reason]) best.set(k, d);
  }
  const all = [...best.values()];
  const backstop = all.filter((d) => d.reason === "backstop");
  const nonBackstop = all.filter((d) => d.reason !== "backstop");

  // Slice budgets. A reserved slice with a nonzero fraction yields at least ONE
  // slot whenever the budget is positive — otherwise the periphery fairness floor
  // silently rounds to zero below budget 7 (floor(6·0.15)=0), breaking the §3.3
  // guarantee that the periphery gets nonzero compute every session.
  // NOTE: at budget 1–2 the four caps (each ≥1) sum to >budget, so a single
  // backstop-overdue edge can still consume the whole budget and starve the
  // reserved slices that session. That is acceptable — backstop IS the guarantee,
  // and a per-session budget below the number of reserved slices is degenerate
  // (real budgets are CONSOLIDATE_DEFAULT_BUDGET-scale). The fairness floor holds
  // for any budget ≥ the reserved-slice count.
  const slot = (f: number) => (budget * f > 0 ? Math.max(1, Math.floor(budget * f)) : 0);
  const cap = {
    backstop: slot(CONSOLIDATE_SLICE_FRACTIONS.backstop),
    main: slot(CONSOLIDATE_SLICE_FRACTIONS.main),
    periphery: slot(CONSOLIDATE_SLICE_FRACTIONS.periphery),
    birth: slot(CONSOLIDATE_SLICE_FRACTIONS.birth),
  };

  // Clamp ages at 0: a future-dated lastRederived (clock skew) yields a negative
  // age that would otherwise invert the staleness ranking.
  const ageOf = (p: string) => Math.max(0, ages[p] ?? 0);
  const staleDesc = (a: DueEdge, b: DueEdge) => ageOf(b.fromPath) - ageOf(a.fromPath);
  const fragility = (strength: number) => 1 - Math.min(strength, EDGE_K_CAP) / EDGE_K_CAP;

  // Reserved demand for the protected slices: each reserves only what it will use,
  // so unused reservation flows to main (§3.3.4 "yields its budget to the others").
  const peripherySorted = [...nonBackstop].sort(staleDesc);
  const reservedPeri = Math.min(cap.periphery, peripherySorted.length);
  const reservedBirth = Math.min(cap.birth, birth.length);

  // Allocation (the §3.3 invariants made explicit):
  //   - Backstop BASE (its cap) is the guarantee — served first, oldest first.
  //   - Backstop OVERFLOW (beyond cap) may eat only MAIN's budget (§3.3.1 "force
  //     capacity from the decay slice, never periphery"); it cannot touch the
  //     periphery or birth reserves.
  //   - Backstop demand that even main's budget can't absorb is left UNSERVED and
  //     surfaced as backstopOverdueRemaining → the §9 exit-4 cron alert. Backstop
  //     yields to the reserved fairness/cold-start floors, but loudly, never
  //     silently.
  const bkSorted = [...backstop].sort(staleDesc);
  let remaining = budget;
  const bkBase = Math.min(cap.backstop, bkSorted.length, remaining);
  const bkOverflowRoom = Math.max(0, remaining - bkBase - reservedPeri - reservedBirth);
  const bkOverflow = Math.min(bkSorted.length - bkBase, bkOverflowRoom);
  const backstopServe = bkBase + bkOverflow;
  remaining -= backstopServe;
  const backstopOverdueRemaining = bkSorted.length - backstopServe;

  const servePeri = Math.min(reservedPeri, remaining);
  remaining -= servePeri;

  // Main gets the elastic remainder, but must leave room for the birth reserve.
  const mainSorted = peripherySorted
    .slice(servePeri) // periphery skimmed the stalest `servePeri`; main gets the rest
    .sort(
      (a, b) =>
        REASON_RANK[b.reason] - REASON_RANK[a.reason] ||
        fragility(b.strength) - fragility(a.strength),
    );
  const serveMain = Math.min(mainSorted.length, Math.max(0, remaining - reservedBirth));
  remaining -= serveMain;

  const serveBirth = Math.min(birth.length, remaining);

  const edgeItem = (d: DueEdge, slice: Slice): QueueItem => ({
    kind: "edge",
    fromPath: d.fromPath,
    toPath: d.toPath,
    reason: d.reason,
    slice,
  });
  const queue: QueueItem[] = [
    ...bkSorted.slice(0, backstopServe).map((d) => edgeItem(d, "backstop")),
    ...peripherySorted.slice(0, servePeri).map((d) => edgeItem(d, "periphery")),
    ...mainSorted.slice(0, serveMain).map((d) => edgeItem(d, "main")),
    ...birth
      .slice(0, serveBirth)
      .map((path): QueueItem => ({ kind: "birth", path, slice: "birth" })),
  ];

  return { queue, backstopOverdueRemaining };
}
