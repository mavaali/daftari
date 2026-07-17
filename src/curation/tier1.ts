// Tier 1 of tiered compatibility checking (#232) — type-directed dispatch
// over the edge provenance classes, deterministic and LLM-free.
//
// Given a changed unit and the set of fields the change touched, every
// dependent gets a verdict whose CEILING is set by the provenance class of
// the edge that connects it (the 2026-07-17 through-line spec's dispatch
// rule):
//
//   compiled (consumes)      — mechanically certain, so hard verdicts are
//                              licensed: `unaffected` when the change misses
//                              every consumed field, `affected` when it hits.
//   declared (sources)       — a claim, so the positive verdict is only
//                              `possibly-affected`; never a hard hit.
//   earned (derives_from)    — an LLM inference with a decay schedule; it
//                              ROUTES (`semantic-review`, the tier-2 queue)
//                              and never decides.
//
// One certain verdict cuts across all classes: a change that touched nothing
// but server bookkeeping fields is `unaffected` for every dependent — the
// CHANGE side of the judgment is certain even when the edge side is a claim.
//
// An artifact reachable through several classes keeps the highest-certainty
// verdict (compiled > declared > earned): a certain skip beats a claim, and
// a certain hit makes a semantic review redundant.
//
// The #232 acceptance metric falls out of the summary: a change "resolves at
// tier 1" when no dependent needs semantic review — everything was decided
// deterministically.

import type { ConsumesEdge } from "./consumes.js";
import type { ProvenanceEntry } from "./provenance.js";

// Server-stamped bookkeeping — changed on every write, consumed by no one's
// meaning. Never counts as a content change.
export const BOOKKEEPING_FIELDS: ReadonlySet<string> = new Set(["updated", "updated_by"]);

export type Tier1VerdictKind = "unaffected" | "affected" | "possibly-affected" | "semantic-review";
export type Tier1EdgeClass = "compiled" | "declared" | "earned";

export interface Tier1Verdict {
  artifact: string;
  verdict: Tier1VerdictKind;
  edge_class: Tier1EdgeClass;
  reason: string;
}

export interface Tier1Inputs {
  unit: string;
  // Fields the change touched: frontmatter keys plus "body". Bookkeeping
  // fields are filtered here, so callers may pass raw diff keys.
  changedFields: string[];
  // Reverse edges for the unit, one entry per class:
  compiled: ConsumesEdge[]; // current-compile consumes edges (unit side)
  declaredDependents: string[]; // docs whose `sources` cite the unit
  earnedDependents: string[]; // derives_from from-paths with the unit as premise
}

export interface Tier1Summary {
  unaffected: number;
  affected: number;
  possibly_affected: number;
  semantic_review: number;
  // The #232 acceptance predicate: true when the change was fully decided
  // without an LLM — no dependent routed to semantic review.
  resolved_at_tier1: boolean;
}

export function contentChangedFields(fields: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of fields) {
    if (BOOKKEEPING_FIELDS.has(f) || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

// Derives the changed-field set from a provenance entry: the frontmatter
// diff's keys plus "body" when the body changed. An entry from before the
// body_changed flag existed reports body as changed for a content write —
// unknown must over-approximate, never silently skip.
export function changedFieldsFromProvenance(entry: ProvenanceEntry): string[] {
  const fields = Object.keys(entry.frontmatter_diff ?? {});
  const bodyChanged =
    entry.body_changed ??
    (entry.action === "create" || entry.action === "update" || entry.action === "append");
  if (bodyChanged) fields.push("body");
  return contentChangedFields(fields);
}

const CLASS_RANK: Record<Tier1EdgeClass, number> = { compiled: 3, declared: 2, earned: 1 };

export function tier1Dispatch(input: Tier1Inputs): Tier1Verdict[] {
  const changed = contentChangedFields(input.changedFields);
  const noContentChange = changed.length === 0;
  const changedList = changed.join(", ");

  const byArtifact = new Map<string, Tier1Verdict>();
  const put = (v: Tier1Verdict) => {
    const prev = byArtifact.get(v.artifact);
    if (!prev || CLASS_RANK[v.edge_class] > CLASS_RANK[prev.edge_class]) {
      byArtifact.set(v.artifact, v);
    }
  };

  for (const e of input.compiled) {
    if (noContentChange) {
      put({
        artifact: e.artifact,
        verdict: "unaffected",
        edge_class: "compiled",
        reason: "only bookkeeping fields changed",
      });
      continue;
    }
    const consumesAll = e.fields.includes("*");
    const overlap = consumesAll ? changed : e.fields.filter((f) => changed.includes(f));
    if (overlap.length === 0) {
      put({
        artifact: e.artifact,
        verdict: "unaffected",
        edge_class: "compiled",
        reason: `consumed fields [${e.fields.join(", ")}] untouched by change [${changedList}]`,
      });
    } else {
      put({
        artifact: e.artifact,
        verdict: "affected",
        edge_class: "compiled",
        reason: `consumed ${consumesAll ? "the whole doc" : `[${overlap.join(", ")}]`}, which the change touched`,
      });
    }
  }

  for (const artifact of input.declaredDependents) {
    put(
      noContentChange
        ? {
            artifact,
            verdict: "unaffected",
            edge_class: "declared",
            reason: "only bookkeeping fields changed",
          }
        : {
            artifact,
            verdict: "possibly-affected",
            edge_class: "declared",
            reason: `declared sources citation — a claim, so [${changedList}] may or may not matter`,
          },
    );
  }

  for (const artifact of input.earnedDependents) {
    put(
      noContentChange
        ? {
            artifact,
            verdict: "unaffected",
            edge_class: "earned",
            reason: "only bookkeeping fields changed",
          }
        : {
            artifact,
            verdict: "semantic-review",
            edge_class: "earned",
            reason: "earned derives_from edge — routes to semantic review, never a hard verdict",
          },
    );
  }

  return [...byArtifact.values()].sort((a, b) =>
    a.artifact < b.artifact ? -1 : a.artifact > b.artifact ? 1 : 0,
  );
}

export function tier1Summary(verdicts: Tier1Verdict[]): Tier1Summary {
  const counts = { unaffected: 0, affected: 0, possibly_affected: 0, semantic_review: 0 };
  for (const v of verdicts) {
    if (v.verdict === "unaffected") counts.unaffected += 1;
    else if (v.verdict === "affected") counts.affected += 1;
    else if (v.verdict === "possibly-affected") counts.possibly_affected += 1;
    else counts.semantic_review += 1;
  }
  return { ...counts, resolved_at_tier1: counts.semantic_review === 0 };
}
