import { describe, expect, it } from "vitest";
import { type Bm25Document, buildBm25, searchBm25, tokenize } from "../../src/search/bm25.js";

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

describe("buildBm25 + searchBm25", () => {
  const docs: Bm25Document[] = [
    { path: "a.md", tokens: tokenize("helios credit consumption pricing model") },
    { path: "b.md", tokens: tokenize("cirrus pooled capacity tier pricing") },
    { path: "c.md", tokens: tokenize("vega insight llm governance story") },
  ];

  it("ranks the document with the strongest term overlap first", () => {
    const model = buildBm25(docs);
    const hits = searchBm25(model, tokenize("credit consumption pricing"));
    expect(hits[0]?.path).toBe("a.md");
  });

  it("omits documents with zero query-term overlap", () => {
    const model = buildBm25(docs);
    const hits = searchBm25(model, tokenize("insight governance"));
    expect(hits.map((h) => h.path)).toEqual(["c.md"]);
  });

  it("returns no hits when nothing matches", () => {
    const model = buildBm25(docs);
    expect(searchBm25(model, tokenize("kubernetes helm chart"))).toEqual([]);
  });

  it("scores rarer terms higher via IDF", () => {
    // 'pricing' appears in two of three docs; 'insight' in one. A query on the
    // rarer term should rank its document above the common-term match.
    const model = buildBm25(docs);
    const hits = searchBm25(model, tokenize("insight"));
    const common = searchBm25(model, tokenize("pricing"));
    const insightScore = hits[0]?.score ?? 0;
    const pricingTop = common[0]?.score ?? 0;
    expect(insightScore).toBeGreaterThan(pricingTop);
  });
});
