// Edge staleness (#234) — per-edge upstream-change compatibility, derived
// from tier-1 verdicts (#232) over the edge provenance classes (#233).
//
// This is deliberately the THIRD staleness vocabulary in the tree, scoped
// against the two that already exist rather than replacing them:
//
//   - TTL decay (staleness.ts): time-based confidence of the DOCUMENT
//     ITSELF — "this doc is old", regardless of what it depends on.
//   - Audit staleness (audit/checks/staleness.ts): mtime ordering along the
//     link graph, CI-gated — "this doc is older than something it links to".
//   - Edge staleness (this module): "this ARTIFACT is stale WITH RESPECT TO
//     a specific upstream unit, and here is what the tiers say about the
//     pending change." Never a global freshness score.
//
// Classes, not a boolean (#234's core design point):
//
//   current            — upstream unchanged since the edge's baseline.
//   pending-compatible — upstream changed, tier 1 certified the change
//                        misses this dependent (cosmetic staleness).
//   pending-broken     — upstream changed and tier 1 issued a hard hit;
//                        reads of the artifact serve known-wrong context.
//                        Only this class is an incident.
//   pending-unchecked  — upstream changed but the structure cannot decide
//                        (declared claim / earned inference — the tier-2
//                        residual), or the edge has no baseline to measure
//                        from. Awaiting a judgment no cheap tier can give.
//
// Because tier 1 is deterministic and free, classification RUNS AT QUERY
// TIME — there is no verdict store that can itself go stale. "Reading tier
// verdicts" (the issue's phrasing) means running the SAME dispatch the
// vault_tier1 tool runs — classifyEdge delegates to tier1Dispatch, so the
// verdict semantics (field overlap, bookkeeping, class ceilings) cannot
// drift between the two surfaces. The dispatch rule carries over exactly:
// only a compiled edge can make pending-broken (a hard verdict needs
// mechanical certainty); declared and earned changes park in
// pending-unchecked until tier 2 exists.
//
// Baselines per class:
//   compiled — the edge's compile_ts: the instant the run's snapshot of the
//              unit became the artifact's input.
//   declared — the artifact's own latest logged write: the last moment the
//              author could have seen the cited unit. No provenance for the
//              artifact → no baseline → pending-unchecked (never checked).
//   earned   — the edge's lastRederived: the last time the derivation
//              survived a re-test.

import { type ConsumesEdge, forwardConsumes, listConsumesEdges } from "./consumes.js";
import { type ProvenanceEntry, readProvenanceLog } from "./provenance.js";
import { bucketHiddenDownstream, type HiddenDownstream } from "./tension-blast.js";
import {
  changedFieldsFromProvenance,
  contentChangedFields,
  type Tier1EdgeClass,
  tier1Dispatch,
} from "./tier1.js";

export type EdgeStalenessClass =
  | "current"
  | "pending-unchecked"
  | "pending-compatible"
  | "pending-broken";

export interface UpstreamStaleness {
  unit: string;
  edge_class: Tier1EdgeClass;
  staleness: EdgeStalenessClass;
  // ISO timestamp the classification measured change from; null when no
  // baseline is derivable (which forces pending-unchecked).
  baseline: string | null;
  // Accumulated content fields the unit's writes touched since the baseline
  // (bookkeeping stripped). Empty for current and for bookkeeping-only churn.
  changed_fields: string[];
  reason: string;
}

export interface UpstreamStalenessSummary {
  current: number;
  pending_unchecked: number;
  pending_compatible: number;
  pending_broken: number;
}

// The unit's content writes since the baseline, folded to one changed-field
// set. `writes` distinguishes "nothing happened" (current) from "only
// bookkeeping churn" (compatible): both have empty changed fields.
export function changedFieldsSince(
  provenance: ProvenanceEntry[],
  unit: string,
  baseline: string,
): { changed: string[]; writes: number } {
  const fields: string[] = [];
  let writes = 0;
  for (const e of provenance) {
    if (e.file !== unit || e.action === "rejected_stale" || e.timestamp <= baseline) continue;
    writes += 1;
    fields.push(...changedFieldsFromProvenance(e));
  }
  return { changed: contentChangedFields(fields), writes };
}

// Classifies one upstream edge by running the tier-1 dispatch on it and
// mapping the verdict: unaffected → pending-compatible (the change certifiably
// misses), affected → pending-broken (hard hit — compiled edges only, by the
// class ceiling), possibly-affected / semantic-review → pending-unchecked.
function classifyEdge(input: {
  artifact: string;
  unit: string;
  edgeClass: Tier1EdgeClass;
  baseline: string | null;
  provenance: ProvenanceEntry[];
  compiledEdge?: ConsumesEdge;
}): UpstreamStaleness {
  const base = {
    unit: input.unit,
    edge_class: input.edgeClass,
    baseline: input.baseline,
  };
  if (input.baseline === null) {
    return {
      ...base,
      staleness: "pending-unchecked",
      changed_fields: [],
      reason: "no baseline — the dependency predates provenance instrumentation, never checked",
    };
  }
  const { changed, writes } = changedFieldsSince(input.provenance, input.unit, input.baseline);
  if (writes === 0) {
    return {
      ...base,
      staleness: "current",
      changed_fields: [],
      reason: "unchanged since baseline",
    };
  }
  const verdict = tier1Dispatch({
    unit: input.unit,
    changedFields: changed,
    compiled: input.compiledEdge ? [input.compiledEdge] : [],
    declaredDependents: input.edgeClass === "declared" ? [input.artifact] : [],
    earnedDependents: input.edgeClass === "earned" ? [input.artifact] : [],
  })[0];
  if (!verdict) {
    // Unreachable: every class above supplies exactly one dependent.
    return { ...base, staleness: "pending-unchecked", changed_fields: changed, reason: "" };
  }
  const staleness: EdgeStalenessClass =
    verdict.verdict === "unaffected"
      ? "pending-compatible"
      : verdict.verdict === "affected"
        ? "pending-broken"
        : "pending-unchecked";
  return { ...base, staleness, changed_fields: changed, reason: verdict.reason };
}

