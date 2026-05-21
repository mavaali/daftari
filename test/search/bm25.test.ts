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
