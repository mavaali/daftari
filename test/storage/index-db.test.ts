import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import { reindexVault } from "../../src/search/reindex.js";
import {
  blobToEmbedding,
  clearIndex,
  collectionForPath,
  deleteDocument,
  documentCount,
  embeddingCount,
  embeddingToBlob,
  existingEmbeddingHashes,
  gcOrphanedEmbeddings,
  getAllChunks,
  getAllDocuments,
  getChunksForPath,
  getDocument,
  getDocumentsInDateRange,
  getMeta,
  type IndexDb,
  type IndexedDocument,
  insertChunkRow,
  insertDocument,
  insertEmbedding,
  insertEmbeddingVec,
  openIndexDb,
  setMeta,
} from "../../src/storage/index-db.js";
import { sha256Hex } from "../../src/utils/hash.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const MODEL = "test-model-v1";

const sampleDoc: IndexedDocument = {
  path: "pricing/foo.md",
  title: "Foo",
  collection: "pricing",
  domain: "accumulation",
  status: "canonical",
  confidence: "high",
  updated: "2026-05-01",
  tags: ["foo", "bar"],
  content: "the body text",
  tokens: ["body", "text"],
  ttlDays: null,
  created: "2026-01-01",
  supersededBy: null,
};

describe("index-db", () => {
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

  it("round-trips a document through insert and read", () => {
    insertDocument(db, sampleDoc);
    expect(documentCount(db)).toBe(1);
    const read = getDocument(db, "pricing/foo.md");
    expect(read).toEqual(sampleDoc);
    expect(getAllDocuments(db)).toEqual([sampleDoc]);
  });

  it("round-trips a chunk and its embedding via the join", () => {
    const text = "chunk text";
    const hash = sha256Hex(text);
    const embedding = new Float32Array([0.1, -0.2, 0.33, 1.5]);
    insertChunkRow(db, {
      path: "pricing/foo.md",
      chunkIndex: 0,
      text,
      contentHash: hash,
    });
    insertEmbedding(db, hash, MODEL, embedding, "2026-05-20T00:00:00Z", embedding.length);
    const chunks = getChunksForPath(db, "pricing/foo.md", MODEL);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.contentHash).toBe(hash);
    expect(chunks[0]?.embedding && [...chunks[0].embedding]).toEqual([...embedding]);
  });

  it("returns null embedding when no row exists for the requested model", () => {
    const text = "chunk text";
    const hash = sha256Hex(text);
    insertChunkRow(db, {
      path: "pricing/foo.md",
      chunkIndex: 0,
      text,
      contentHash: hash,
    });
    // No insertEmbedding call — the join falls back to NULL.
    expect(getAllChunks(db, MODEL)[0]?.embedding).toBeNull();
  });

  it("preserves Float32 values exactly through blob conversion", () => {
    const vec = new Float32Array([1, 2.5, -3.75]);
    const restored = blobToEmbedding(embeddingToBlob(vec));
    expect([...restored]).toEqual([...vec]);
  });

  it("clearIndex empties documents and chunks but preserves embeddings", () => {
    insertDocument(db, sampleDoc);
    const text = "x";
    const hash = sha256Hex(text);
    insertChunkRow(db, {
      path: "pricing/foo.md",
      chunkIndex: 0,
      text,
      contentHash: hash,
    });
    insertEmbedding(db, hash, MODEL, new Float32Array([1, 2, 3]), "2026-05-20T00:00:00Z", 3);
    clearIndex(db);
    expect(documentCount(db)).toBe(0);
    expect(getAllChunks(db, MODEL)).toEqual([]);
    // The cache survives: a subsequent reindex of identical content avoids a
    // re-embed. Orphan rows are reaped by gcOrphanedEmbeddings, not clearIndex.
    expect(embeddingCount(db)).toBe(1);
  });

  it("stores and reads meta values", () => {
    expect(getMeta(db, "missing")).toBeNull();
    setMeta(db, "vector_enabled", "true");
    expect(getMeta(db, "vector_enabled")).toBe("true");
  });

  it("round-trips decay fields (ttlDays, created, supersededBy)", () => {
    const doc: IndexedDocument = {
      ...sampleDoc,
      path: "pricing/decay.md",
      ttlDays: 90,
      created: "2026-03-15",
      supersededBy: "pricing/new.md",
    };
    insertDocument(db, doc);
    const read = getDocument(db, "pricing/decay.md");
    expect(read?.ttlDays).toBe(90);
    expect(read?.created).toBe("2026-03-15");
    expect(read?.supersededBy).toBe("pricing/new.md");
  });

  it("round-trips null ttlDays and null supersededBy", () => {
    const doc: IndexedDocument = {
      ...sampleDoc,
      path: "pricing/null-decay.md",
      ttlDays: null,
      created: "2026-04-01",
      supersededBy: null,
    };
    insertDocument(db, doc);
    const read = getDocument(db, "pricing/null-decay.md");
    expect(read?.ttlDays).toBeNull();
    expect(read?.created).toBe("2026-04-01");
    expect(read?.supersededBy).toBeNull();
  });

  it("schema versioning: drops and recreates tables on version mismatch", () => {
    // Stamp a stale schema version and insert a document.
    setMeta(db, "schema_version", "1");
    insertDocument(db, sampleDoc);
    expect(documentCount(db)).toBe(1);
    db.close();

    // Reopen the same DB — openIndexDb must detect the version mismatch,
    // drop documents/chunks/embeddings, recreate them, and write the current
    // schema version. The manifest meta entry is also cleared so the next
    // freshness check sees no stale snapshot.
    const reopened = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!reopened.ok) throw reopened.error;
    db = reopened.value;

    expect(documentCount(db)).toBe(0);
    expect(embeddingCount(db)).toBe(0);
    expect(getMeta(db, "schema_version")).toBe("7");
    expect(getMeta(db, "vault_manifest")).toBeNull();
  });

  it("schema 4 → 5 rebuild: a v4 index is dropped and recreated cleanly", () => {
    // Simulate a vault that was last indexed by a v1.8.x server (schema "4",
    // no FTS5 / sqlite-vec virtual tables). The 4 → 5 bump must drop every
    // derived table and let openIndexDb recreate the schema — no manual
    // migration needed because the cache is rebuildable from disk.
    setMeta(db, "schema_version", "4");
    // Insert a row resembling the legacy embeddings shape: no dim column.
    // The actual on-disk v3 table won't have the column at all, but the
    // important assertion is that openIndexDb DROPS and recreates, so any
    // pre-existing content is gone.
    insertDocument(db, sampleDoc);
    expect(documentCount(db)).toBe(1);
    db.close();

    const reopened = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!reopened.ok) throw reopened.error;
    db = reopened.value;

    expect(documentCount(db)).toBe(0);
    expect(getMeta(db, "schema_version")).toBe("7");
    // All five expected tables now exist on a fresh index: three
    // regular tables (documents, chunks, embeddings, meta) plus two
    // virtual tables (documents_fts, embeddings_vec).
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = new Set(tables.map((t) => t.name));
    expect(names.has("documents")).toBe(true);
    expect(names.has("chunks")).toBe(true);
    expect(names.has("embeddings")).toBe(true);
    expect(names.has("documents_fts")).toBe(true);
    expect(names.has("embeddings_vec")).toBe(true);
    // The new embeddings table now has a `dim` column — confirm via a write
    // that requires the dim parameter (the old API didn't take one).
    const text = "hello";
    const hash = sha256Hex(text);
    const vec = new Float32Array([0.5, 0.5]);
    insertEmbedding(db, hash, MODEL, vec, "2026-05-20T00:00:00Z", 2);
    const rows = db.prepare("SELECT dim FROM embeddings WHERE content_hash = ?").all(hash) as {
      dim: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dim).toBe(2);
  });

  it("rejects an insert whose vector length does not match the declared dim", () => {
    const hash = sha256Hex("bad");
    const vec = new Float32Array([1, 2, 3, 4]);
    expect(() =>
      // dim=384 but vector is length 4 — caller is lying about its provider.
      insertEmbedding(db, hash, MODEL, vec, "2026-05-20T00:00:00Z", 384),
    ).toThrow(/does not match declared dim/);
  });

  it("stores and reads the dim column for every embedding", () => {
    const h = sha256Hex("dim probe");
    insertEmbedding(db, h, MODEL, new Float32Array([1, 2, 3, 4, 5]), "2026-05-20T00:00:00Z", 5);
    const row = db
      .prepare("SELECT dim FROM embeddings WHERE content_hash = ? AND model = ?")
      .get(h, MODEL) as { dim: number } | undefined;
    expect(row?.dim).toBe(5);
  });

  describe("embeddings cache", () => {
    it("composite PK: the same content_hash coexists under two models", () => {
      const text = "shared chunk text";
      const hash = sha256Hex(text);
      const v1 = new Float32Array([1, 0, 0]);
      const v2 = new Float32Array([0, 1, 0]);
      insertEmbedding(db, hash, "model-a", v1, "2026-05-20T00:00:00Z", v1.length);
      insertEmbedding(db, hash, "model-b", v2, "2026-05-20T00:00:00Z", v2.length);
      expect(embeddingCount(db)).toBe(2);

      const aFound = existingEmbeddingHashes(db, "model-a", [hash]);
      const bFound = existingEmbeddingHashes(db, "model-b", [hash]);
      expect(aFound.has(hash)).toBe(true);
      expect(bFound.has(hash)).toBe(true);
    });

    it("existingEmbeddingHashes returns only hashes present for the given model", () => {
      const h1 = sha256Hex("one");
      const h2 = sha256Hex("two");
      const h3 = sha256Hex("three");
      const vec = new Float32Array([1, 2, 3]);
      insertEmbedding(db, h1, MODEL, vec, "2026-05-20T00:00:00Z", vec.length);
      insertEmbedding(db, h2, MODEL, vec, "2026-05-20T00:00:00Z", vec.length);
      // h3 has a row under a DIFFERENT model — must not count as a hit.
      insertEmbedding(db, h3, "other-model", vec, "2026-05-20T00:00:00Z", vec.length);

      const found = existingEmbeddingHashes(db, MODEL, [h1, h2, h3]);
      expect(found.size).toBe(2);
      expect(found.has(h1)).toBe(true);
      expect(found.has(h2)).toBe(true);
      expect(found.has(h3)).toBe(false);
    });

    it("gcOrphanedEmbeddings drops only embeddings with no referencing chunks", () => {
      const referencedHash = sha256Hex("referenced");
      const orphanHash = sha256Hex("orphan");
      const vec = new Float32Array([1, 2, 3]);
      insertEmbedding(db, referencedHash, MODEL, vec, "2026-05-20T00:00:00Z", vec.length);
      insertEmbedding(db, orphanHash, MODEL, vec, "2026-05-20T00:00:00Z", vec.length);
      insertChunkRow(db, {
        path: "pricing/foo.md",
        chunkIndex: 0,
        text: "referenced",
        contentHash: referencedHash,
      });

      const removed = gcOrphanedEmbeddings(db);
      expect(removed).toBe(1);
      // The referenced row survives; the orphan is gone.
      expect(embeddingCount(db)).toBe(1);
      expect(existingEmbeddingHashes(db, MODEL, [referencedHash, orphanHash])).toEqual(
        new Set([referencedHash]),
      );
    });

    it("batch-reaps many orphans and mirrors the deletes into embeddings_vec", () => {
      // Behavior-preservation guard for the batched NOT EXISTS / IN-list rewrite:
      // with a mix of referenced and orphaned hashes the gc must drop exactly
      // the orphans from BOTH `embeddings` and `embeddings_vec`, and leave the
      // referenced rows in both stores.
      const dim = LOCAL_MINILM_DIM;
      const vec = new Float32Array(dim).fill(0.1);
      const referenced: string[] = [];
      const orphans: string[] = [];
      for (let i = 0; i < 25; i++) {
        const h = sha256Hex(`ref-${i}`);
        referenced.push(h);
        insertEmbedding(db, h, MODEL, vec, "2026-05-20T00:00:00Z", dim);
        insertEmbeddingVec(db, h, MODEL, vec);
        insertChunkRow(db, {
          path: `pricing/ref-${i}.md`,
          chunkIndex: 0,
          text: `ref-${i}`,
          contentHash: h,
        });
      }
      for (let i = 0; i < 40; i++) {
        const h = sha256Hex(`orphan-${i}`);
        orphans.push(h);
        insertEmbedding(db, h, MODEL, vec, "2026-05-20T00:00:00Z", dim);
        insertEmbeddingVec(db, h, MODEL, vec);
      }

      const removed = gcOrphanedEmbeddings(db);
      expect(removed).toBe(40);
      expect(embeddingCount(db)).toBe(25);
      expect(existingEmbeddingHashes(db, MODEL, [...referenced, ...orphans])).toEqual(
        new Set(referenced),
      );
      // The vec mirror mirrors the deletes: only the 25 referenced rows remain.
      const vecCount = (
        db.prepare("SELECT COUNT(*) AS n FROM embeddings_vec").get() as { n: number }
      ).n;
      expect(vecCount).toBe(25);
    });

    it("is a no-op when every embedding is referenced", () => {
      const dim = LOCAL_MINILM_DIM;
      const vec = new Float32Array(dim).fill(0.2);
      const h = sha256Hex("kept");
      insertEmbedding(db, h, MODEL, vec, "2026-05-20T00:00:00Z", dim);
      insertEmbeddingVec(db, h, MODEL, vec);
      insertChunkRow(db, { path: "pricing/kept.md", chunkIndex: 0, text: "kept", contentHash: h });
      expect(gcOrphanedEmbeddings(db)).toBe(0);
      expect(embeddingCount(db)).toBe(1);
    });
  });

  describe("FTS5 sync", () => {
    it("creates the documents_fts virtual table and keeps it in sync via triggers", () => {
      // No direct write to documents_fts: the AFTER INSERT trigger on
      // `documents` populates the FTS index. Word stems from the body
      // ('pricing', 'consumption') must be matchable through MATCH.
      insertDocument(db, {
        ...sampleDoc,
        path: "pricing/cirrus-pricing.md",
        title: "Cirrus Pooled Capacity Pricing",
        content: "Pooled capacity tier pricing for Cirrus customers.",
      });
      insertDocument(db, {
        ...sampleDoc,
        path: "pricing/helios.md",
        title: "Helios Consumption",
        content: "Helios consumption credit model with per-second billing.",
      });

      const rows = db
        .prepare(
          "SELECT d.path AS path FROM documents_fts JOIN documents AS d ON d.rowid = documents_fts.rowid WHERE documents_fts MATCH ?",
        )
        .all("cirrus*") as { path: string }[];
      expect(rows.map((r) => r.path)).toEqual(["pricing/cirrus-pricing.md"]);
    });

    it("delete trigger removes the FTS5 row when a document is deleted", () => {
      insertDocument(db, {
        ...sampleDoc,
        path: "pricing/ephemeral.md",
        title: "Ephemeral",
        content: "Ephemeral content that will be removed.",
      });
      // Before: the document is matchable via FTS5.
      const beforeCount = (
        db
          .prepare("SELECT COUNT(*) AS n FROM documents_fts WHERE documents_fts MATCH ?")
          .get("ephemeral*") as { n: number }
      ).n;
      expect(beforeCount).toBe(1);

      // Delete the document — the AFTER DELETE trigger must cascade into
      // the contentless FTS5 mirror.
      db.prepare("DELETE FROM documents WHERE path = ?").run("pricing/ephemeral.md");

      const afterCount = (
        db
          .prepare("SELECT COUNT(*) AS n FROM documents_fts WHERE documents_fts MATCH ?")
          .get("ephemeral*") as { n: number }
      ).n;
      expect(afterCount).toBe(0);
    });

    it("update trigger refreshes the FTS5 row on document INSERT OR REPLACE", () => {
      insertDocument(db, {
        ...sampleDoc,
        path: "pricing/mutating.md",
        title: "Cirrus Pricing",
        content: "Initial body about cirrus pricing.",
      });
      // Replace with a body that has no overlap with the original.
      insertDocument(db, {
        ...sampleDoc,
        path: "pricing/mutating.md",
        title: "Helios Pricing",
        content: "Replacement body about helios consumption.",
      });

      const oldHits = db
        .prepare("SELECT COUNT(*) AS n FROM documents_fts WHERE documents_fts MATCH ?")
        .all("cirrus*") as { n: number }[];
      expect(oldHits[0]?.n).toBe(0);

      const newHits = db
        .prepare("SELECT COUNT(*) AS n FROM documents_fts WHERE documents_fts MATCH ?")
        .all("helios*") as { n: number }[];
      expect(newHits[0]?.n).toBe(1);
    });
  });

  describe("sqlite-vec mirror", () => {
    it("ranks indexed vectors by cosine distance for a KNN query", () => {
      // Three unit-ish vectors; the query is identical to v1, so we expect
      // v1 closest (distance 0), then v3 (near v1), then v2 (orthogonal).
      const v1 = new Float32Array([1, 0, 0, 0]);
      const v2 = new Float32Array([0, 1, 0, 0]);
      const v3 = new Float32Array([0.9, 0.1, 0, 0]);
      // The vec table dim is 384 by default; this test needs a 4-dim table
      // so it can verify the ranking math directly. Use a fresh vault that
      // opens at the right dim. We swap the outer `db` for the duration of
      // the assertions and restore it before returning so the suite's
      // afterEach has a live handle to close.
      db.close();
      const fresh = makeTempVault();
      const opened = openIndexDb(fresh, 4);
      if (!opened.ok) throw opened.error;
      db = opened.value;
      insertEmbeddingVec(db, "h1", MODEL, v1);
      insertEmbeddingVec(db, "h2", MODEL, v2);
      insertEmbeddingVec(db, "h3", MODEL, v3);

      const queryBlob = embeddingToBlob(v1);
      const rows = db
        .prepare(
          `SELECT content_hash, distance
             FROM embeddings_vec
            WHERE embedding MATCH ? AND model = ? AND k = ?
            ORDER BY distance`,
        )
        .all(queryBlob, MODEL, 3) as { content_hash: string; distance: number }[];
      expect(rows.map((r) => r.content_hash)).toEqual(["h1", "h3", "h2"]);
      expect(rows[0]?.distance).toBeCloseTo(0);

      // Restore: tear down the fresh vault, reopen the original so the
      // suite-level afterEach has a valid db handle.
      db.close();
      cleanupVault(fresh);
      const reopened = openIndexDb(vault, LOCAL_MINILM_DIM);
      if (!reopened.ok) throw reopened.error;
      db = reopened.value;
    });

    it("rebuilds embeddings_vec when the expected dim changes", () => {
      // First open creates the vec table at dim=4.
      db.close();
      const fresh = makeTempVault();
      let opened = openIndexDb(fresh, 4);
      if (!opened.ok) throw opened.error;
      db = opened.value;
      expect(getMeta(db, "embeddings_vec_dim")).toBe("4");
      // Insert a 4-dim vector; it must survive the first round-trip.
      insertEmbeddingVec(db, "h1", MODEL, new Float32Array([1, 0, 0, 0]));
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM embeddings_vec").get() as {
            n: number;
          }
        ).n,
      ).toBe(1);

      db.close();
      // Reopen at a different dim — the vec table is dropped and recreated;
      // any rows in it are gone (the durable cache survives — `embeddings`
      // and `chunks` tables are not touched).
      opened = openIndexDb(fresh, 8);
      if (!opened.ok) throw opened.error;
      db = opened.value;
      expect(getMeta(db, "embeddings_vec_dim")).toBe("8");
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM embeddings_vec").get() as {
            n: number;
          }
        ).n,
      ).toBe(0);

      // The new dim must actually be the column type — a wrong-length insert
      // is rejected by sqlite-vec.
      expect(() => insertEmbeddingVec(db, "h1", MODEL, new Float32Array([1, 0, 0, 0]))).toThrow();
      // A correctly-sized vector goes through.
      insertEmbeddingVec(db, "h2", MODEL, new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));

      db.close();
      cleanupVault(fresh);
      const reopened = openIndexDb(vault, LOCAL_MINILM_DIM);
      if (!reopened.ok) throw reopened.error;
      db = reopened.value;
    });
  });

  describe("collectionForPath", () => {
    it("returns the indexed row's collection when present", () => {
      insertDocument(db, {
        ...sampleDoc,
        path: "pricing/indexed.md",
        collection: "declared-elsewhere",
      });
      expect(collectionForPath(db, "pricing/indexed.md")).toBe("declared-elsewhere");
    });

    it("falls back to the first path segment for unindexed paths", () => {
      expect(collectionForPath(db, "pricing/never-indexed.md")).toBe("pricing");
    });

    it("errs closed on escaping or empty paths", () => {
      expect(collectionForPath(db, "../escape.md")).toBe("..");
      expect(collectionForPath(db, "")).toBe("");
    });

    it("uses the pure segment rule when db is null", () => {
      expect(collectionForPath(null, "pricing/whatever.md")).toBe("pricing");
    });
  });
});

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