export interface CompiledStaleContext {
  consumes: ConsumesEdge[];
  provenance: ProvenanceEntry[];
}

// Loads the two logs that back compiled-edge classification, with the
// uninstrumented fast path: an absent or empty consumes log resolves to an
// empty context WITHOUT touching the provenance log — zero compiled edges
// means every broken count is provably zero, so the hottest tools pay ~one
// ENOENT check on vaults that never opted into run correlation. Returns
// null on a log-read error; serve-path callers treat that as
// "uninstrumented" (telemetry is best-effort), never as a failed request.
export async function loadCompiledStaleContext(
  vaultRoot: string,
): Promise<CompiledStaleContext | null> {
  const consumes = await listConsumesEdges(vaultRoot);
  if (!consumes.ok) return null;
  if (consumes.value.length === 0) return { consumes: [], provenance: [] };
  const provenance = await readProvenanceLog(vaultRoot);
  if (!provenance.ok) return null;
  return { consumes: consumes.value, provenance: provenance.value };
}

// Compiled-edge staleness for one artifact — the read/search hot path. Only
// compiled edges can be pending-broken, so this is the complete broken set.
// `consumes` may be the full log or an already-collapsed current set: the
// newest-compile-group collapse is idempotent, so batch callers (search)
// collapse once and pass the result through per hit.
export function compiledUpstreamStaleness(
  artifact: string,
  consumes: ConsumesEdge[],
  provenance: ProvenanceEntry[],
): UpstreamStaleness[] {
  return forwardConsumes(consumes, artifact)
    .filter((e) => e.unit !== artifact)
    .map((e) =>
      classifyEdge({
        artifact,
        unit: e.unit,
        edgeClass: "compiled",
        baseline: e.compile_ts,
        provenance,
        compiledEdge: e,
      }),
    );
}

// Full three-class report for one artifact. Declared and earned rows extend
// the compiled set; a unit reachable through several classes keeps one row
// per class — the baselines (and therefore the verdicts) genuinely differ.
export function upstreamStaleness(input: {
  artifact: string;
  consumes: ConsumesEdge[];
  provenance: ProvenanceEntry[];
  declaredUnits: string[];
  earned: { unit: string; lastRederived: string }[];
}): UpstreamStaleness[] {
  const rows = compiledUpstreamStaleness(input.artifact, input.consumes, input.provenance);

  // Declared baseline: the artifact's own latest landed write.
  const artifactWrites = input.provenance.filter(
    (e) => e.file === input.artifact && e.action !== "rejected_stale",
  );
  const declaredBaseline = artifactWrites[artifactWrites.length - 1]?.timestamp ?? null;
  for (const unit of input.declaredUnits) {
    if (unit === input.artifact) continue;
    rows.push(
      classifyEdge({
        artifact: input.artifact,
        unit,
        edgeClass: "declared",
        baseline: declaredBaseline,
        provenance: input.provenance,
      }),
    );
  }

  for (const e of input.earned) {
    if (e.unit === input.artifact) continue;
    rows.push(
      classifyEdge({
        artifact: input.artifact,
        unit: e.unit,
        edgeClass: "earned",
        baseline: e.lastRederived,
        provenance: input.provenance,
      }),
    );
  }

  return rows.sort(
    (a, b) => a.unit.localeCompare(b.unit) || a.edge_class.localeCompare(b.edge_class),
  );
}

// THE disclosure split for every reader-facing staleness surface (#217):
// edges whose upstream unit the caller can read are disclosed in full (by
// omission of the rest); unreadable units surface ONLY as a coarse
// none/some/many bucket over their pending edges — never an exact count,
// never a severity class. vault_read, vault_search, and vault_staleness all
// call this one helper so the invariant cannot drift between surfaces.
export function splitUpstreamVisibility(
  rows: UpstreamStaleness[],
  isReadable: (unit: string) => boolean,
): { visible: UpstreamStaleness[]; hiddenPending: HiddenDownstream } {
  const visible: UpstreamStaleness[] = [];
  let hiddenPendingCount = 0;
  for (const r of rows) {
    if (isReadable(r.unit)) visible.push(r);
    else if (r.staleness !== "current") hiddenPendingCount += 1;
  }
  return { visible, hiddenPending: bucketHiddenDownstream(hiddenPendingCount) };
}

export function summarizeUpstream(rows: UpstreamStaleness[]): UpstreamStalenessSummary {
  const summary: UpstreamStalenessSummary = {
    current: 0,
    pending_unchecked: 0,
    pending_compatible: 0,
    pending_broken: 0,
  };
  for (const r of rows) {
    if (r.staleness === "current") summary.current += 1;
    else if (r.staleness === "pending-unchecked") summary.pending_unchecked += 1;
    else if (r.staleness === "pending-compatible") summary.pending_compatible += 1;
    else summary.pending_broken += 1;
  }
  return summary;
}
