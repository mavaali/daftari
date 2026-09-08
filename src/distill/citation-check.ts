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

const QUOTE_RE = /"([^"]+)"/g;

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
// which would silently drop the "%" from the match.
const NUMBER_RE = /\b\d[\d,]*(?:\.\d+)?%?(?:st|nd|rd|th)?(?![0-9A-Za-z])/g;

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
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
  while ((m = re.exec(working)) !== null) {
    const value = type === "quote" ? m[1] : m[0];
    citations.push({ type, value });
    working = mask(working, m.index, m.index + m[0].length);
    re.lastIndex = m.index + m[0].length;
  }
  return working;
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

/**
 * Deterministically assert that every number/date/quote cited in `statement`
 * exists verbatim in `sourceText`. Numbers and dates use an alnum-boundary
 * check (so "50" is not "verified" by a source containing "150"); quotes use
 * a plain verbatim substring check.
 */
export function checkCitationIntegrity(statement: string, sourceText: string): CitationCheckResult {
  const citations = extractCitations(statement);
  const violations = citations.filter((c) =>
    c.type === "quote" ? !sourceText.includes(c.value) : !containsAlnumBounded(sourceText, c.value),
  );
  return { ok: violations.length === 0, citations, violations };
}
