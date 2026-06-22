// Coverage pass (Stage 1): conditionally widen vault_search results with
// same-entity docs in the seeds' date window. Pure over the index; never
// throws. Signals derive from the result set + frontmatter, never the query
// text (avoids the query-conditioning fidelity trap). Returns the hits
// unchanged when no signal fires.

import { getDocument, type IndexDb } from "../storage/index-db.js";
import type { HybridHit } from "./hybrid.js";

export interface CoverageOptions {
  enabled: boolean;
  seedK: number; // how many top hits are seeds
  maxAdd: number; // max docs the pass may add
  padDays: number; // window pad on each side of the seed date span
  maxSpanDays: number; // hard cap on window span
  tokenCapChars: number; // backstop on combined snippet chars of added docs
}

export const DEFAULT_COVERAGE_OPTIONS: CoverageOptions = {
  enabled: true,
  seedK: 3,
  maxAdd: 5,
  padDays: 7,
  maxSpanDays: 90, // matches EDGE_HALF_LIFE_DAYS in curation/edges.ts
  tokenCapChars: 6000,
};

// The dominant frontmatter tag shared by >=2 of the top-seedK hits. Reads tags
// from the index (HybridHit carries none). Highest seed-count wins; ties break
// alphabetically. Returns null when no tag is shared by >=2 seeds — that is the
// "this is a single-fact query, stay quiet" signal.
export function detectSharedEntity(db: IndexDb, hits: HybridHit[], seedK: number): string | null {
  const counts = new Map<string, number>();
  for (const h of hits.slice(0, seedK)) {
    const d = getDocument(db, h.path);
    if (!d) continue;
    for (const tag of new Set(d.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 1; // require >=2
  for (const [tag, n] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n >= 2 && n > bestN) {
      best = tag;
      bestN = n;
    }
  }
  return best;
}
