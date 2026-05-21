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
    insertEmbedding(db, hash, MODEL, embedding, "2026-05-20T00:00:00Z");
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
    insertEmbedding(db, hash, MODEL, new Float32Array([1, 2, 3]), "2026-05-20T00:00:00Z");
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
    expect(getMeta(db, "schema_version")).toBe("3");
    expect(getMeta(db, "vault_manifest")).toBeNull();
  });

  describe("embeddings cache", () => {
    it("composite PK: the same content_hash coexists under two models", () => {
      const text = "shared chunk text";
      const hash = sha256Hex(text);
      const v1 = new Float32Array([1, 0, 0]);
      const v2 = new Float32Array([0, 1, 0]);
      insertEmbedding(db, hash, "model-a", v1, "2026-05-20T00:00:00Z");
      insertEmbedding(db, hash, "model-b", v2, "2026-05-20T00:00:00Z");
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
      insertEmbedding(db, h1, MODEL, vec, "2026-05-20T00:00:00Z");
      insertEmbedding(db, h2, MODEL, vec, "2026-05-20T00:00:00Z");
      // h3 has a row under a DIFFERENT model — must not count as a hit.
      insertEmbedding(db, h3, "other-model", vec, "2026-05-20T00:00:00Z");

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
      insertEmbedding(db, referencedHash, MODEL, vec, "2026-05-20T00:00:00Z");
      insertEmbedding(db, orphanHash, MODEL, vec, "2026-05-20T00:00:00Z");
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
