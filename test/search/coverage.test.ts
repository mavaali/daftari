import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COVERAGE_OPTIONS, detectSharedEntity } from "../../src/search/coverage.js";
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
