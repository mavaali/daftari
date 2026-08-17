// Supersession suppression pass (MAV-161): demote stale hits, foreground
// their current heads. The 2026-06-21 distractor placebo showed co-ranked
// stale docs are causally hallucinogenic (0%→28% re-induced with a correct
// context present), and the recall doc's decision line called for exactly
// this: raise span recall AND foreground against stale distractors. This
// pass is the deterministic half of that lever for supersession chains:
//
//   - PULL-IN: a ranked hit whose `superseded_by` chain resolves to a
//     readable current head that is NOT in the hit list gets that head
//     inserted at its own rank slot — the relevance the stale doc earned is
//     occupied by the current version of that content. Additive and
//     lossless, like the coverage pass: score 0, flagged `viaForeground`.
//   - DEMOTE: every hit with a resolved current head moves to the tail of
//     the list, flagged `demoted: "superseded"`. Nothing is dropped — the
//     agent (the reranker) still sees the stale doc, its annotation, and
//     the head above it.
//
// Only `kind: "resolved"` chains participate: a dangling/cycle/restricted
// chain has no head to offer, and demoting a doc while hiding its successor
// could bury the only readable copy of the content.
//
// Default OFF until the hallucination arm decides (the MAV-161 kill
// condition needs the LLM-judged bench); `search.suppress_superseded: true`
// in config.yaml opts in. Same runtime-gate lifecycle as the coverage pass:
// startup applies the config once, and a bare product call consults the
// gate so a future call site cannot forget it.

import type { AccessContext } from "../access/rbac.js";
import { getDocument, type IndexDb } from "../storage/index-db.js";
import { SEARCH_TUNING_DEFAULTS } from "../utils/config.js";
import { resolveCurrentSource } from "./current-source.js";
import type { HybridHit } from "./hybrid.js";

let suppressSupersededRuntime = SEARCH_TUNING_DEFAULTS.suppressSuperseded;

export function setSuppressSuperseded(v: boolean): void {
  suppressSupersededRuntime = v;
}

export function suppressSuperseded(): boolean {
  return suppressSupersededRuntime;
}

// Builds the hit for a pulled-in current head. Score 0 keeps it honest — it
// did not earn a rank; its POSITION (the stale hit's slot) is the signal.
// Snippet is the head's leading content, verbatim from the index (daftari
// authors the relation, never the value).
function foregroundHit(db: IndexDb, path: string): HybridHit | null {
  const doc = getDocument(db, path);
  if (!doc) return null;
  const collapsed = doc.content.replace(/\s+/g, " ").trim();
  return {
    path: doc.path,
    title: doc.title,
    collection: doc.collection,
    status: doc.status,
    score: 0,
    bm25Score: 0,
    vectorScore: 0,
    snippet: collapsed.length > 280 ? `${collapsed.slice(0, 280)}…` : collapsed,
    decay: null,
    viaForeground: true,
  };
}

export interface SuppressionResult {
  hits: HybridHit[];
  demoted: number;
  pulledIn: HybridHit[]; // the new head hits, for the caller to enrich
}

// The pass. Reads each hit's `currentSource` (computing and caching it on
// the hit when absent, so the caller's enrichment loop does not resolve the
// chain twice), then rebuilds the list as:
//   [non-superseded hits, with pulled-in heads at the stale hits' slots]
//   + [demoted superseded hits, original order, at the tail]
// `pullIn: false` (the federation-mount site) demotes only — inserting a
// cross-mount head would need alias path rewriting; documents-not-state
// keeps that out of v1.
export function applySupersededSuppression(
  db: IndexDb,
  hits: HybridHit[],
  access: AccessContext | undefined,
  opts: { pullIn: boolean },
): SuppressionResult {
  if (!suppressSuperseded() || hits.length === 0) {
    return { hits, demoted: 0, pulledIn: [] };
  }

  const present = new Set(hits.map((h) => h.path));
  const kept: HybridHit[] = [];
  const demotedHits: HybridHit[] = [];
  const pulledIn: HybridHit[] = [];

  for (const hit of hits) {
    if (hit.currentSource === undefined) {
      const cs = resolveCurrentSource(db, hit.path, access);
      if (cs) hit.currentSource = cs;
    }
    const cs = hit.currentSource;
    if (cs?.kind !== "resolved") {
      kept.push(hit);
      continue;
    }
    // The stale doc's rank slot goes to its head when the head is absent.
    if (opts.pullIn && !present.has(cs.path)) {
      const head = foregroundHit(db, cs.path);
      if (head) {
        present.add(head.path);
        pulledIn.push(head);
        kept.push(head);
      }
    }
    hit.demoted = "superseded";
    demotedHits.push(hit);
  }

  return { hits: [...kept, ...demotedHits], demoted: demotedHits.length, pulledIn };
}
