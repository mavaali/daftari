// Precedent retrieval for the Tension Court — common-law memory.
//
// A ruling is a resolved tension: the resolution kind, rationale, and
// references recorded by vault_tension_resolve (or `daftari court rule`).
// When a new tension comes up for ruling, past rulings on similar disputes
// are surfaced so the house resolves the same kind of disagreement the same
// way — or knowingly departs from its own precedent.
//
// "Similar" is deterministic — no LLM, no semantic scoring. Three tiers,
// most specific wins:
//   1. shared-document — the open tension involves a document a past ruling
//      also involved.
//   2. collection-pair — the (unordered) pair of collections the two sides
//      live in matches a past ruling's pair.
//   3. same-kind — the tension kind (temporal | factual | interpretive)
//      matches.
// Within a tier, newer rulings first. The court retrieves precedent; it
// never decides. Whether a precedent applies is the human's judgment.

import type { TensionEntry } from "../curation/tension.js";
import { canonicalRel } from "../utils/paths.js";

export type PrecedentMatchTier = "shared-document" | "collection-pair" | "same-kind";

export interface Precedent {
  id: string | null;
  title: string;
  date: string;
  kind: string;
  resolutionKind: string;
  resolvedAt: string;
  resolvedBy: string;
  rationale: string | null;
  references: string[];
  matchTier: PrecedentMatchTier;
  matchDetail: string;
}

const TIER_ORDER: Record<PrecedentMatchTier, number> = {
  "shared-document": 1,
  "collection-pair": 2,
  "same-kind": 3,
};

// Canonicalized before taking the top segment — an alias like
// `pricing/../secret/x.md` is a secret doc and must key as one (#127/#128
// class). Escaping paths key as `..`, blank as "": neither can collide with
// a real collection.
function topCollection(relPath: string): string {
  return canonicalRel(relPath).split("/")[0] ?? "";
}

// The unordered collection pair of a tension's two sides, as a canonical key.
function collectionPairKey(t: TensionEntry): string {
  const pair = [topCollection(t.sourceA), topCollection(t.sourceB)].sort();
  return pair.join(" ↔ ");
}

function matchTier(open: TensionEntry, ruling: TensionEntry): Precedent | null {
  const base = {
    id: ruling.id ?? null,
    title: ruling.title,
    date: ruling.date,
    kind: ruling.kind,
    resolutionKind: ruling.resolution?.kind ?? "",
    resolvedAt: ruling.resolution?.resolved_at ?? "",
    resolvedBy: ruling.resolution?.resolved_by ?? "",
    rationale: ruling.resolution?.rationale ?? null,
    references: ruling.resolution?.references ?? [],
  };

  const openDocs = new Set([open.sourceA, open.sourceB]);
  const shared = [ruling.sourceA, ruling.sourceB].filter((p) => p.length > 0 && openDocs.has(p));
  if (shared.length > 0) {
    return {
      ...base,
      matchTier: "shared-document",
      matchDetail: `also involved ${[...new Set(shared)].join(", ")}`,
    };
  }

  const pair = collectionPairKey(open);
  if (pair === collectionPairKey(ruling)) {
    return { ...base, matchTier: "collection-pair", matchDetail: `same collections: ${pair}` };
  }

  if (open.kind !== "unspecified" && open.kind === ruling.kind) {
    return { ...base, matchTier: "same-kind", matchDetail: `same kind: ${open.kind}` };
  }

  return null;
}

export const PRECEDENT_CAP = 3;

// Rulings relevant to an open tension, most specific tier first, newest
// ruling first within a tier, capped at PRECEDENT_CAP.
export function findPrecedents(open: TensionEntry, rulings: TensionEntry[]): Precedent[] {
  const matches: Precedent[] = [];
  for (const ruling of rulings) {
    if (!ruling.resolved || !ruling.resolution) continue;
    const m = matchTier(open, ruling);
    if (m) matches.push(m);
  }
  matches.sort((a, b) => {
    const tier = TIER_ORDER[a.matchTier] - TIER_ORDER[b.matchTier];
    if (tier !== 0) return tier;
    if (a.resolvedAt !== b.resolvedAt) return a.resolvedAt < b.resolvedAt ? 1 : -1;
    return a.title.localeCompare(b.title);
  });
  return matches.slice(0, PRECEDENT_CAP);
}
