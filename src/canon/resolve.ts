// Canon resolver — pure belief-layer computation.
//
// Given already-loaded docs, a holder-set, an as-of date, the registry, and
// the topic's tensions, produces a CanonResult without performing any I/O.
// The orchestrator (Task 4) is responsible for loading data and passing it in.
// A tension whose both sides are in-scope surviving docs becomes a contested
// trajectory (sorted ascending by valid_from); all other in-scope docs are
// settled. Ghost-holder warnings fire only when the registry is non-empty —
// an empty registry is the zero-config baseline, not a misconfiguration.

import { computeValidity } from "../curation/validity.js";
import { isRegistered, resolveHolder } from "../holders/registry.js";
import type { HolderRegistry } from "../holders/types.js";
import type { CanonDoc, CanonResult, ContestedTrajectory } from "./types.js";

interface TensionPair {
  sourceA: string;
  sourceB: string;
}

/** A doc is in canon if it has no validity window, or is in-window at asOf. */
function currentlyValid(doc: CanonDoc, asOf: string): boolean {
  const report = computeValidity(
    { valid_from: doc.valid_from, valid_until: doc.valid_until },
    asOf,
  );
  return report === null || report.state === "in-window";
}

export function resolveCanon(
  docs: CanonDoc[],
  holders: string[],
  asOf: string,
  registry: HolderRegistry,
  tensions: TensionPair[],
  hidden = { partial_visibility: false, hidden_tension_count: 0 },
  unindexed: string[] = [],
): CanonResult {
  const holderSet = new Set(holders);
  const inScope = docs.filter(
    (d) => currentlyValid(d, asOf) && holderSet.has(resolveHolder(registry, d.holder)),
  );
  const byPath = new Map(inScope.map((d) => [d.path, d]));

  const ghostStrings = [
    ...new Set(
      inScope
        .map((d) => d.holder)
        .filter((s) => !isRegistered(registry, s) && registry.aliases.size > 0),
    ),
  ];

  const contested: ContestedTrajectory[] = [];
  const contestedPaths = new Set<string>();
  for (const t of tensions) {
    const a = byPath.get(t.sourceA);
    const b = byPath.get(t.sourceB);
    if (a === undefined || b === undefined) continue;
    const nodes = [a, b]
      .map((d) => ({
        holder: resolveHolder(registry, d.holder),
        path: d.path,
        valid_from: d.valid_from,
        updated: d.updated,
      }))
      .sort((x, y) => (x.valid_from ?? "").localeCompare(y.valid_from ?? ""));
    contested.push({ trajectory: nodes, hint_ordering: "by_valid_from" });
    contestedPaths.add(a.path);
    contestedPaths.add(b.path);
  }

  // Settled is one claim per doc (citations: [d.path]). Two non-contested docs
  // from the same resolved holder therefore produce two SettledClaims rather
  // than one grouped claim. Grouping multiple same-holder docs into a single
  // multi-citation claim is intentionally deferred to a later iteration.
  const settled = inScope
    .filter((d) => !contestedPaths.has(d.path))
    .map((d) => ({ holder: resolveHolder(registry, d.holder), citations: [d.path] }));

  return {
    settled,
    contested,
    flags: {
      graph_completeness: "curated",
      partial_visibility: hidden.partial_visibility,
      hidden_tension_count: hidden.hidden_tension_count,
      unindexed: unindexed.length > 0,
      unindexed_paths: unindexed,
      ...(ghostStrings.length > 0
        ? { ghost_holder_warning: { count: ghostStrings.length, strings: ghostStrings } }
        : {}),
    },
  };
}
