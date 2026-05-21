import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  blobToEmbedding,
  clearIndex,
  documentCount,
  embeddingCount,
  embeddingToBlob,
  existingEmbeddingHashes,
  gcOrphanedEmbeddings,
  getAllChunks,
  getAllDocuments,
  getChunksForPath,
  getDocument,
  getMeta,
  type IndexDb,
  type IndexedDocument,
  insertChunkRow,
  insertDocument,
  insertEmbedding,
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
    const opened = openIndexDb(vault);
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
    const reopened = openIndexDb(vault);
    if (!reopened.ok) throw reopened.error;
    db = reopened.value;

    expect(documentCount(db)).toBe(0);
    expect(embeddingCount(db)).toBe(0);
    expect(getMeta(db, "schema_version")).toBe("4");
    expect(getMeta(db, "vault_manifest")).toBeNull();
  });

  it("schema 3 → 4 rebuild: a v3 index is dropped and recreated cleanly", () => {
    // Simulate a vault that was last indexed by a v1.8.0 server (schema "3",
    // no `dim` column on embeddings). The 3 → 4 bump must drop the legacy
    // table and let openIndexDb recreate it with the new column — no manual
    // migration needed because the cache is rebuildable from disk.
    setMeta(db, "schema_version", "3");
    // Insert a row resembling the legacy embeddings shape: no dim column.
    // The actual on-disk v3 table won't have the column at all, but the
    // important assertion is that openIndexDb DROPS and recreates, so any
    // pre-existing content is gone.
    insertDocument(db, sampleDoc);
    expect(documentCount(db)).toBe(1);
    db.close();

    const reopened = openIndexDb(vault);
    if (!reopened.ok) throw reopened.error;
    db = reopened.value;

    expect(documentCount(db)).toBe(0);
    expect(getMeta(db, "schema_version")).toBe("4");
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
  });
});
