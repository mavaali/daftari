// Best-effort static screen for regular expressions prone to catastrophic
// backtracking (ReDoS). Config-declared `pattern` fields are compiled and run
// against caller-supplied frontmatter on the write path; JS regex is
// synchronous, so a single pathological pattern (e.g. `(a+)+$`) can wedge the
// event loop for seconds-to-hours. We screen such patterns out at config load.
//
// ReDoS detection is undecidable in general — this is a conservative heuristic,
// not a proof. It catches the two footguns that account for virtually all
// real-world cases:
//   1. star height >= 2 — an unbounded quantifier applied to a group whose body
//      itself contains an unbounded quantifier: `(a+)+`, `(a*)*`, `([a-z]+)*`.
//   2. a quantified group over an alternation with overlapping branches:
//      `(a|a)*`, `(a|ab)*` — but NOT a disjoint set like `(cat|dog)+`.
// It is paired with a length cap on the value the regex runs against
// (frontmatter/schema.ts) as defense-in-depth against anything it misses.

// Removes escaped pairs (`\+`, `\.`) and character classes (`[a-z]`) so a
// literal quantifier char or a `+` inside a class isn't mistaken for a real
// quantifier. Both replacements are themselves linear-time.
function stripClassesAndEscapes(src: string): string {
  return src.replace(/\\./g, "").replace(/\[[^\]]*\]/g, "C");
}

// Splits an alternation body on top-level `|`, ignoring `|` nested inside groups.
function splitTopLevelAlternation(body: string): string[] {
  const branches: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "|" && depth === 0) {
      branches.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  branches.push(current);
  return branches;
}

// True when a quantified group's body would let the same input be consumed more
// than one way, the precondition for exponential backtracking.
function bodyIsRisky(body: string): boolean {
  const stripped = stripClassesAndEscapes(body);
  // Inner unbounded quantifier → star height >= 2.
  if (/[*+]/.test(stripped)) return true;
  if (/\{\d+,\}/.test(stripped)) return true;
  // Overlapping alternation: a duplicate branch, or one branch a prefix of
  // another (a|a, a|ab). Disjoint branches (cat|dog) are linear and allowed.
  if (stripped.includes("|")) {
    const branches = splitTopLevelAlternation(stripped).map((b) => b.trim());
    for (let i = 0; i < branches.length; i++) {
      for (let j = i + 1; j < branches.length; j++) {
        const a = branches[i];
        const b = branches[j];
        if (a.length === 0 || b.length === 0) continue;
        if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
      }
    }
  }
  return false;
}

// Returns true if `pattern` applies an unbounded quantifier (`*`, `+`, `{n,}`)
// to a group whose body is itself risky (see bodyIsRisky). Walks the pattern
// tracking group spans on a stack so nested groups are checked too.
export function hasCatastrophicBacktracking(pattern: string): boolean {
  const openStack: number[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++; // skip the escaped char
      continue;
    }
    if (ch === "(") {
      openStack.push(i);
    } else if (ch === ")" && openStack.length > 0) {
      const start = openStack.pop() as number;
      const next = pattern[i + 1];
      let quantified = next === "*" || next === "+";
      if (!quantified && next === "{") {
        // Unbounded upper bound `{n,}` — bounded `{n,m}` is not flagged.
        quantified = /^\{\d+,\}/.test(pattern.slice(i + 1));
      }
      if (quantified) {
        // Strip a leading group prefix like `?:`, `?=`, `?<name>`.
        const body = pattern.slice(start + 1, i).replace(/^\?[:=!]|^\?<[^>]*>/, "");
        if (bodyIsRisky(body)) return true;
      }
    }
  }
  return false;
}
