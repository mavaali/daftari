// Shared helpers for the `content`-channel summarizers (spec 2026-07-26,
// Decision 3). Extracted from vault_lint's summarizer so every tool's
// compact summary clips detail text the same way, instead of each
// summarizer inventing its own truncation rule.

// Default cap on how much of a free-text field (a finding detail, a
// rationale, ...) a summary line shows before eliding the rest. The full
// text always still rides `structuredContent`; this only bounds what the
// MODEL-FACING text block spends tokens on.
export const SUMMARY_DETAIL_CHARS = 110;

// Default cap on how many rows a listing-shaped summary enumerates (index
// entries, edges, queue items, ...) before switching to a "N more in
// structuredContent" trailer.
export const SUMMARY_MAX_ROWS = 20;

// Collapses internal whitespace (so a multi-line detail renders as one
// summary line) and truncates to `max` chars with an ellipsis. Idempotent on
// already-short, already-flat text.
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
