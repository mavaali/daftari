import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyCoveragePass,
  computeWindow,
  DEFAULT_COVERAGE_OPTIONS,
  detectSharedEntity,
  enforceTokenCap,
} from "../../src/search/coverage.js";
import type { CurrentSource } from "../../src/search/current-source.js";
import type { HybridHit } from "../../src/search/hybrid.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import {
  type IndexDb,
  type IndexedDocument,
  insertDocument,
  openIndexDb,
} from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

function doc(over: Partial<IndexedDocument> & { path: string }): IndexedDocument {
  return {
    path: over.path,
    title: over.title ?? over.path,
    collection: over.collection ?? "notes",
    domain: "accumulation",
    status: over.status ?? "canonical",
    confidence: "high",
    updated: over.updated ?? "2026-05-01",
    tags: over.tags ?? [],
    content: over.content ?? "body",
    tokens: [],
    ttlDays: null,
    created: over.created ?? "2026-01-01",
    supersededBy: over.supersededBy ?? null,
  };
}
function hit(path: string): HybridHit {
  return {
    path,
    title: path,
    collection: "notes",
    status: "canonical",
    score: 1,
    bm25Score: 1,
    vectorScore: 0,
    snippet: "",
    decay: null,
  };
}

describe("detectSharedEntity", () => {
  let vault: string;
  let db: IndexDb;
  beforeEach(() => {
    vault = makeTempVault();
    const o = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!o.ok) throw o.error;
    db = o.value;
  });
  afterEach(() => {
    db.close();
    cleanupVault(vault);
  });

  it("returns the tag shared by >=2 of the top-K seeds", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["spectral", "muon"] }));
    insertDocument(db, doc({ path: "b.md", tags: ["spectral", "optimizer"] }));
    insertDocument(db, doc({ path: "c.md", tags: ["unrelated"] }));
    expect(
      detectSharedEntity(
        db,
        [hit("a.md"), hit("b.md"), hit("c.md")],
        DEFAULT_COVERAGE_OPTIONS.seedK,
      ),
    ).toBe("spectral");
  });

  it("returns null when no tag appears in >=2 seeds", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["x"] }));
    insertDocument(db, doc({ path: "b.md", tags: ["y"] }));
    expect(
      detectSharedEntity(db, [hit("a.md"), hit("b.md")], DEFAULT_COVERAGE_OPTIONS.seedK),
    ).toBeNull();
  });

  it("breaks count ties alphabetically for determinism", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["zeta", "alpha"] }));
    insertDocument(db, doc({ path: "b.md", tags: ["zeta", "alpha"] }));
    expect(detectSharedEntity(db, [hit("a.md"), hit("b.md")], DEFAULT_COVERAGE_OPTIONS.seedK)).toBe(
      "alpha",
    );
  });

  it("only considers the top seedK hits", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["shared"] }));
    insertDocument(db, doc({ path: "b.md", tags: ["nope1"] })); // distinct tags so the
    insertDocument(db, doc({ path: "c.md", tags: ["nope2"] })); // top-3 form NO pair
    insertDocument(db, doc({ path: "d.md", tags: ["shared"] })); // 4th — outside seedK=3
    expect(
      detectSharedEntity(db, [hit("a.md"), hit("b.md"), hit("c.md"), hit("d.md")], 3),
    ).toBeNull();
  });
});

