// src/distill/citation-check.ts
//
// Citation-integrity check (distill). For each compiled claim, deterministically
// asserts that the numbers/dates/quotes it cites still exist verbatim in the
// raw source text it was compiled from.
//
// Why this must run at extraction time, not later: distill is compile-and-
// discard by design (see DISTILL_SOURCE_UNVERIFIABLE_REASON in
// src/curation/source-refs.ts) — the raw source is never landed in the vault,
// so a post-hoc lint over landed documents structurally cannot re-check
// against it. This check runs while the raw chunk text is still in memory,
// which is the only point at which "provenance still true" is verifiable.
//
// Literal-match only: this catches hallucinated/altered numbers, dates, and
// quotes, not paraphrase or semantic drift. A claim can pass this check and
// still misrepresent its source in ways that don't touch a cited literal.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CitationType = "number" | "date" | "quote";

export interface Citation {
  type: CitationType;
  value: string;
}

export interface CitationCheckResult {
  /** True iff every extracted citation exists verbatim in the source text. */
  ok: boolean;
  /** All citations extracted from the statement (verified or not). */
  citations: Citation[];
  /** The subset of `citations` that could not be found verbatim in the source. */
  violations: Citation[];
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

// ASCII or typographic double quotes; the span is in group 1 or group 2.
const QUOTE_RE = /"([^"]+)"|\u201c([^\u201d]+)\u201d/g;

const MONTH_NAMES =
  "January|February|March|April|May|June|July|August|September|October|November|December|" +
  "Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
const MONTH_DATE_RE = new RegExp(
  `\\b(?:${MONTH_NAMES})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`,
  "g",
);
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const SLASH_DATE_RE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;

// Trailing boundary is a lookahead rather than \b: \b fails right after a
// non-word char like "%" (e.g. "3.5%." — \b can't sit between "%" and "."),
// which would silently drop the "%" from the match. Commas count only as
// internal separators (followed by a digit), so the sentence comma in "50, not
// final" stays out of the cited value. A leading "-" is kept as a sign only
// when it is not joined to a preceding word or number, so "-50" is cited as
// "-50" but the range "10-20" yields "10" and "20".
const NUMBER_RE =
  /(?:(?<![0-9A-Za-z])-)?\b\d+(?:,\d+)*(?:\.\d+)?%?(?:st|nd|rd|th)?(?![0-9A-Za-z])/g;

// Replace a matched span with same-length spaces so later passes over the
// same working string neither re-match it nor shift subsequent indices.
function mask(text: string, start: number, end: number): string {
  return text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
}

function extractAndMask(
  working: string,
  re: RegExp,
  type: CitationType,
  citations: Citation[],
): string {
  // Match the whole pass against the unmasked string, then mask: masking
  // mid-pass would turn the "10" of "10-20" into spaces and make the "-" of
  // "-20" look like a sign to the lookbehind.
  let masked = working;
  for (const m of working.matchAll(re)) {
    citations.push({ type, value: type === "quote" ? (m[1] ?? m[2]) : m[0] });
    masked = mask(masked, m.index, m.index + m[0].length);
  }
  return masked;
}

/**
 * Extract candidate citations (quotes, then dates, then numbers) from a
 * statement. Order matters: quotes are masked out first so quoted digits
 * aren't double-counted as bare numbers, then dates so a date's digits
 * aren't re-extracted as a separate number.
 */
export function extractCitations(statement: string): Citation[] {
  const citations: Citation[] = [];
  let working = statement;

  working = extractAndMask(working, QUOTE_RE, "quote", citations);
  working = extractAndMask(working, MONTH_DATE_RE, "date", citations);
  working = extractAndMask(working, ISO_DATE_RE, "date", citations);
  working = extractAndMask(working, SLASH_DATE_RE, "date", citations);
  extractAndMask(working, NUMBER_RE, "number", citations);

  return citations;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Alnum-boundary substring check: true iff `value` occurs in `source` and is
// not flanked by another alphanumeric character on either side. Prevents a
// cited "50" from being "verified" merely because the source contains "150" —
// plain .includes() would wrongly pass that case.
function containsAlnumBounded(source: string, value: string): boolean {
  const re = new RegExp(`(?<![0-9A-Za-z])${escapeRegExp(value)}(?![0-9A-Za-z])`);
  return re.test(source);
}

// Numbers additionally must be a whole numeric token: a "." or "," joining the
// match to another digit means it is a fragment of a larger literal. Without
// this a cited "5" would pass against "3.5", and "50" against "1,050". An
// unsigned value must also not carry a sign in the source ("50" vs "-50"),
// and a bare value must not match a percentage ("50" vs "50%").
function containsWholeNumber(source: string, value: string): boolean {
  const notPercent = value.endsWith("%") ? "" : "(?!%)";
  const re = new RegExp(
    `(?<![0-9A-Za-z])(?<!\\d[.,])(?<!(?:^|[^0-9A-Za-z])-)${escapeRegExp(value)}(?![0-9A-Za-z])(?![.,]\\d)${notPercent}`,
  );
  return re.test(source);
}

/**
 * Deterministically assert that every number/date/quote cited in `statement`
 * exists verbatim in `sourceText`. Numbers and dates use an alnum-boundary
 * check (so "50" is not "verified" by a source containing "150"), and a
 * number must also be a whole numeric token (not "5" inside "3.5"); quotes
 * use a plain verbatim substring check.
 */
export function checkCitationIntegrity(statement: string, sourceText: string): CitationCheckResult {
  const citations = extractCitations(statement);
  const violations = citations.filter((c) => {
    if (c.type === "quote") return !sourceText.includes(c.value);
    if (c.type === "number") return !containsWholeNumber(sourceText, c.value);
    return !containsAlnumBounded(sourceText, c.value);
  });
  return { ok: violations.length === 0, citations, violations };
}
