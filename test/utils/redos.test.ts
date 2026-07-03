import { describe, expect, it } from "vitest";
import { hasCatastrophicBacktracking } from "../../src/utils/redos.js";

describe("hasCatastrophicBacktracking", () => {
  // Patterns that can backtrack exponentially — must be flagged.
  const dangerous = [
    "(a+)+$",
    "(a*)*",
    "(a+)*",
    "([a-z]+)*",
    "(.*)*",
    "(.+)+",
    "(\\d+)+",
    "((ab+))+", // nested group, inner quantifier
    "(?:a+)+", // non-capturing group still risky
    "(a|a)*", // duplicate alternation branch
    "(a|ab)+", // one branch a prefix of another
    "(x+)+{2,}", // unbounded {n,} quantifier over a risky body
  ];

  // Linear-time patterns and common real-world validators — must NOT be flagged.
  const safe = [
    "^ADR-[0-9]+$",
    "(cat|dog)+", // disjoint alternation
    "(foo|bar|baz)*",
    "(abc)+", // quantified group, no inner quantifier or alternation
    "[a-z]+",
    "^a+$",
    "\\d{4}-\\d{2}-\\d{2}",
    "(ab){2,5}", // bounded quantifier over a group
    "a+b+c+", // sequential quantifiers, no nesting
    "[+*]+", // quantifier chars inside a class are literals
    "\\(a+\\)+", // escaped parens — not a real group
  ];

  for (const p of dangerous) {
    it(`flags ${p}`, () => {
      expect(hasCatastrophicBacktracking(p)).toBe(true);
    });
  }

  for (const p of safe) {
    it(`does not flag ${p}`, () => {
      expect(hasCatastrophicBacktracking(p)).toBe(false);
    });
  }
});