describe("computeWindow", () => {
  let vault: string;
  let db: IndexDb;
  beforeEach(() => {
    vault = makeTempVault();
    const o = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!o.ok) throw o.error;
    db = o.value;
  });
  afterEach(() => {
    db.close();
    cleanupVault(vault);
  });

  it("spans the entity-bearing seeds' created dates padded by padDays", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["e"], created: "2026-03-10" }));
    insertDocument(db, doc({ path: "b.md", tags: ["e"], created: "2026-03-20" }));
    const w = computeWindow(db, [hit("a.md"), hit("b.md")], "e", {
      ...DEFAULT_COVERAGE_OPTIONS,
      padDays: 5,
    });
    expect(w).toEqual({ start: "2026-03-05", end: "2026-03-25" });
  });

  it("ignores seeds that lack the entity or a created date", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["e"], created: "2026-03-10" }));
    insertDocument(db, doc({ path: "b.md", tags: ["other"], created: "2026-09-01" }));
    const w = computeWindow(db, [hit("a.md"), hit("b.md")], "e", {
      ...DEFAULT_COVERAGE_OPTIONS,
      padDays: 0,
    });
    expect(w).toEqual({ start: "2026-03-10", end: "2026-03-10" });
  });

  it("clamps the window end to maxSpanDays from the start", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["e"], created: "2026-01-01" }));
    insertDocument(db, doc({ path: "b.md", tags: ["e"], created: "2026-12-01" }));
    const w = computeWindow(db, [hit("a.md"), hit("b.md")], "e", {
      ...DEFAULT_COVERAGE_OPTIONS,
      padDays: 0,
      maxSpanDays: 90,
    });
    expect(w?.start).toBe("2026-01-01");
    expect(w?.end).toBe("2026-04-01"); // 2026-01-01 + 90 days
  });

  it("returns null when no entity-bearing seed has a date", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["e"], created: "" }));
    expect(computeWindow(db, [hit("a.md")], "e", DEFAULT_COVERAGE_OPTIONS)).toBeNull();
  });

  it("ignores an unparseable seed date instead of throwing", () => {
    // insertDocument normalizes recoverable dates (2026-3-1 -> 2026-03-01) and
    // stores "" for unparseable ones, so the index never hands computeWindow a
    // poison string. A slash date lands as "" -> the seed is skipped; only
    // good.md's date defines the window.
    insertDocument(db, doc({ path: "bad.md", tags: ["e"], created: "2026/03/01" }));
    insertDocument(db, doc({ path: "good.md", tags: ["e"], created: "2026-06-08" }));
    const call = () =>
      computeWindow(db, [hit("bad.md"), hit("good.md")], "e", {
        ...DEFAULT_COVERAGE_OPTIONS,
        padDays: 0,
      });
    expect(call).not.toThrow();
    expect(call()).toEqual({ start: "2026-06-08", end: "2026-06-08" });
  });

  it("returns null when all entity-bearing seeds have malformed dates", () => {
    insertDocument(db, doc({ path: "bad.md", tags: ["e"], created: "March 2026" }));
    expect(computeWindow(db, [hit("bad.md")], "e", DEFAULT_COVERAGE_OPTIONS)).toBeNull();
  });
});

describe("applyCoveragePass", () => {
  let vault: string;
  let db: IndexDb;
  beforeEach(() => {
    vault = makeTempVault();
    const o = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!o.ok) throw o.error;
    db = o.value;
  });
  afterEach(() => {
    db.close();
    cleanupVault(vault);
  });

  it("returns hits unchanged when no tag is shared by >=2 seeds (quiet)", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["x"], created: "2026-03-01" }));
    insertDocument(db, doc({ path: "b.md", tags: ["y"], created: "2026-03-02" }));
    const hits = [hit("a.md"), hit("b.md")];
    expect(applyCoveragePass(db, hits, DEFAULT_COVERAGE_OPTIONS)).toEqual(hits);
  });

  it("appends same-entity in-window docs not already present, flagged viaCoverage", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["spectral"], created: "2026-03-10" }));
    insertDocument(db, doc({ path: "b.md", tags: ["spectral"], created: "2026-03-12" }));
    insertDocument(
      db,
      doc({
        path: "c.md",
        tags: ["spectral"],
        created: "2026-03-11",
        content: "missed cluster member",
      }),
    );
    const hits = [hit("a.md"), hit("b.md")];
    const out = applyCoveragePass(db, hits, DEFAULT_COVERAGE_OPTIONS);
    expect(out.map((h) => h.path)).toEqual(["a.md", "b.md", "c.md"]);
    const added = out[2];
    expect(added.viaCoverage).toBe(true);
    expect(added.coverageReason).toBe("entity-window");
    expect(added.snippet).toContain("missed cluster member");
  });

  it("excludes docs already in the result set", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["e"], created: "2026-03-10" }));
    insertDocument(db, doc({ path: "b.md", tags: ["e"], created: "2026-03-11" }));
    const out = applyCoveragePass(db, [hit("a.md"), hit("b.md")], DEFAULT_COVERAGE_OPTIONS);
    expect(out.map((h) => h.path)).toEqual(["a.md", "b.md"]); // nothing new to add → quiet
  });

  it("caps additions at maxAdd, recency-first", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["e"], created: "2026-03-01" }));
    insertDocument(db, doc({ path: "b.md", tags: ["e"], created: "2026-03-02" }));
    // extras sit inside the window (seed span 03-01..03-02 padded by 7 → 02-22..03-09)
    for (let i = 0; i < 5; i++)
      insertDocument(db, doc({ path: `extra-${i}.md`, tags: ["e"], created: `2026-03-0${i + 3}` }));
    const out = applyCoveragePass(db, [hit("a.md"), hit("b.md")], {
      ...DEFAULT_COVERAGE_OPTIONS,
      maxAdd: 2,
    });
    const addedPaths = out.filter((h) => h.viaCoverage).map((h) => h.path);
    expect(addedPaths).toEqual(["extra-4.md", "extra-3.md"]); // two most recent (03-07, 03-06)
  });

  it("does not throw when a same-tag in-window doc has a malformed created date", () => {
    insertDocument(db, doc({ path: "a.md", tags: ["e"], created: "2026-03-10" }));
    insertDocument(db, doc({ path: "b.md", tags: ["e"], created: "2026-03-12" }));
    // A same-tag doc with a malformed created value the indexer may still store.
    insertDocument(db, doc({ path: "poison.md", tags: ["e"], created: "2026-13-45" }));
    const hits = [hit("a.md"), hit("b.md")];
    expect(() => applyCoveragePass(db, hits, DEFAULT_COVERAGE_OPTIONS)).not.toThrow();
  });
});

