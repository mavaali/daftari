// SQLite index store for search.
//
// The index is a derived cache: it holds nothing the markdown files don't
// already hold, so .daftari/index.db can be deleted and rebuilt at any time
// (see search/reindex.ts). Two tables carry the search payload:
//
//   documents — one row per markdown file: frontmatter fields, the full body,
//               and the BM25 token list (JSON).
//   chunks    — one row per embedded text chunk: the chunk text and its vector
//               embedding (Float32 BLOB, or NULL when embedding was skipped).
//
// A small meta table records index-wide facts (embedding dimension, whether
// vectors were built, when the index was last rebuilt).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { err, ok, type Result } from "../frontmatter/types.js";

export type IndexDb = Database.Database;

export interface IndexedDocument {
  path: string;
  title: string;
  collection: string;
  domain: string;
  status: string;
  confidence: string;
  updated: string;
  tags: string[];
  content: string;
  tokens: string[];
}

export interface IndexedChunk {
  path: string;
  chunkIndex: number;
  text: string;
  embedding: Float32Array | null;
}

// The .daftari control directory is excluded from vault listings, so the index
// file lives there without ever being mistaken for vault content.
export function indexDbPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "index.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  path        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  collection  TEXT NOT NULL,
  domain      TEXT NOT NULL,
  status      TEXT NOT NULL,
  confidence  TEXT NOT NULL,
  updated     TEXT NOT NULL,
  tags        TEXT NOT NULL,
  content     TEXT NOT NULL,
  tokens      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  path         TEXT NOT NULL,
  chunk_index  INTEGER NOT NULL,
  text         TEXT NOT NULL,
  embedding    BLOB,
  PRIMARY KEY (path, chunk_index)
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openIndexDb(vaultRoot: string): Result<IndexDb, Error> {
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    const db = new Database(indexDbPath(vaultRoot));
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    return ok(db);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot open index db: ${reason}`));
  }
}

// Drops every indexed row. Called at the start of a rebuild so a reindex never
// leaves rows for files that have since been deleted.
export function clearIndex(db: IndexDb): void {
  db.exec("DELETE FROM documents; DELETE FROM chunks;");
}

// Drops one document and all its chunks. Used by the write path to evict a
// document's stale rows before re-inserting it: a plain INSERT OR REPLACE on
// chunks would leave orphaned high-index rows behind if the document shrank.
export function deleteDocument(db: IndexDb, path: string): void {
  db.prepare("DELETE FROM documents WHERE path = ?").run(path);
  db.prepare("DELETE FROM chunks WHERE path = ?").run(path);
}

// --- Float32 <-> BLOB ------------------------------------------------------

export function embeddingToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToEmbedding(blob: Buffer): Float32Array {
  // Copy into a fresh, 4-byte-aligned buffer: a Buffer from SQLite may share a
  // pool with an arbitrary byteOffset, which Float32Array cannot view directly.
  const copy = new Uint8Array(blob.length);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

// --- writes ----------------------------------------------------------------

export function insertDocument(db: IndexDb, doc: IndexedDocument): void {
  db.prepare(
    `INSERT OR REPLACE INTO documents
       (path, title, collection, domain, status, confidence, updated, tags, content, tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    doc.path,
    doc.title,
    doc.collection,
    doc.domain,
    doc.status,
    doc.confidence,
    doc.updated,
    JSON.stringify(doc.tags),
    doc.content,
    JSON.stringify(doc.tokens),
  );
}

export function insertChunk(db: IndexDb, chunk: IndexedChunk): void {
  db.prepare(
    `INSERT OR REPLACE INTO chunks (path, chunk_index, text, embedding)
     VALUES (?, ?, ?, ?)`,
  ).run(
    chunk.path,
    chunk.chunkIndex,
    chunk.text,
    chunk.embedding ? embeddingToBlob(chunk.embedding) : null,
  );
}

export function setMeta(db: IndexDb, key: string, value: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
  ).run(key, value);
}

// --- reads -----------------------------------------------------------------

interface DocumentRow {
  path: string;
  title: string;
  collection: string;
  domain: string;
  status: string;
  confidence: string;
  updated: string;
  tags: string;
  content: string;
  tokens: string;
}

function rowToDocument(row: DocumentRow): IndexedDocument {
  return {
    path: row.path,
    title: row.title,
    collection: row.collection,
    domain: row.domain,
    status: row.status,
    confidence: row.confidence,
    updated: row.updated,
    tags: JSON.parse(row.tags) as string[],
    content: row.content,
    tokens: JSON.parse(row.tokens) as string[],
  };
}

export function getAllDocuments(db: IndexDb): IndexedDocument[] {
  const rows = db
    .prepare("SELECT * FROM documents ORDER BY path")
    .all() as DocumentRow[];
  return rows.map(rowToDocument);
}

export function getDocument(
  db: IndexDb,
  path: string,
): IndexedDocument | null {
  const row = db
    .prepare("SELECT * FROM documents WHERE path = ?")
    .get(path) as DocumentRow | undefined;
  return row ? rowToDocument(row) : null;
}

interface ChunkRow {
  path: string;
  chunk_index: number;
  text: string;
  embedding: Buffer | null;
}

function rowToChunk(row: ChunkRow): IndexedChunk {
  return {
    path: row.path,
    chunkIndex: row.chunk_index,
    text: row.text,
    embedding: row.embedding ? blobToEmbedding(row.embedding) : null,
  };
}

export function getAllChunks(db: IndexDb): IndexedChunk[] {
  const rows = db
    .prepare("SELECT * FROM chunks ORDER BY path, chunk_index")
    .all() as ChunkRow[];
  return rows.map(rowToChunk);
}

export function getChunksForPath(db: IndexDb, path: string): IndexedChunk[] {
  const rows = db
    .prepare("SELECT * FROM chunks WHERE path = ? ORDER BY chunk_index")
    .all(path) as ChunkRow[];
  return rows.map(rowToChunk);
}

export function getMeta(db: IndexDb, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function documentCount(db: IndexDb): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM documents")
    .get() as { n: number };
  return row.n;
}