describe("getDocumentsInDateRange", () => {
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

  it("returns docs whose created date is within [start,end] inclusive", () => {
    insertDocument(db, doc({ path: "a.md", created: "2026-03-01" }));
    insertDocument(db, doc({ path: "b.md", created: "2026-03-15" }));
    insertDocument(db, doc({ path: "c.md", created: "2026-04-10" }));
    const got = getDocumentsInDateRange(db, "2026-03-01", "2026-03-31")
      .map((d) => d.path)
      .sort();
    expect(got).toEqual(["a.md", "b.md"]);
  });

  it("excludes docs with an empty created date", () => {
    insertDocument(db, doc({ path: "a.md", created: "" }));
    expect(getDocumentsInDateRange(db, "2025-01-01", "2027-01-01")).toEqual([]);
  });

  it("orders by created DESC then path ASC", () => {
    insertDocument(db, doc({ path: "older.md", created: "2026-03-01" }));
    insertDocument(db, doc({ path: "b-same.md", created: "2026-03-20" }));
    insertDocument(db, doc({ path: "a-same.md", created: "2026-03-20" }));
    const got = getDocumentsInDateRange(db, "2026-03-01", "2026-03-31").map((d) => d.path);
    expect(got).toEqual(["a-same.md", "b-same.md", "older.md"]);
  });
});

