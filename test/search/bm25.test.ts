import { describe, expect, it } from "vitest";
import { buildMatchQuery, tokenize } from "../../src/search/bm25.js";

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumeric runs", () => {
    expect(tokenize("Cirrus Capacity Tiers (C2-C2048)")).toEqual([
      "cirrus",
      "capacity",
      "tiers",
      "c2",
      "c2048",
    ]);
  });

  it("drops stopwords and single characters", () => {
    expect(tokenize("the cost of a credit is high")).toEqual(["cost", "credit", "high"]);
  });
});

describe("buildMatchQuery", () => {
  it("turns a free-text query into a prefix-OR'd FTS5 MATCH string", () => {
    expect(buildMatchQuery("cirrus pricing")).toBe("cirrus* OR pricing*");
  });

  it("deduplicates repeated tokens", () => {
    expect(buildMatchQuery("pricing PRICING pricing model")).toBe("pricing* OR model*");
  });

  it("strips stopwords and 1-character fragments before assembling", () => {
    expect(buildMatchQuery("the cost of a credit is high")).toBe("cost* OR credit* OR high*");
  });

  it("returns null when the query has no usable tokens", () => {
    expect(buildMatchQuery("   ")).toBeNull();
    expect(buildMatchQuery("a the of")).toBeNull(); // all stopwords
    expect(buildMatchQuery("?? !! ##")).toBeNull(); // all punctuation
  });

  it("does not throw on FTS5-meaningful characters in the user query", () => {
    // The tokenizer strips every non-alphanumeric, so quotes, hyphens,
    // wildcards, and the bare reserved words AND/OR/NOT all collapse to
    // safe lowercase barewords before the MATCH string is assembled.
    // The token 'or' (FTS5's operator in uppercase) is a stopword and
    // gets dropped; the surviving tokens are joined with literal ' OR '
    // operators.
    expect(() => buildMatchQuery(`"cirrus" AND "pricing"`)).not.toThrow();
    expect(() => buildMatchQuery(`cirrus-pricing*`)).not.toThrow();
    expect(() => buildMatchQuery(`NOT pricing`)).not.toThrow();
    // The shape of the output is well-defined: tokens lowercased,
    // alphanumeric-only, OR-joined.
    expect(buildMatchQuery(`"cirrus" AND "pricing"`)).toBe("cirrus* OR pricing*");
  });
});

describe("buildMatchQuery — phrase emission (Decision 2)", () => {
  it("adds a phrase branch for a quoted span of >= 2 usable tokens", () => {
    // The prefix-OR branches for the individual tokens survive UNCHANGED —
    // the phrase branch is an ADDITION, not a replacement (recall-non-shrinking).
    expect(buildMatchQuery(`"cirrus pricing"`)).toBe('cirrus* OR pricing* OR "cirrus pricing"');
  });

  it("tokenizes the phrase's contents the same way as the rest of the query", () => {
    // Stopwords/punctuation inside the quotes are dropped before the phrase
    // is assembled, exactly like the prefix-token path.
    expect(buildMatchQuery(`"the Cirrus-Pricing, model!"`)).toBe(
      'cirrus* OR pricing* OR model* OR "cirrus pricing model"',
    );
  });

  it("degrades to today's behaviour for a single-token quoted span", () => {
    expect(buildMatchQuery(`"cirrus"`)).toBe("cirrus*");
  });

  it("degrades to today's behaviour for an empty or stopword-only quoted span", () => {
    expect(buildMatchQuery(`""`)).toBe(null);
    expect(buildMatchQuery(`"the of"`)).toBe(null);
  });

  it("degrades to today's behaviour for a stray unmatched quote", () => {
    expect(buildMatchQuery(`cirrus "pricing`)).toBe("cirrus* OR pricing*");
  });

  it("handles multiple quoted phrases in one query, each its own branch", () => {
    expect(buildMatchQuery(`"cirrus pricing" and "capacity tiers"`)).toBe(
      'cirrus* OR pricing* OR capacity* OR tiers* OR "cirrus pricing" OR "capacity tiers"',
    );
  });

  it("deduplicates an identical phrase branch", () => {
    expect(buildMatchQuery(`"cirrus pricing" "cirrus pricing"`)).toBe(
      'cirrus* OR pricing* OR "cirrus pricing"',
    );
  });

  it("recall superset property: every document matching the old prefix-only query still matches", () => {
    // The phrase branch is OR'd in alongside every prefix branch the
    // pre-Decision-2 query produced — so the new MATCH string is a strict
    // superset match, never a subset.
    const withPhrase = buildMatchQuery(`"cirrus pricing"`);
    const prefixOnly = "cirrus* OR pricing*";
    expect(withPhrase).not.toBeNull();
    expect(withPhrase?.startsWith(prefixOnly)).toBe(true);
  });
});
