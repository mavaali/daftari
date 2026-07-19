// Coverage pass (Stage 1): conditionally widen vault_search results with
// same-entity docs in the seeds' date window. Pure over the index; never
// throws. Signals derive from the result set + frontmatter, never the query
// text (avoids the query-conditioning fidelity trap). Returns the hits
// unchanged when no signal fires.

import {
  getDocument,
  getDocumentsInDateRange,
  type IndexDb,
  type IndexedDocument,
} from "../storage/index-db.js";
import { normalizeIsoDate } from "../utils/dates.js";
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

export interface DateWindow {
  start: string;
  end: string;
}

// True only for a value already in strict, canonical, real-calendar ISO
// YYYY-MM-DD form. Defense-in-depth: insertDocument normalizes the index's date
// columns, so in practice this only ever sees canonical dates or "" — but the
// guard stays as an independent layer. Reuses the shared normalizer (a string is
// canonical iff normalizing it is a no-op) to avoid a second date-validation
// implementation that could drift.
function isValidIsoDate(s: string): boolean {
  return normalizeIsoDate(s) === s;
}

// Shifts an ISO YYYY-MM-DD date by `days` (may be negative). UTC-anchored so it
// is timezone-stable.
function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The date window to gather over: the created-date span of the entity-bearing
// seeds, padded by padDays, with the end clamped to maxSpanDays from the start.
// Returns null when no entity-bearing seed carries a date.
export function computeWindow(
  db: IndexDb,
  hits: HybridHit[],
  entity: string,
  opts: CoverageOptions,
): DateWindow | null {
  const dates: string[] = [];
  for (const h of hits.slice(0, opts.seedK)) {
    const d = getDocument(db, h.path);
    if (d?.tags.includes(entity) && d.created && isValidIsoDate(d.created)) dates.push(d.created);
  }
  if (dates.length === 0) return null;
  dates.sort();
  const start = shiftDays(dates[0], -opts.padDays);
  let end = shiftDays(dates[dates.length - 1], opts.padDays);
  const maxEnd = shiftDays(start, opts.maxSpanDays);
  if (end > maxEnd) end = maxEnd;
  return { start, end };
}

const COVERAGE_SNIPPET_MAX = 280; // mirrors current-source.ts previewSnippet

function coverageSnippet(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  return collapsed.length > COVERAGE_SNIPPET_MAX
    ? `${collapsed.slice(0, COVERAGE_SNIPPET_MAX)}…`
    : collapsed;
}

// Same-entity docs in the window, excluding ones already present, recency-first
// (current state matters), capped at maxAdd. The getDocumentsInDateRange call is
// the net-new date-range query.
function gatherCandidates(
  db: IndexDb,
  entity: string,
  window: DateWindow,
  excludePaths: Set<string>,
  opts: CoverageOptions,
): IndexedDocument[] {
  return getDocumentsInDateRange(db, window.start, window.end)
    .filter((d) => d.tags.includes(entity) && !excludePaths.has(d.path))
    .slice(0, opts.maxAdd); // already created-DESC, path-ASC from the query
}

// Builds an appended coverage hit. score 0 keeps it below ranked hits; the
// caller never re-sorts, so original relevance order is preserved.
function coverageHit(d: IndexedDocument): HybridHit {
  return {
    path: d.path,
    title: d.title,
    collection: d.collection,
    status: d.status,
    score: 0,
    bm25Score: 0,
    vectorScore: 0,
    snippet: coverageSnippet(d.content),
    decay: null,
    viaCoverage: true,
    coverageReason: "entity-window",
  };
}

// The Stage 1 coverage pass. Returns hits unchanged unless a shared entity (>=2
// seeds) + a date window + at least one new in-window same-entity doc all hold.
export function applyCoveragePass(
  db: IndexDb,
  hits: HybridHit[],
  opts: CoverageOptions = DEFAULT_COVERAGE_OPTIONS,
): HybridHit[] {
  if (!opts.enabled || hits.length < 2) return hits;
  const entity = detectSharedEntity(db, hits, opts.seedK);
  if (!entity) return hits;
  const window = computeWindow(db, hits, entity, opts);
  if (!window) return hits;
  const exclude = new Set(hits.map((h) => h.path));
  const added = gatherCandidates(db, entity, window, exclude, opts);
  if (added.length === 0) return hits;
  return [...hits, ...added.map(coverageHit)];
}

// Deterministic backstop on the combined snippet size of coverage-added docs.
// Original ranked hits are never evicted (we never displace the caller's
// top-N). Among coverage docs, evict stale first (those SP-A flagged with a
// currentSource), then oldest, until the added snippet chars fit tokenCapChars.
export function enforceTokenCap(hits: HybridHit[], opts: CoverageOptions): HybridHit[] {
  const original = hits.filter((h) => !h.viaCoverage);
  const coverage = hits.filter((h) => h.viaCoverage);
  if (coverage.length === 0) return hits;

  // Eviction priority: stale before fresh, then oldest first. The survivors are
  // taken from the opposite end. Coverage docs arrive recency-first, so index
  // order is newest→oldest; a stable sort by (fresh?0:1) puts stale last for the
  // "drop from the end" loop below.
  const ordered = [...coverage].sort((a, b) => {
    const aStale = a.currentSource?.kind === "resolved" ? 1 : 0;
    const bStale = b.currentSource?.kind === "resolved" ? 1 : 0;
    return aStale - bStale; // fresh first, stale last; stable keeps recency within group
  });

  let used = ordered.reduce((n, h) => n + h.snippet.length, 0);
  while (used > opts.tokenCapChars && ordered.length > 0) {
    const dropped = ordered.pop(); // removes the last = stalest/oldest survivor
    used -= dropped?.snippet.length ?? 0;
  }

  // Re-emit in the original arrival order, minus evicted coverage docs.
  const keep = new Set(ordered.map((h) => h.path));
  return [...original, ...coverage.filter((h) => keep.has(h.path))];
}
