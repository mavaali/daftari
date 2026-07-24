// Date helpers shared across the frontmatter and index layers.

// Second-resolution ISO — the shared record timestamp format of the
// append-only JSONL stores (edges, staged actions, shadow log).
export function toSecondISO(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Normalizes an ISO-shaped date string to canonical YYYY-MM-DD, or returns null
// if it is not an unambiguous, real calendar date. Conservative by design: it
// only recovers the missing-zero-pad case (e.g. "2026-3-1" -> "2026-03-01") and
// rejects everything else (slash/textual formats, out-of-range like "2026-13-45",
// rollover non-days like "2026-02-30"). The round-trip equality check catches
// values that `new Date` would silently roll over rather than reject.
export function normalizeIsoDate(s: string): string | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  const candidate = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const d = new Date(`${candidate}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== candidate) return null;
  return candidate;
}
