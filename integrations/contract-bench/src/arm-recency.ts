// arm-recency — Arm A, the strong recency foil (CF-wiki analog).
//
// Strategy: find the most-recent ChainDoc (highest order) that MENTIONS the
// clause — either as "Section <clause>" (numbered) or as a quoted defined term
// "<clause>" — then read its value with extractValue. This is exactly what a
// "latest document wins" system (or a wiki.py-style synthesis) does. It gets
// scoped-current questions WRONG when the latest mention is a stale recital that
// restates the OLD value rather than the governing NEW value.

import type { ChainDoc } from "./clause-edge.js";
import { extractValue } from "./qa-build.js";

// Returns the value extractValue reads for `clause` from the most-recent doc
// that mentions it, or "NOT_PRESENT" if no doc mentions it.
export function recencyAnswer(docs: ChainDoc[], clause: string): string {
  // Detect both numbered Sections and quoted defined terms — a Section-only
  // mention regex returns NOT_PRESENT for every defined term, silently
  // crippling Arm A on real credit-agreement chains (the E3 artifact).
  const esc = clause.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionRe = new RegExp(`Section\\s+${esc}\\b|["“]\\s*${esc}\\s*["”]`, "i");
  const candidates = docs.filter((d) => mentionRe.test(d.text));
  if (candidates.length === 0) return "NOT_PRESENT";
  const latest = candidates.reduce((best, d) => (d.order > best.order ? d : best));
  return extractValue(latest.text, clause);
}
