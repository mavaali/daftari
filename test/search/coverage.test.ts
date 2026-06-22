import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeWindow,
  DEFAULT_COVERAGE_OPTIONS,
  detectSharedEntity,
} from "../../src/search/coverage.js";
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
});
