// The three session-start clocks (spec §3.1), as pure functions over injected
// edges/docs — no I/O, so they are exhaustively testable with a fixed `now`.
// The I/O wrapper that feeds them is runConsolidate (index.ts).
//
// NOTE (Stage 1 scope): the decay clock keys off edge aged-strength only. The
// spec's TTL-on-docs input (`ttl_days` frontmatter feeding the same clock) is
// deferred to a later stage; it is additive and does not change the edge math.

import { type DerivesFromEdge, EDGE_K_CAP } from "../curation/edges.js";
import {
  CONSOLIDATE_MAX_INTERVAL_DAYS,
  CONSOLIDATE_PATH_STRENGTH_FLOOR,
  reviewIntervalDays,
} from "./constants.js";
import { docContentHash } from "./state.js";

export type DueReason = "backstop" | "decay" | "event";
export interface DueEdge {
  fromPath: string;
  toPath: string;
  strength: number;
  reason: DueReason;
}

const MS_PER_DAY = 86_400_000;
function daysBetween(thenISO: string, now: Date): number {
  return (now.getTime() - new Date(thenISO).getTime()) / MS_PER_DAY;
}

// Decay + backstop clocks. Backstop dominates (it is the guarantee): an edge past
// the max-interval cap is backstop-overdue regardless of strength; otherwise an
// edge past its strength-scaled review interval is decay-due.
export function decayBackstopDue(edges: DerivesFromEdge[], now: Date): DueEdge[] {
  const out: DueEdge[] = [];
  for (const e of edges) {
    if (e.status === "revoked") continue;
    // Clamp at 0: a future-dated lastRederived (clock skew) yields a negative age;
    // either way such an edge is fresh, not due (consistent with priority.ts ageOf).
    const age = Math.max(0, daysBetween(e.lastRederived, now));
    if (age >= CONSOLIDATE_MAX_INTERVAL_DAYS) {
      out.push({
        fromPath: e.fromPath,
        toPath: e.toPath,
        strength: e.strength,
        reason: "backstop",
      });
    } else if (age >= reviewIntervalDays(e.strength)) {
      out.push({ fromPath: e.fromPath, toPath: e.toPath, strength: e.strength, reason: "decay" });
    }
  }
  return out;
}

const edgeKey = (from: string, to: string) => `${from}\n${to}`;

// Event clock: forward walk from changed premises over derives_from edges. An
// edge (from → to) means `from` depends on `to`; a changed `to` makes `from` due.
//
// Attenuation: edge `strength` is the aged value in [0, EDGE_K_CAP] (k·decay), so
// a strong edge has strength > 1 — multiplying raw strengths would *amplify* the
// signal and never hit the floor. We normalize each hop to a factor in [0,1]
// (strength / EDGE_K_CAP): a fully-earned edge passes the change-signal undimmed,
// a weak/aged edge attenuates it. Reach = ∏(factors); a path stops below the
// floor (spec §3.1, C-Q2).
//
// Max-product relaxation: a node can be reached by several paths with different
// products. We keep the BEST (largest) product per node and re-expand when a
// strictly larger product arrives — a plain visited-on-first-touch guard would
// prune a node's descendants using whatever (possibly weaker) path reached it
// first, which is order-dependent and wrongly drops reachable edges. Dedup is by
// the full edge (from,to): two distinct edges sharing a `from` (a←b and a←c) are
// separate review units (§4) and must both surface.
export function eventDue(changedPaths: string[], edges: DerivesFromEdge[]): DueEdge[] {
  const byPremise = new Map<string, DerivesFromEdge[]>();
  for (const e of edges) {
    if (e.status === "revoked") continue;
    const list = byPremise.get(e.toPath) ?? [];
    list.push(e);
    byPremise.set(e.toPath, list);
  }
  const due = new Map<string, DueEdge>();
  const bestProduct = new Map<string, number>();
  const queue: Array<{ path: string; product: number }> = [];
  for (const p of changedPaths) {
    if ((bestProduct.get(p) ?? -1) < 1) {
      bestProduct.set(p, 1);
      queue.push({ path: p, product: 1 });
    }
  }
  // Hard stop: products only decrease (factors ≤ 1) and we re-enqueue only on
  // strict improvement, so this converges; the cap is a defensive backstop.
  const maxExpansions = edges.length * edges.length + edges.length + changedPaths.length + 16;
  let head = 0;
  let expansions = 0;
  while (head < queue.length && expansions < maxExpansions) {
    const item = queue[head++];
    if (!item) break;
    expansions += 1;
    if (item.product < (bestProduct.get(item.path) ?? 0)) continue; // stale entry
    for (const e of byPremise.get(item.path) ?? []) {
      const factor = Math.min(Math.max(e.strength / EDGE_K_CAP, 0), 1);
      const carried = item.product * factor;
      if (carried < CONSOLIDATE_PATH_STRENGTH_FLOOR) continue; // signal faded
      const key = edgeKey(e.fromPath, e.toPath);
      if (!due.has(key)) {
        due.set(key, {
          fromPath: e.fromPath,
          toPath: e.toPath,
          strength: e.strength,
          reason: "event",
        });
      }
      if (carried > (bestProduct.get(e.fromPath) ?? 0)) {
        bestProduct.set(e.fromPath, carried);
        queue.push({ path: e.fromPath, product: carried });
      }
    }
  }
  return [...due.values()];
}

// Birth queue: docs never processed, or whose content changed since (edited ⇒
// re-birth, spec §4.0). Stage 1 only computes this; it never marks anything
// processed (no births are executed — that is Stage 2).
export function birthQueue(
  docs: Array<{ relPath: string; content: string }>,
  birthProcessed: Record<string, string>,
): string[] {
  return docs
    .filter((d) => birthProcessed[d.relPath] !== docContentHash(d.content))
    .map((d) => d.relPath);
}
