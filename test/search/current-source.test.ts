import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCurrentSource } from "../../src/search/current-source.js";
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
    collection: over.collection ?? "pricing",
    domain: "accumulation",
    status: over.status ?? "canonical",
    confidence: "high",
    updated: "2026-05-01",
    tags: [],
    content: over.content ?? "body text",
    tokens: [],
    ttlDays: null,
    created: "2026-01-01",
    supersededBy: over.supersededBy ?? null,
  };
}

describe("resolveCurrentSource", () => {
  let vault: string;
  let db: IndexDb;

  beforeEach(() => {
    vault = makeTempVault();
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!opened.ok) throw opened.error;
    db = opened.value;
  });
  afterEach(() => {
    db.close();
    cleanupVault(vault);
  });

  it("returns null for a non-superseded document", () => {
    insertDocument(db, doc({ path: "a.md" }));
    expect(resolveCurrentSource(db, "a.md")).toBeNull();
  });

  it("resolves a single hop to the successor", () => {
    insertDocument(db, doc({ path: "a.md", status: "superseded", supersededBy: "b.md" }));
    insertDocument(db, doc({ path: "b.md", title: "B", content: "the current value is 465" }));
    const cs = resolveCurrentSource(db, "a.md");
    expect(cs).toEqual({
      kind: "resolved",
      path: "b.md",
      title: "B",
      snippet: "the current value is 465",
      hops: 1,
    });
  });

  it("walks a chain to the terminal head and counts hops", () => {
    insertDocument(db, doc({ path: "a.md", status: "superseded", supersededBy: "b.md" }));
    insertDocument(db, doc({ path: "b.md", status: "superseded", supersededBy: "c.md" }));
    insertDocument(db, doc({ path: "c.md", title: "C", content: "terminal head" }));
    const cs = resolveCurrentSource(db, "a.md");
    expect(cs).toMatchObject({ kind: "resolved", path: "c.md", title: "C", hops: 2 });
  });
});
