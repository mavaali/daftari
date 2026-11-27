import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { AMENDED_BY_CAP, amendedByFor } from "../../src/search/amended-by.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import {
  clearIndex,
  deleteDocument,
  type IndexDb,
  type IndexedDocument,
  insertDocument,
  openIndexDb,
  replaceDocAmends,
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
    supersededBy: null,
  };
}

function accessReading(...collections: string[]): AccessContext {
  return {
    user: "u",
    roleName: "r",
    role: { read: collections, write: [], promote: false, ratify: false },
  };
}

describe("amendedByFor", () => {
  let vault: string;
  let db: IndexDb;

  beforeEach(() => {
    vault = makeTempVault();
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!opened.ok) throw opened.error;
    db = opened.value;
    insertDocument(db, doc({ path: "pricing/a.md" }));
  });
  afterEach(() => {
    db.close();
    cleanupVault(vault);
  });

  it("returns null for a document nothing amends", () => {
    expect(amendedByFor(db, "pricing/a.md")).toBeNull();
  });

  it("reports the amender with its title, status and a body preview", () => {
    insertDocument(
      db,
      doc({ path: "pricing/b.md", title: "B", status: "draft", content: "Re-enabled  today." }),
    );
    replaceDocAmends(db, "pricing/b.md", ["pricing/a.md"]);

    expect(amendedByFor(db, "pricing/a.md")).toEqual({
      amendedBy: [
        { path: "pricing/b.md", title: "B", status: "draft", snippet: "Re-enabled today." },
      ],
      amendedByCount: 1,
    });
  });

  it("matches an aliased target against the canonical path", () => {
    insertDocument(db, doc({ path: "pricing/b.md" }));
    replaceDocAmends(db, "pricing/b.md", ["./pricing/x/../a.md"]);
    expect(amendedByFor(db, "pricing/a.md")?.amendedByCount).toBe(1);
  });

  it("a document does not amend itself", () => {
    replaceDocAmends(db, "pricing/a.md", ["pricing/a.md"]);
    expect(amendedByFor(db, "pricing/a.md")).toBeNull();
  });

  it("reports direct amenders only, one hop", () => {
    insertDocument(db, doc({ path: "pricing/b.md" }));
    insertDocument(db, doc({ path: "pricing/c.md" }));
    replaceDocAmends(db, "pricing/b.md", ["pricing/a.md"]);
    replaceDocAmends(db, "pricing/c.md", ["pricing/b.md"]);
    expect(amendedByFor(db, "pricing/a.md")?.amendedBy.map((e) => e.path)).toEqual([
      "pricing/b.md",
    ]);
  });

  it("caps the list and keeps the visible total", () => {
    const extra = AMENDED_BY_CAP + 2;
    for (let i = 0; i < extra; i++) {
      insertDocument(db, doc({ path: `pricing/b${i}.md` }));
      replaceDocAmends(db, `pricing/b${i}.md`, ["pricing/a.md"]);
    }
    const res = amendedByFor(db, "pricing/a.md");
    expect(res?.amendedBy).toHaveLength(AMENDED_BY_CAP);
    expect(res?.amendedByCount).toBe(extra);
  });

  // Omission, not a `restricted` marker: A's own bytes carry no mark, so any
  // signal here would be derived purely from a hidden document (#217).
  it("omits an unreadable amender: no entry, no count, no marker", () => {
    insertDocument(db, doc({ path: "secret/b.md", collection: "secret" }));
    replaceDocAmends(db, "secret/b.md", ["pricing/a.md"]);

    expect(amendedByFor(db, "pricing/a.md", accessReading("pricing"))).toBeNull();
    expect(amendedByFor(db, "pricing/a.md", accessReading("pricing", "secret"))).not.toBeNull();
  });

  it("does not let hidden amenders inflate the visible count", () => {
    insertDocument(db, doc({ path: "pricing/b.md" }));
    insertDocument(db, doc({ path: "secret/b.md", collection: "secret" }));
    replaceDocAmends(db, "pricing/b.md", ["pricing/a.md"]);
    replaceDocAmends(db, "secret/b.md", ["pricing/a.md"]);

    expect(amendedByFor(db, "pricing/a.md", accessReading("pricing"))).toMatchObject({
      amendedBy: [{ path: "pricing/b.md" }],
      amendedByCount: 1,
    });
  });

  it("a deleted amender stops surfacing", () => {
    insertDocument(db, doc({ path: "pricing/b.md" }));
    replaceDocAmends(db, "pricing/b.md", ["pricing/a.md"]);
    deleteDocument(db, "pricing/b.md");
    expect(amendedByFor(db, "pricing/a.md")).toBeNull();
  });

  it("clearIndex drops the rows", () => {
    insertDocument(db, doc({ path: "pricing/b.md" }));
    replaceDocAmends(db, "pricing/b.md", ["pricing/a.md"]);
    clearIndex(db);
    insertDocument(db, doc({ path: "pricing/a.md" }));
    insertDocument(db, doc({ path: "pricing/b.md" }));
    expect(amendedByFor(db, "pricing/a.md")).toBeNull();
  });
});
