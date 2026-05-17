import { describe, expect, it } from "vitest";
import {
  buildBm25,
  searchBm25,
  tokenize,
  type Bm25Document,
} from "../../src/search/bm25.js";

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumeric runs", () => {
    expect(tokenize("Fabric Capacity SKUs (F2-F2048)")).toEqual([
      "fabric",
      "capacity",
      "skus",
      "f2",
      "f2048",
    ]);
  });

  it("drops stopwords and single characters", () => {
    expect(tokenize("the cost of a DBU is high")).toEqual([
      "cost",
      "dbu",
      "high",
    ]);
  });
});

describe("buildBm25 + searchBm25", () => {
  const docs: Bm25Document[] = [
    { path: "a.md", tokens: tokenize("databricks dbu consumption pricing model") },
    { path: "b.md", tokens: tokenize("fabric pooled capacity sku pricing") },
    { path: "c.md", tokens: tokenize("snowflake cortex llm governance story") },
  ];

  it("ranks the document with the strongest term overlap first", () => {
    const model = buildBm25(docs);
    const hits = searchBm25(model, tokenize("dbu consumption pricing"));
    expect(hits[0]?.path).toBe("a.md");
  });

  it("omits documents with zero query-term overlap", () => {
    const model = buildBm25(docs);
    const hits = searchBm25(model, tokenize("cortex governance"));
    expect(hits.map((h) => h.path)).toEqual(["c.md"]);
  });

  it("returns no hits when nothing matches", () => {
    const model = buildBm25(docs);
    expect(searchBm25(model, tokenize("kubernetes helm chart"))).toEqual([]);
  });

  it("scores rarer terms higher via IDF", () => {
    // 'pricing' appears in two of three docs; 'cortex' in one. A query on the
    // rarer term should rank its document above the common-term match.
    const model = buildBm25(docs);
    const hits = searchBm25(model, tokenize("cortex"));
    const common = searchBm25(model, tokenize("pricing"));
    const cortexScore = hits[0]?.score ?? 0;
    const pricingTop = common[0]?.score ?? 0;
    expect(cortexScore).toBeGreaterThan(pricingTop);
  });
});
