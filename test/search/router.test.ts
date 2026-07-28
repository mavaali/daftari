// Query router tests (spec 2026-07-26 fusion overhaul, Decision 2).

import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS } from "../../src/search/hybrid.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import { reindexVault } from "../../src/search/reindex.js";
import {
  classifyQuery,
  makeDfLookup,
  type RouteClass,
  routeWeights,
} from "../../src/search/router.js";
import { type IndexDb, openIndexDb } from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

describe("classifyQuery — fixture table, one query per signal", () => {
  const cases: [query: string, expected: RouteClass, signal: string][] = [
    [`"exact phrase"`, "extreme-lexical", "quoted-phrase"],
    ["src/search/hybrid.ts", "extreme-lexical", "path-like"],
    ["config.yaml", "extreme-lexical", "path-like"],
    ["processTensionDocket", "lexical", "camel-case"],
    ["tension_scan", "lexical", "snake-case"],
    ["PR 303", "lexical", "digit-heavy"],
    ["2026-07-26", "lexical", "digit-heavy"],
    ["how do write locks expire", "balanced", ""],
  ];

  for (const [query, expected, signal] of cases) {
    it(`classifies "${query}" as ${expected}`, () => {
      const result = classifyQuery(query);
      expect(result.class).toBe(expected);
      if (signal) expect(result.signals).toContain(signal);
      else expect(result.signals).toEqual([]);
    });
  }
});

describe("classifyQuery — rare-term signal (injected stub df)", () => {
  const RICH_DOC_COUNT = 100;

  it("fires lexical when df === 1", () => {
    const result = classifyQuery("zephyr", {
      df: () => 1,
      docCount: RICH_DOC_COUNT,
    });
    expect(result.class).toBe("lexical");
    expect(result.signals).toContain("rare-term");
  });

  it("fires lexical when df === DF_RARE_FLOOR (2)", () => {
    const result = classifyQuery("zephyr", {
      df: () => 2,
      docCount: RICH_DOC_COUNT,
    });
    expect(result.class).toBe("lexical");
    expect(result.signals).toContain("rare-term");
  });

  it("does not fire when df === 3 (above the floor)", () => {
    const result = classifyQuery("zephyr", {
      df: () => 3,
      docCount: RICH_DOC_COUNT,
    });
    expect(result.class).toBe("balanced");
    expect(result.signals).not.toContain("rare-term");
  });

  it("never fires when df === 0 (absent from corpus)", () => {
    const result = classifyQuery("zephyr", {
      df: () => 0,
      docCount: RICH_DOC_COUNT,
    });
    expect(result.class).toBe("balanced");
    expect(result.signals).not.toContain("rare-term");
  });

  it("never fires when the vault holds fewer than MIN_DOCS_FOR_RARE (100) documents", () => {
    const result = classifyQuery("zephyr", {
      df: () => 1,
      docCount: 99,
    });
    expect(result.class).toBe("balanced");
    expect(result.signals).not.toContain("rare-term");
  });

  it("never fires when docCount is absent, even with a df function", () => {
    const result = classifyQuery("zephyr", { df: () => 1 });
    expect(result.class).toBe("balanced");
    expect(result.signals).not.toContain("rare-term");
  });

  it("never fires when df is absent, even with a rich docCount", () => {
    const result = classifyQuery("zephyr", { docCount: RICH_DOC_COUNT });
    expect(result.class).toBe("balanced");
    expect(result.signals).not.toContain("rare-term");
  });
});

describe("classifyQuery — precedence and signals array", () => {
  it("an extreme signal wins even when a lexical signal also fires", () => {
    const result = classifyQuery(`"exact phrase" tension_scan`);
    expect(result.class).toBe("extreme-lexical");
    // Both signals are reported, even though only the extreme one decided the class.
    expect(result.signals).toContain("quoted-phrase");
    expect(result.signals).toContain("snake-case");
  });

  it("is deterministic across repeated calls", () => {
    const first = classifyQuery("src/search/hybrid.ts and tension_scan");
    const second = classifyQuery("src/search/hybrid.ts and tension_scan");
    expect(second).toEqual(first);
  });
});

describe("routeWeights", () => {
  it("maps extreme-lexical to pure lexical weights", () => {
    expect(routeWeights("extreme-lexical")).toEqual({ bm25: 1, vector: 0 });
  });

  it("maps lexical to a lexical-leaning split", () => {
    expect(routeWeights("lexical")).toEqual({ bm25: 0.8, vector: 0.2 });
  });

  it("maps balanced to the library default weights", () => {
    expect(routeWeights("balanced")).toEqual(DEFAULT_WEIGHTS);
  });
});

describe("makeDfLookup — real indexed handle (stem-aware df)", () => {
  let vault: string;
  let db: IndexDb;

  it("counts stemmed postings and returns 0 for an absent token", async () => {
    vault = makeTempVault();
    try {
      const reindexed = await reindexVault(vault);
      expect(reindexed.ok).toBe(true);
      if (!reindexed.ok) return;
      const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      db = opened.value;
      try {
        const df = makeDfLookup(db);
        // "pricing" appears in the sample vault (see hybrid.test.ts's
        // CREDIT_DOC fixture); its stemmed form should count "pricing" and
        // any morphological variant FTS5's porter tokenizer folds to it.
        expect(df("pricing")).toBeGreaterThanOrEqual(1);
        expect(df("zzzqx")).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      cleanupVault(vault);
    }
  }, 60_000);
});