describe("enforceTokenCap", () => {
  const STALE: CurrentSource = { kind: "resolved", path: "x.md", title: "x", snippet: "", hops: 1 };

  function cov(path: string, snippet: string, stale = false): HybridHit {
    return {
      path,
      title: path,
      collection: "notes",
      status: "canonical",
      score: 0,
      bm25Score: 0,
      vectorScore: 0,
      snippet,
      decay: null,
      viaCoverage: true,
      coverageReason: "entity-window",
      ...(stale ? { currentSource: STALE } : {}),
    };
  }

  it("never drops original (non-coverage) hits even over budget", () => {
    const original = { ...hit("a.md"), snippet: "x".repeat(100) };
    const out = enforceTokenCap([original], { ...DEFAULT_COVERAGE_OPTIONS, tokenCapChars: 0 });
    expect(out).toEqual([original]);
  });

  it("evicts stale coverage docs before fresh ones when over budget", () => {
    const fresh = cov("fresh.md", "y".repeat(50));
    const stale = cov("stale.md", "z".repeat(50), true);
    // budget fits only one coverage doc
    const out = enforceTokenCap([hit("a.md"), stale, fresh], {
      ...DEFAULT_COVERAGE_OPTIONS,
      tokenCapChars: 60,
    });
    expect(out.map((h) => h.path)).toEqual(["a.md", "fresh.md"]);
  });

  it("returns the list unchanged when under budget", () => {
    const fresh = cov("fresh.md", "short");
    const list = [hit("a.md"), fresh];
    expect(enforceTokenCap(list, DEFAULT_COVERAGE_OPTIONS)).toEqual(list);
  });

  it("treats a non-resolved currentSource as fresh (only resolved counts as stale)", () => {
    const dangling = {
      ...cov("dangling.md", "y".repeat(50)),
      currentSource: { kind: "dangling", brokenAt: "x.md" } as CurrentSource,
    };
    const resolvedStale = cov("stale.md", "z".repeat(50), true);
    // budget fits only one coverage doc; resolved-stale should be evicted, the
    // dangling one survives because dangling is not a genuine successor.
    const out = enforceTokenCap([hit("a.md"), resolvedStale, dangling], {
      ...DEFAULT_COVERAGE_OPTIONS,
      tokenCapChars: 60,
    });
    expect(out.map((h) => h.path)).toEqual(["a.md", "dangling.md"]);
  });
});
