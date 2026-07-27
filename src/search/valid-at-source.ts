// resolveValidAtSource — given a document that does not cover a queried date,
// foreground the chain member that does.
//
// The counterpart to resolveCurrentSource, which answers "what replaced this?"
// This answers "what did the vault believe was true THEN?" — the retrieval
// half of the valid-time axis.
//
// THE LINEAGE RULE. Supersession reachability is not fact identity.
// `superseded_by` is functional in the forward direction but a relation
// backward: vault_merge points both sources at one successor on every merge.
// A walk that went forward to a merge node and then turned backward would land
// on a SIBLING lineage — a document that never made the seed's claim — and
// foreground it with a verbatim snippet that makes it look sourced. So the two
// walks are DIRECTION-MONOTONE: forward-only, or backward-only, never a turn.
//
// THE DISCLOSURE RULE is deliberately asymmetric, applying (not amending) the
// 2026-07-14 edge-graph existence-disclosure spec:
//   - Forward: an unreadable hop degrades to `restricted`, exactly as
//     resolveCurrentSource does. This discloses nothing the caller lacks — the
//     seed's own frontmatter already names its successor.
//   - Backward: an unreadable predecessor is skipped SILENTLY and the walk
//     continues past it. A marker here would be a pure existence bit ("an
//     unreadable document exists and claims this one replaced it") with no
//     corresponding fact in anything the caller can read. That is the class
//     the spec assigns Disposition A — omission.

import { type AccessContext, canRead } from "../access/rbac.js";
import { computeValidity } from "../curation/validity.js";
import {
  getDocument,
  type IndexDb,
  type IndexedDocument,
  supersessionPredecessors,
} from "../storage/index-db.js";
import { previewSnippet } from "./current-source.js";

// Matches resolveCurrentSource's guard against a pathological chain. Applied
// PER DIRECTION, since the two walks are independent.
const MAX_HOPS = 64;

export type ValidAtSource =
  | {
      kind: "resolved";
      path: string;
      title: string;
      snippet: string;
      hops: number;
      from: string | null;
      until: string | null;
    }
  // Forward walk only — see the disclosure rule above.
  | { kind: "restricted" }
  | { kind: "dangling"; brokenAt: string }
  | { kind: "cycle" }
  // Two or more same-depth members cover the date. Counts READABLE members
  // only, so it cannot leak either. A stable wrong answer would be worse than
  // an honest refusal, which is why there is no tiebreak.
  | { kind: "ambiguous"; count: number }
  | { kind: "no-cover" };

function covers(doc: IndexedDocument, at: string): boolean {
  const report = computeValidity({ valid_from: doc.validFrom, valid_until: doc.validUntil }, at);
  // Null means the document authors no interval — it cannot cover anything.
  // Absence is not evidence.
  return report !== null && report.state === "in-window";
}

function resolved(doc: IndexedDocument, hops: number): ValidAtSource {
  return {
    kind: "resolved",
    path: doc.path,
    title: doc.title,
    // Read verbatim from the index, same as resolveCurrentSource: daftari
    // authors the relation, never the value.
    snippet: previewSnippet(doc.content),
    hops,
    from: doc.validFrom,
    until: doc.validUntil,
  };
}

// Forward: strict RBAC, single-successor chain. Returns null to mean "this
// direction found nothing", leaving the caller to try the other one.
function walkForward(
  db: IndexDb,
  seed: IndexedDocument,
  at: string,
  access?: AccessContext,
): ValidAtSource | null {
  const visited = new Set<string>([seed.path]);
  let doc = seed;
  let hops = 0;

  while (doc.supersededBy !== null && hops < MAX_HOPS) {
    const nextPath = doc.supersededBy;
    hops += 1;
    if (visited.has(nextPath)) return { kind: "cycle" };
    visited.add(nextPath);

    const next = getDocument(db, nextPath);
    if (!next) return { kind: "dangling", brokenAt: doc.path };
    if (access && !canRead(access.role, next.collection)) return { kind: "restricted" };

    if (covers(next, at)) return resolved(next, hops);
    doc = next;
  }
  return null;
}

// Backward: breadth-first over the reverse relation, because fan-in is normal
// here. Unreadable nodes are skipped silently but still traversed THROUGH —
// omitting them from the answer must not truncate the walk, or an unreadable
// middle link would hide a readable ancestor the caller is entitled to.
function walkBackward(
  db: IndexDb,
  seed: IndexedDocument,
  at: string,
  access?: AccessContext,
): ValidAtSource | null {
  const visited = new Set<string>([seed.path]);
  let frontier: IndexedDocument[] = [seed];
  let hops = 0;

  while (frontier.length > 0 && hops < MAX_HOPS) {
    hops += 1;
    const next: IndexedDocument[] = [];
    for (const node of frontier) {
      for (const pred of supersessionPredecessors(db, node.path)) {
        if (visited.has(pred.path)) continue;
        visited.add(pred.path);
        next.push(pred);
      }
    }
    if (next.length === 0) return null;

    // Only readable members can answer. An unreadable one still stays in the
    // frontier so the walk can pass through it.
    const readable = access ? next.filter((d) => canRead(access.role, d.collection)) : next;
    const covering = readable.filter((d) => covers(d, at));
    if (covering.length === 1) {
      const winner = covering[0];
      if (winner) return resolved(winner, hops);
    }
    if (covering.length > 1) return { kind: "ambiguous", count: covering.length };

    frontier = next;
  }
  return null;
}

// `at` is a canonical YYYY-MM-DD; the caller validates it. Returns null when
// the seed itself covers the date (nothing to foreground) or when the seed is
// not in the index — matching resolveCurrentSource's not-superseded contract.
export function resolveValidAtSource(
  db: IndexDb,
  path: string,
  at: string,
  access?: AccessContext,
): ValidAtSource | null {
  const seed = getDocument(db, path);
  if (!seed) return null;
  if (covers(seed, at)) return null;

  // Forward first: it is the cheap single-successor chain, and its `cycle` /
  // `dangling` / `restricted` verdicts are about the seed's own declared edge,
  // which the caller can already see in frontmatter.
  const forward = walkForward(db, seed, at, access);
  if (forward !== null) return forward;

  const backward = walkBackward(db, seed, at, access);
  if (backward !== null) return backward;

  return { kind: "no-cover" };
}
