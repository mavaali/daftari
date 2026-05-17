import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  blobToEmbedding,
  clearIndex,
  documentCount,
  embeddingToBlob,
  getAllChunks,
  getAllDocuments,
  getChunksForPath,
  getDocument,
  getMeta,
  insertChunk,
  insertDocument,
  openIndexDb,
  setMeta,
  type IndexDb,
  type IndexedDocument,
} from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

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

  it("round-trips a chunk embedding through the BLOB column", () => {
    const embedding = new Float32Array([0.1, -0.2, 0.33, 1.5]);
    insertChunk(db, {
      path: "pricing/foo.md",
      chunkIndex: 0,
      text: "chunk text",
      embedding,
    });
    const chunks = getChunksForPath(db, "pricing/foo.md");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.embedding && [...chunks[0].embedding]).toEqual([
      ...embedding,
    ]);
  });

  it("stores a null embedding when none is provided", () => {
    insertChunk(db, {
      path: "pricing/foo.md",
      chunkIndex: 0,
      text: "chunk text",
      embedding: null,
    });
    expect(getAllChunks(db)[0]?.embedding).toBeNull();
  });

  it("preserves Float32 values exactly through blob conversion", () => {
    const vec = new Float32Array([1, 2.5, -3.75]);
    const restored = blobToEmbedding(embeddingToBlob(vec));
    expect([...restored]).toEqual([...vec]);
  });

  it("clearIndex empties documents and chunks", () => {
    insertDocument(db, sampleDoc);
    insertChunk(db, {
      path: "pricing/foo.md",
      chunkIndex: 0,
      text: "x",
      embedding: null,
    });
    clearIndex(db);
    expect(documentCount(db)).toBe(0);
    expect(getAllChunks(db)).toEqual([]);
  });

  it("stores and reads meta values", () => {
    expect(getMeta(db, "missing")).toBeNull();
    setMeta(db, "vector_enabled", "true");
    expect(getMeta(db, "vector_enabled")).toBe("true");
  });
});
