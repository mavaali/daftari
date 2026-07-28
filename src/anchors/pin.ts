// src/anchors/pin.ts
// Pin grammar: an optional `#L<start>[-<end>]@<sha>` suffix on a `describes`
// binding, recording the git blob id (and optionally a line range) the
// author looked at when the binding was written.
// Spec: docs/superpowers/specs/2026-07-26-citation-anchors-jit-verification-
// design.md, Decision 1.
//
// splitPin strips the pin FIRST — end-anchored, so a path containing `@` or
// `#` mid-string is unaffected — then hands the remainder (the bare
// `repo:path::symbol` binding) to the existing describes parser
// (parseDescribesEntry, src/audit/describes.ts) untouched. That parser is
// never modified; this module has no dependency on it, so describes.ts
// depends on pin.ts and not the other way around.

export interface PinSpec {
  start: number | null;
  end: number | null;
  sha: string;
}

export interface PinnedEntry {
  binding: string;
  pin: PinSpec | null;
}

// End-anchored: an optional `#L<n>[-<n>]` range marker, then a mandatory
// `@<7-40 lowercase hex>` blob id, at the very end of the trimmed entry. A
// path that legitimately contains `@` or `#` mid-string is unaffected (the
// pattern only matches at end-of-string); a path that itself ENDS in text
// matching this shape is a known, accepted ambiguity — the pin wins (spec
// Decision 1).
export const PIN_RE = /(#L(\d+)(?:-(\d+))?)?@([0-9a-f]{7,40})$/;

// Strips the pin suffix, if present. On no match, `binding` is the entry
// verbatim and `pin` is null — a byte-identical passthrough for every entry
// written before pins existed. An inverted range (`end < start`) degrades
// the WHOLE entry to a bare binding: a malformed range makes the sha claim
// untrustworthy too, so falling back to "no pin" is safer than trusting a
// nonsensical one (surfaced separately by looksLikeMalformedPin, below).
export function splitPin(entry: string): PinnedEntry {
  const trimmed = entry.trim();
  const m = trimmed.match(PIN_RE);
  if (!m) return { binding: trimmed, pin: null };

  const startStr = m[2];
  const endStr = m[3];
  const sha = m[4] as string;
  const start = startStr !== undefined ? Number.parseInt(startStr, 10) : null;
  // A bare "#L40" (no "-end") means the single line 40.
  const end = endStr !== undefined ? Number.parseInt(endStr, 10) : start;

  if (start !== null && end !== null && end < start) {
    return { binding: trimmed, pin: null };
  }

  const binding = trimmed.slice(0, m.index).trim();
  return { binding, pin: { start, end, sha } };
}

// Advisory heuristic for vault_lint's malformedPins check (Phase 8). Never
// blocks a write, never affects splitPin's own parse. Fires ONLY on
// near-misses that a strict PIN_RE match would reject — tightened per the
// 2026-07-27 plan resolution (C11) so ordinary text ending in `@` or `#L`-
// shaped substrings (`::@property`, `::render@v2`, an npm-style scoped
// import) does not false-positive:
//
//   (a) a trailing `#L<n>[-<n>]@<near-miss>` — a range marker plus `@` is a
//       strong pin-intent signal, so a near-miss sha after it is reported;
//   (b) a trailing `@<4-40 hex chars>` that fails strict PIN_RE — too short
//       (4-6 chars) or contains uppercase hex;
//   (c) a strict structural match with an inverted range (end < start).
const MALFORMED_RANGE_NEAR_MISS = /#L\d+(?:-\d+)?@[0-9a-zA-Z]*$/;
const MALFORMED_HEX_NEAR_MISS = /@[0-9a-fA-F]{4,40}$/;

export function looksLikeMalformedPin(entry: string): boolean {
  const trimmed = entry.trim();
  const strict = trimmed.match(PIN_RE);
  if (strict) {
    const startStr = strict[2];
    const endStr = strict[3];
    if (startStr !== undefined && endStr !== undefined) {
      return Number.parseInt(endStr, 10) < Number.parseInt(startStr, 10);
    }
    return false;
  }
  if (MALFORMED_RANGE_NEAR_MISS.test(trimmed)) return true;
  return MALFORMED_HEX_NEAR_MISS.test(trimmed);
}
