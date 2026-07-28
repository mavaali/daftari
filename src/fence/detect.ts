// Instruction-shaped-text detection. Pure: no LLM, no I/O, no state.
//
// This is the content-derived leg of the fence trigger (2026-07-27 read-path
// fence spec, Decision 2). It answers "does this text look like it is trying to
// instruct the reader" — never "is this text malicious", which is not a
// question a regex can answer. Its output is advisory in both places it is
// used: the fence adds framing, lint reports.

export type InjectionClass =
  | "override-instruction"
  | "role-impersonation"
  | "tool-solicitation"
  | "exfiltration";

// A match carries its class and where it starts, and NEVER the matched text.
// Echoing the payload into a LintFinding.detail would re-deliver it on the
// model-facing channel — the exact thing the fence exists to prevent.
export interface InjectionMatch {
  cls: InjectionClass;
  offset: number;
}

// Ordered so a document's findings read in a stable class order regardless of
// where the matches fall.
const CLASSES: readonly InjectionClass[] = [
  "override-instruction",
  "role-impersonation",
  "tool-solicitation",
  "exfiltration",
] as const;

const PATTERNS: Record<InjectionClass, readonly RegExp[]> = {
  "override-instruction": [
    /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any)\b[^.\n]{0,40}\b(instruction|prompt|rule|direction|guidance)/gi,
  ],
  "role-impersonation": [/^[ \t]*(system|assistant)[ \t]*:/gim, /<\/?(system|assistant)>/gi],
  "tool-solicitation": [
    /\bvault_(write|append|merge|set_tier|supersede|deprecate|ratify|stage_action)\s*\(/gi,
  ],
  exfiltration: [/\b(send|post|upload|exfiltrate|forward)\b[^.\n]{0,60}https?:\/\//gi],
};

// Classes evaluated against code-masked text rather than raw text.
//
// `system:` and `<assistant>` appear constantly in an engineering vault's code
// samples, transcripts and API docs, so scanning them raw makes the detector
// useless on exactly the corpus daftari is built for. The cost is a declared
// residual (spec residual 2): a role-impersonation payload inside a fenced code
// block is invisible to the fence trigger. That evasion costs the attacker
// three characters, so it is admitted for this one class only — the other three
// read raw text, where the same trick does not help.
const MASKED_CLASSES: ReadonlySet<InjectionClass> = new Set(["role-impersonation"]);

// Replaces fenced code block CONTENT with spaces, preserving both length and
// newlines so every offset and line number computed against the masked text is
// valid against the original. Blanking rather than deleting is the whole point.
//
// Open/close pairing follows CommonMark: a fence closes only on the SAME
// delimiter character, at least as long as the opener, with nothing but
// whitespace after it. Matching any fence-like line against any other is not a
// cosmetic shortcut — a document that shows a ``` example inside a ````` block
// has an odd number of fence-like lines, so a naive toggle ends the scan still
// "open" and blanks everything to EOF. Since masking gates the
// role-impersonation class, that would silently disable the one security-
// relevant detector for the rest of the file, far past the declared residual.
function blankRange(out: string[], from: number, to: number): void {
  for (let i = Math.max(0, from); i < Math.min(to, out.length); i += 1) {
    if (out[i] !== "\n") out[i] = " ";
  }
}

export function maskCode(text: string): string {
  const out = text.split("");
  const fenceLine = /^[ \t]*(`{3,}|~{3,})([^\n]*)$/;

  let openChar: string | null = null;
  let openLen = 0;
  let contentFrom = -1;
  let offset = 0;

  for (const line of text.split("\n")) {
    const m = fenceLine.exec(line);
    if (m !== null) {
      const delim = m[1];
      const char = delim[0];
      const len = delim.length;
      if (openChar === null) {
        // Opening fence. Its info string is legible; content starts next line.
        openChar = char;
        openLen = len;
        contentFrom = offset + line.length;
      } else if (char === openChar && len >= openLen && m[2].trim() === "") {
        blankRange(out, contentFrom, offset);
        openChar = null;
        contentFrom = -1;
      }
      // A fence-like line that does not satisfy the close rule is content of
      // the open block, and is blanked with the rest of it.
    }
    offset += line.length + 1; // +1 for the newline split() removed
  }

  // An unterminated fence blanks to end of text: a payload after an unclosed
  // ``` is inside a code block as far as every renderer is concerned.
  if (openChar !== null) blankRange(out, contentFrom, out.length);

  // Inline code spans, same treatment, same reason.
  const inline = /`[^`\n]+`/g;
  inline.lastIndex = 0;
  for (;;) {
    const m = inline.exec(text);
    if (m === null) break;
    blankRange(out, m.index + 1, m.index + m[0].length - 1);
  }
  return out.join("");
}

// Every instruction-shaped match in `text`, sorted by class order then offset.
// Returns [] for empty or benign input. Never throws.
export function detectInjection(text: string): InjectionMatch[] {
  if (text.length === 0) return [];
  let masked: string | null = null;
  const matches: InjectionMatch[] = [];

  for (const cls of CLASSES) {
    let subject = text;
    if (MASKED_CLASSES.has(cls)) {
      masked ??= maskCode(text);
      subject = masked;
    }
    for (const pattern of PATTERNS[cls]) {
      // Fresh lastIndex per use: the module-level regexes are /g and shared.
      pattern.lastIndex = 0;
      for (;;) {
        const m = pattern.exec(subject);
        if (m === null) break;
        matches.push({ cls, offset: m.index });
        // Zero-length matches cannot happen with these patterns, but a stuck
        // lastIndex would spin forever if one ever could.
        if (m[0].length === 0) pattern.lastIndex += 1;
      }
    }
  }

  matches.sort((a, b) => {
    const byClass = CLASSES.indexOf(a.cls) - CLASSES.indexOf(b.cls);
    return byClass !== 0 ? byClass : a.offset - b.offset;
  });
  return matches;
}

// The distinct classes present, in CLASSES order. This is what the fence
// predicate consumes — it needs "is this non-empty", not the match list.
export function injectionClasses(text: string): InjectionClass[] {
  const seen = new Set(detectInjection(text).map((m) => m.cls));
  return CLASSES.filter((c) => seen.has(c));
}

// 1-indexed line containing `offset`. Lint reports locations so that "the
// remedy is one ordinary write" is true rather than aspirational; a line number
// discloses nothing the operator cannot already read, unlike the matched text.
export function lineForOffset(text: string, offset: number): number {
  if (offset <= 0) return 1;
  const upto = offset < text.length ? offset : text.length;
  let line = 1;
  for (let i = 0; i < upto; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}
