// computeDecay — per-document temporal decay, for inline surfacing.
//
// Reports whether a single document has decayed, derived from its own
// frontmatter: past TTL, an old draft, stagnant-low-confidence, or deprecated.
// Pure and total — never throws. A document with absent or unparseable temporal
// fields simply reads as not-decayed (ageInDays is NaN-safe; computeStaleness
// treats a null ttl_days as "never stale"). A null return means healthy —
// nothing to surface. This is the silent baseline.

import { ageInDays, computeStaleness } from "./staleness.js";

// A draft older than this is flagged; a low-confidence document untouched this
// long is flagged. Exported so runLint shares the exact same thresholds.
export const DRAFT_MAX_DAYS = 30;
export const LOW_CONFIDENCE_MAX_DAYS = 30;

export type DecayLevel = "deprecated" | "warn" | "aging";

// The frontmatter subset computeDecay needs. A full Frontmatter is structurally
// assignable to this, and so is the indexed-document projection used by search.
export interface DecayInput {
  status: string;
  confidence: string;
  updated: string;
  created: string;
  ttl_days: number | null;
  superseded_by: string | null;
}

export interface DecayState {
  level: DecayLevel;
  reasons: string[];
  banner: string | null; // null for `aging` (scarcity rule); text for warn/deprecated
}

export function computeDecay(input: DecayInput, now: Date = new Date()): DecayState | null {
  const reasons: string[] = [];
  let level: DecayLevel | null = null;

  // Deprecated — formally retired knowledge. Highest precedence.
  if (input.status === "deprecated") {
    level = "deprecated";
    reasons.push("status is deprecated — this document has been retired");
    if (input.superseded_by) reasons.push(`superseded by: ${input.superseded_by}`);
  }

  // Past TTL.
  const staleness = computeStaleness({ updated: input.updated, ttl_days: input.ttl_days }, now);
  if (staleness.expired && staleness.ttlDays !== null) {
    if (level === null) level = "warn";
    reasons.push(`${staleness.ageDays}d since last update, past its ${staleness.ttlDays}d TTL`);
  }

  // Old draft.
  if (input.status === "draft") {
    const draftAge = ageInDays(input.created || input.updated, now);
    if (draftAge > DRAFT_MAX_DAYS) {
      if (level === null) level = "warn";
      reasons.push(`a draft for ${draftAge}d (limit ${DRAFT_MAX_DAYS}d)`);
    }
  }

  // Stagnant low-confidence.
  if (input.confidence === "low") {
    const idleDays = ageInDays(input.updated, now);
    if (idleDays >= LOW_CONFIDENCE_MAX_DAYS) {
      if (level === null) level = "warn";
      reasons.push(
        `low confidence and untouched for ${idleDays}d (limit ${LOW_CONFIDENCE_MAX_DAYS}d)`,
      );
    }
  }

  // Aging — past half its TTL but below every `warn` threshold. No banner.
  if (level === null && !staleness.expired && staleness.score >= 0.5) {
    level = "aging";
    reasons.push(
      `${staleness.ageDays}d since last update, ` +
        `${Math.round(staleness.score * 100)}% of its ${staleness.ttlDays}d TTL`,
    );
  }

  if (level === null) return null; // healthy — silent baseline

  return { level, reasons, banner: renderBanner(level, reasons) };
}

// The banner is null for `aging` (scarcity rule). For warn/deprecated it is a
// Daftari-authored, action-stating warning. The reason lines may include a
// `superseded_by` path; that is the only document-supplied text, and it rides
// as a quoted list item, never interpolated into the directive sentence.
function renderBanner(level: DecayLevel, reasons: string[]): string | null {
  if (level === "aging") return null;
  const head =
    level === "deprecated"
      ? "⚠ DEPRECATED — this document has been retired. Do not rely on it; find the current source."
      : "⚠ STALE — this document may no longer be accurate. Verify against a current source before relying on it.";
  return `${head}\n${reasons.map((r) => `  - ${r}`).join("\n")}`;
}