describe("insertDocument date normalization (index is cleaned; source is not)", () => {
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

  it("normalizes a recoverable created/updated date in the index", () => {
    insertDocument(db, { ...sampleDoc, path: "a.md", created: "2026-3-1", updated: "2026-7-9" });
    const d = getDocument(db, "a.md");
    expect(d?.created).toBe("2026-03-01");
    expect(d?.updated).toBe("2026-07-09");
  });

  it("stores empty string for an unrecoverable (slash) created date", () => {
    insertDocument(db, { ...sampleDoc, path: "b.md", created: "2026/03/01" });
    expect(getDocument(db, "b.md")?.created).toBe("");
  });

  it("stores empty string for an out-of-range created date", () => {
    insertDocument(db, { ...sampleDoc, path: "c.md", created: "2026-13-45" });
    expect(getDocument(db, "c.md")?.created).toBe("");
  });

  it("leaves a canonical date untouched", () => {
    insertDocument(db, {
      ...sampleDoc,
      path: "d.md",
      created: "2026-05-01",
      updated: "2026-05-02",
    });
    const d = getDocument(db, "d.md");
    expect(d?.created).toBe("2026-05-01");
    expect(d?.updated).toBe("2026-05-02");
  });

  it("excludes an index-normalized-to-empty date from getDocumentsInDateRange", () => {
    insertDocument(db, { ...sampleDoc, path: "e.md", created: "March 2026" });
    const inRange = getDocumentsInDateRange(db, "2026-01-01", "2026-12-31").map((x) => x.path);
    expect(inRange).not.toContain("e.md");
  });
});

