// cik-tally — rank CIKs by how many amendment exhibits they filed (the
// auto-discovery worklist: prolific amenders surface to the top).
import type { EftsHit } from "./efts-search.js";

export interface CikCount { cik: string; count: number; }

export function tallyCiks(hits: EftsHit[]): CikCount[] {
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h.cik, (counts.get(h.cik) ?? 0) + 1);
  return [...counts.entries()]
    .map(([cik, count]) => ({ cik, count }))
    .sort((a, b) => b.count - a.count || a.cik.localeCompare(b.cik));
}
