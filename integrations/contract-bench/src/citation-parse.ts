// citation-parse — classify the operative references in a contract amendment's
// text into recoverable (whole-clause restate/delete/add, value inline) vs
// unrecoverable (partial edits, indirection) operations. The recoverable/
// unrecoverable split is what gates clean (clause -> current-value) ground
// truth, and its unrecoverable rate is CB1's >20%-hand-resolution kill metric.

export type AmendmentOp = "restate" | "delete" | "add" | "partial" | "indirect";

export interface Citation {
  clause: string;
  op: AmendmentOp;
  recoverable: boolean;
}

const CLAUSE = String.raw`(\d+(?:\.\d+)*(?:\([a-z0-9]+\))?)`;

// Operative phrases, longest/most-specific first. "amended and restated in its
// entirety" and "deleted in its entirety" state (or remove) a whole clause and
// are recoverable; "amended by [inserting/replacing/...]" is a sub-clause edit
// with no whole-clause value stated, so it cannot yield clean ground truth.
interface OpPattern {
  re: RegExp;
  op: AmendmentOp;
  recoverable: boolean;
}
const OP_PATTERNS: OpPattern[] = [
  { re: /amended and restated in its entirety/gi, op: "restate", recoverable: true },
  { re: /deleted in its entirety/gi, op: "delete", recoverable: true },
  // Indirection: the new value lives in a referenced attachment/exhibit, not
  // inline — unrecoverable. Matched before "amended by" cannot collide ("as"
  // vs "by"); "as added pursuant to" is an appositive, not "is added".
  { re: /amended as set forth in/gi, op: "indirect", recoverable: false },
  { re: /\b(?:is|are) added\b/gi, op: "add", recoverable: true },
  { re: /amended by/gi, op: "partial", recoverable: false },
];

const SECTION_RE = new RegExp(String.raw`Section\s+${CLAUSE}(?![\d.])`, "gi");

// A sentence boundary is a period or closing quote followed by whitespace and a
// capital / opening-quote / list-marker. Dotted clause numbers ("5.4" -> "." then
// a digit, no space) are deliberately NOT boundaries.
const SENTENCE_BOUNDARY = /[.”"]\s+(?=[A-Z“"(]|\d+[).])/g;

// Words immediately before a "Section X" reference that change its role.
const SUBPART_BEFORE = /\b(?:sentence|paragraph|phrase|clause)s?\s+of\s*$/i;
const CROSSREF_BEFORE =
  /\b(?:of|to|in|under|within|herein|pursuant\s+to|pursuant|this|set\s+forth\s+in)\s*$/i;

// The phrase's own sentence — the text after the last sentence boundary. This
// excludes a prior operation's quoted value (and any Section references embedded
// in it) from being mistaken for this operation's subject.
function phraseSentence(region: string): string {
  let end = 0;
  for (const m of region.matchAll(SENTENCE_BOUNDARY)) end = (m.index ?? 0) + m[0].length;
  return region.slice(end);
}

interface Subject {
  clause: string;
  subpart: boolean;
}

// The subject is the first "Section X" in the sentence that is a genuine subject:
// a sub-part subject ("the last sentence of Section X") keeps the clause but is
// unrecoverable; a cross-reference ("pursuant to Section X") is skipped; anything
// else is the whole-clause subject. No genuine subject -> null (e.g. the subject
// is a Schedule, a range, or "the following provision").
function resolveSubject(sentence: string): Subject | null {
  SECTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SECTION_RE.exec(sentence)) !== null) {
    const before = sentence.slice(0, m.index);
    if (SUBPART_BEFORE.test(before)) return { clause: m[1], subpart: true };
    if (CROSSREF_BEFORE.test(before)) continue;
    return { clause: m[1], subpart: false };
  }
  return null;
}

export function parseCitations(text: string): Citation[] {
  // 1. Locate every operative phrase, in document order.
  const phrases: { start: number; end: number; op: AmendmentOp; recoverable: boolean }[] = [];
  for (const { re, op, recoverable } of OP_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      phrases.push({ start, end: start + m[0].length, op, recoverable });
    }
  }
  phrases.sort((a, b) => a.start - b.start);

  // 2. The subject of each phrase is the FIRST "Section X" appearing since the
  //    previous phrase ended — which is the sentence subject, not an appositive
  //    cross-reference (those follow the subject) and not a prior sentence's
  //    clause (consumed by the previous phrase's region).
  const out: Citation[] = [];
  let regionStart = 0;
  for (const ph of phrases) {
    const sentence = phraseSentence(text.slice(regionStart, ph.start));
    const subj = resolveSubject(sentence);
    if (subj) {
      // "in its entirety" is necessary but NOT sufficient for recoverability: a
      // sub-part subject downgrades a restate/delete to an unrecoverable partial.
      const recoverable = ph.recoverable && !subj.subpart;
      const op = ph.recoverable && subj.subpart ? "partial" : ph.op;
      out.push({ clause: subj.clause, op, recoverable });
    }
    regionStart = ph.end;
  }
  return out;
}
