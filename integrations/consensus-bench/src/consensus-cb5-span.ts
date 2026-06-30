// consensus-cb5-span — CB5's span-level variant. The full-passage CB5 detector
// barely fired (2/33) because median gov/stale similarity is 0.938: the model read
// ~95% identical text. Here we narrow each side to the CHANGED SPAN — the inline
// <del>/<ins> diffchange words plus a context window — so a genuine competing claim
// (e.g. "persecution of transgender people" vs "restriction of transgender rights")
// is no longer diluted. Same non-directional detector, same structural no-mint.
import type { RevertDiff } from "./consensus-content.js";
import { cleanText, parsePassage } from "./consensus-passage.js";

const CH_OPEN = /<(?:ins|del)\b[^>]*>/gi;
const CH_CLOSE = /<\/(?:ins|del)>/gi;
const MARK_OPEN = "\u0001";
const MARK_CLOSE = "\u0002";

// Extract the changed span from one diff cell: the diffchange-marked words plus
// `windowWords` of context on each side. Falls back to the full cleaned line when
// the cell has no inline diffchange (whole-line replacement = the line is the change).
export function extractChangedSpan(cellHtml: string, windowWords = 12): string {
  const marked = cellHtml.replace(CH_OPEN, ` ${MARK_OPEN} `).replace(CH_CLOSE, ` ${MARK_CLOSE} `);
  const tokens = cleanText(marked).split(/\s+/).filter(Boolean);
  const words: string[] = [];
  const changed: number[] = [];
  let inChange = false;
  for (const t of tokens) {
    if (t === MARK_OPEN) { inChange = true; continue; }
    if (t === MARK_CLOSE) { inChange = false; continue; }
    if (inChange) changed.push(words.length);
    words.push(t);
  }
  if (changed.length === 0) return words.join(" ");
  const lo = Math.max(0, changed[0] - windowWords);
  const hi = Math.min(words.length, changed[changed.length - 1] + windowWords + 1);
  return words.slice(lo, hi).join(" ");
}

const DEL_CELL = /<td[^>]*diff-deletedline[^>]*>([\s\S]*?)<\/td>/;
const ADD_CELL = /<td[^>]*diff-addedline[^>]*>([\s\S]*?)<\/td>/;

export interface SpanPair { staleSpan: string; govSpan: string; }

export function spanPairFromDiff(diffHtml: string, windowWords = 12): SpanPair {
  const del = diffHtml.match(DEL_CELL)?.[1] ?? "";
  const add = diffHtml.match(ADD_CELL)?.[1] ?? "";
  return { staleSpan: extractChangedSpan(del, windowWords), govSpan: extractChangedSpan(add, windowWords) };
}

export interface SpanTruePair { revid: number; governingNum: number; govSpan: string; staleSpan: string; }
export interface SpanControlPair { numA: number; numB: number; spanA: string; spanB: string; }

// Same scorable single-hunk gate as cb4-pairs truePairs, but the inputs are the
// changed spans rather than the full passages.
export function spanTruePairs(diffs: RevertDiff[], windowWords = 12): SpanTruePair[] {
  const out: SpanTruePair[] = [];
  for (const d of diffs) {
    if (!parsePassage(d.diffHtml).scorable) continue;
    const { staleSpan, govSpan } = spanPairFromDiff(d.diffHtml, windowWords);
    out.push({ revid: d.revid, governingNum: d.governingNum, govSpan, staleSpan });
  }
  return out;
}

// Mirror controlPairs: one govSpan per distinct governingNum (first scorable diff),
// adjacent distinct items joined — two unrelated changed-clauses (no relation).
export function spanControlPairs(diffs: RevertDiff[], windowWords = 12): SpanControlPair[] {
  const byNum = new Map<number, string>();
  for (const d of diffs) {
    if (byNum.has(d.governingNum)) continue;
    if (!parsePassage(d.diffHtml).scorable) continue;
    byNum.set(d.governingNum, spanPairFromDiff(d.diffHtml, windowWords).govSpan);
  }
  const items = [...byNum.entries()].sort((a, b) => a[0] - b[0]);
  const out: SpanControlPair[] = [];
  for (let i = 0; i + 1 < items.length; i++) {
    out.push({ numA: items[i][0], numB: items[i + 1][0], spanA: items[i][1], spanB: items[i + 1][1] });
  }
  return out;
}