describe("chunks_fts", () => {
  it("maintains chunks_fts in lockstep with chunks across a multi->single shrink", async () => {
    const vault = makeTempVault();
    try {
      // Author a genuinely multi-chunk doc: two paragraphs each > 800 chars so
      // chunkText() yields >= 2 chunks. "zephyrine" lives ONLY in the 2nd para.
      const para1 = `alpha ${"filler ".repeat(160)}`; // > 800 chars
      const para2 = `zephyrine ${"context ".repeat(160)}`; // > 800 chars, holds the unique term
      writeFileSync(join(vault, "big.md"), `---\ntitle: Big\n---\n\n${para1}\n\n${para2}\n`);
      let r = await reindexVault(vault);
      if (!r.ok) throw r.error;
      const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
      if (!opened.ok) throw opened.error;
      const db = opened.value;

      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='chunks_fts'",
            )
            .get() as { n: number }
        ).n,
      ).toBe(1);
      // big.md must have produced >= 2 chunks, else the shrink proves nothing.
      const bigChunks = (
        db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE path='big.md'").get() as { n: number }
      ).n;
      expect(bigChunks).toBeGreaterThanOrEqual(2);
      const parity = () => {
        const c = (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
        const f = (db.prepare("SELECT COUNT(*) AS n FROM chunks_fts").get() as { n: number }).n;
        return [c, f];
      };
      const [c1, f1] = parity();
      expect(f1).toBe(c1);
      // the unique term matches before the shrink
      const matches = (term: string) =>
        (
          db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?").get(term) as {
            n: number;
          }
        ).n;
      expect(matches("zephyrine")).toBeGreaterThan(0);

      // SHRINK: rewrite big.md to a single short line (one chunk), reindex.
      writeFileSync(join(vault, "big.md"), `---\ntitle: Big\n---\n\nalpha only.\n`);
      r = await reindexVault(vault);
      if (!r.ok) throw r.error;
      const [c2, f2] = parity();
      expect(f2).toBe(c2); // no orphan FTS rows after shrink
      expect(matches("zephyrine")).toBe(0); // removed-text term no longer matches
      db.close();
    } finally {
      cleanupVault(vault);
    }
  }, 60_000);

  it("incremental path: chunks_fts stays in sync after deleteDocument + insertChunkRow (partial delete)", () => {
    // This test exercises the INCREMENTAL single-document update path that the
    // file watcher triggers via indexDocument() in src/search/reindex.ts
    // (lines 559-568: deleteDocument(db, doc.path) then insertChunkRow per chunk).
    // Unlike the test above which uses reindexVault / clearIndex (a full wipe),
    // this path deletes only ONE document's chunk rows while leaving other
    // documents' rows intact — the partial-delete path where the historical
    // documents FTS-drift bug surfaced.
    //
    // We call deleteDocument + insertChunkRow directly to mirror that code path
    // without spinning up the embedding model or file system watcher.
    const vault = makeTempVault();
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!opened.ok) throw opened.error;
    const testDb = opened.value;

    try {
      // Build a multi-chunk big.md: two distinct chunks, "zephyrine" only in chunk 1.
      const bigPath = "big.md";
      const chunk0Text = `alpha ${"filler ".repeat(160)}`; // chunk 0: no zephyrine
      const chunk1Text = `zephyrine ${"context ".repeat(160)}`; // chunk 1: unique term
      const hash0 = sha256Hex(chunk0Text);
      const hash1 = sha256Hex(chunk1Text);

      // Insert an unrelated document so we can verify partial-delete doesn't
      // wipe rows for OTHER documents — the core partial-delete invariant.
      const otherPath = "other.md";
      const otherChunkText = "unrelated content stays intact";
      const otherHash = sha256Hex(otherChunkText);
      insertDocument(testDb, { ...sampleDoc, path: otherPath, content: otherChunkText });
      insertChunkRow(testDb, {
        path: otherPath,
        chunkIndex: 0,
        text: otherChunkText,
        contentHash: otherHash,
      });

      // Insert the big multi-chunk document.
      insertDocument(testDb, {
        ...sampleDoc,
        path: bigPath,
        content: chunk0Text + "\n" + chunk1Text,
      });
      insertChunkRow(testDb, {
        path: bigPath,
        chunkIndex: 0,
        text: chunk0Text,
        contentHash: hash0,
      });
      insertChunkRow(testDb, {
        path: bigPath,
        chunkIndex: 1,
        text: chunk1Text,
        contentHash: hash1,
      });

      const parity = () => {
        const c = (testDb.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
        const f = (testDb.prepare("SELECT COUNT(*) AS n FROM chunks_fts").get() as { n: number }).n;
        return [c, f];
      };
      const matches = (term: string) =>
        (
          testDb
            .prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?")
            .get(term) as { n: number }
        ).n;

      const [c1, f1] = parity();
      expect(f1).toBe(c1); // 3 chunks (2 big + 1 other), all in FTS
      expect(matches("zephyrine")).toBeGreaterThan(0); // unique term visible

      // INCREMENTAL SHRINK: simulate indexDocument() replacing big.md with a
      // single-chunk version — deleteDocument then insertChunkRow for new chunk.
      // This is the PARTIAL-delete path: only big.md's rows are removed, not
      // other.md's row. The chunks_ad trigger must fire for each deleted chunk row.
      const newChunkText = "alpha only.";
      const newHash = sha256Hex(newChunkText);
      deleteDocument(testDb, bigPath); // fires chunks_ad for chunk0 and chunk1
      insertDocument(testDb, { ...sampleDoc, path: bigPath, content: newChunkText });
      insertChunkRow(testDb, {
        path: bigPath,
        chunkIndex: 0,
        text: newChunkText,
        contentHash: newHash,
      });

      const [c2, f2] = parity();
      expect(f2).toBe(c2); // no orphan FTS rows: 2 total (1 big new + 1 other)
      expect(matches("zephyrine")).toBe(0); // removed-text term is gone from FTS
      // Verify the unrelated doc's chunk is still present (partial-delete, not full wipe).
      const otherChunks = (
        testDb.prepare("SELECT COUNT(*) AS n FROM chunks WHERE path = ?").get(otherPath) as {
          n: number;
        }
      ).n;
      expect(otherChunks).toBe(1);
    } finally {
      testDb.close();
      cleanupVault(vault);
    }
  });
});
