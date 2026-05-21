// SQLite index store for search.
//
// The index is a derived cache: it holds nothing the markdown files don't
// already hold, so .daftari/index.db can be deleted and rebuilt at any time
// (see search/reindex.ts). Three tables carry the search payload:
//
//   documents  — one row per markdown file: frontmatter fields, the full body,
//                and the BM25 token list (JSON).
//   chunks     — one row per embedded text chunk: the chunk text and a
//                content_hash (sha256 of the chunk text) that joins to the
//                embeddings table for the current model.
//   embeddings — one row per (content_hash, model) pair. Content-addressed,
//                so identical chunk text shares one row across files and
//                across reindexes. A model migration can keep the same
//                content_hash present under two model values at once, which
//                is why the primary key is composite.
//
// A small meta table records index-wide facts (embedding dimension, whether
// vectors were built, when the index was last rebuilt).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { err, ok, type Result } from "../frontmatter/types.js";

export type IndexDb = Database.Database;

const SCHEMA_VERSION = "3";

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
  ttlDays: number | null;
  created: string;
  supersededBy: string | null;
}

export interface IndexedChunk {
  path: string;
  chunkIndex: number;
  text: string;
  contentHash: string;
  embedding: Float32Array | null;
}

// The .daftari control directory is excluded from vault listings, so the index
// file lives there without ever being mistaken for vault content.
export function indexDbPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "index.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  path          TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  collection    TEXT NOT NULL,
  domain        TEXT NOT NULL,
  status        TEXT NOT NULL,
  confidence    TEXT NOT NULL,
  updated       TEXT NOT NULL,
  tags          TEXT NOT NULL,
  content       TEXT NOT NULL,
  tokens        TEXT NOT NULL,
  ttl_days      INTEGER,
  created       TEXT NOT NULL DEFAULT '',
  superseded_by TEXT
);
CREATE TABLE IF NOT EXISTS chunks (
  path          TEXT NOT NULL,
  chunk_index   INTEGER NOT NULL,
  text          TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  PRIMARY KEY (path, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);
CREATE TABLE IF NOT EXISTS embeddings (
  content_hash TEXT NOT NULL,
  model        TEXT NOT NULL,
  embedding    BLOB NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (content_hash, model)
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
    // Ensure the meta table exists before reading schema_version from it.
    db.exec(`CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );`);
    const stored = getMeta(db, "schema_version");
    if (stored !== SCHEMA_VERSION) {
      // Schema bump means a clean rebuild: every derived table is dropped and
      // the freshness manifest is cleared so the next reindex repopulates
      // everything. Trying to ALTER across this change would race the new
      // composite-PK embeddings table; the markdown files are the source of
      // truth and the index is cheap to regenerate.
      db.exec(
        "DROP TABLE IF EXISTS documents; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS embeddings;",
      );
      db.prepare("DELETE FROM meta WHERE key = ?").run("vault_manifest");
    }
    db.exec(SCHEMA);
    setMeta(db, "schema_version", SCHEMA_VERSION);
    return ok(db);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot open index db: ${reason}`));
  }
}

// Drops every indexed row. Called at the start of a rebuild so a reindex never
// leaves rows for files that have since been deleted. Embeddings are NOT
// cleared here — they are content-addressed and a subsequent gc pass deletes
// only the orphaned ones, preserving the cache across reindexes.
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
       (path, title, collection, domain, status, confidence, updated, tags, content, tokens,
        ttl_days, created, superseded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    doc.ttlDays,
    doc.created,
    doc.supersededBy,
  );
}

export interface ChunkRowInput {
  path: string;
  chunkIndex: number;
  text: string;
  contentHash: string;
}

export function insertChunkRow(db: IndexDb, chunk: ChunkRowInput): void {
  db.prepare(
    `INSERT OR REPLACE INTO chunks (path, chunk_index, text, content_hash)
     VALUES (?, ?, ?, ?)`,
  ).run(chunk.path, chunk.chunkIndex, chunk.text, chunk.contentHash);
}

// Returns the set of content_hash values that already have a row for `model`
// in the embeddings cache. Used by the reindex pass to skip re-embedding any
// chunk whose text hash is already known.
export function existingEmbeddingHashes(db: IndexDb, model: string, hashes: string[]): Set<string> {
  if (hashes.length === 0) return new Set();
  // SQLite has a finite SQL variable limit (default 999), so chunk the IN()
  // list to stay well under it.
  const found = new Set<string>();
  const BATCH = 500;
  for (let start = 0; start < hashes.length; start += BATCH) {
    const slice = hashes.slice(start, start + BATCH);
    const placeholders = slice.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT content_hash FROM embeddings WHERE model = ? AND content_hash IN (${placeholders})`,
      )
      .all(model, ...slice) as { content_hash: string }[];
    for (const r of rows) found.add(r.content_hash);
  }
  return found;
}

export function insertEmbedding(
  db: IndexDb,
  contentHash: string,
  model: string,
  embedding: Float32Array,
  createdAt: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO embeddings (content_hash, model, embedding, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(contentHash, model, embeddingToBlob(embedding), createdAt);
}

// Deletes every embeddings row whose content_hash is referenced by no chunks
// row. Called at the end of a reindex to reap entries for chunks that no
// longer exist anywhere in the vault. Returns the number of rows deleted.
export function gcOrphanedEmbeddings(db: IndexDb): number {
  const info = db
    .prepare(
      `DELETE FROM embeddings
       WHERE content_hash NOT IN (SELECT content_hash FROM chunks)`,
    )
    .run();
  return info.changes;
}

export function setMeta(db: IndexDb, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
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
  ttl_days: number | null;
  created: string;
  superseded_by: string | null;
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
    ttlDays: row.ttl_days,
    created: row.created,
    supersededBy: row.superseded_by,
  };
}

export function getAllDocuments(db: IndexDb): IndexedDocument[] {
  const rows = db.prepare("SELECT * FROM documents ORDER BY path").all() as DocumentRow[];
  return rows.map(rowToDocument);
}

export function getDocument(db: IndexDb, path: string): IndexedDocument | null {
  const row = db.prepare("SELECT * FROM documents WHERE path = ?").get(path) as
    | DocumentRow
    | undefined;
  return row ? rowToDocument(row) : null;
}

interface ChunkJoinRow {
  path: string;
  chunk_index: number;
  text: string;
  content_hash: string;
  embedding: Buffer | null;
}

function rowToChunk(row: ChunkJoinRow): IndexedChunk {
  return {
    path: row.path,
    chunkIndex: row.chunk_index,
    text: row.text,
    contentHash: row.content_hash,
    embedding: row.embedding ? blobToEmbedding(row.embedding) : null,
  };
}

// Reads every chunk LEFT JOINed against the embeddings cache, filtered to
// `model`. A chunk whose content_hash has no embeddings row for this model
// (e.g. the model was unavailable during reindex) comes back with embedding =
// null and the vector ranker simply skips it, matching the old NULL-blob
// behaviour.
export function getAllChunks(db: IndexDb, model: string): IndexedChunk[] {
  const rows = db
    .prepare(
      `SELECT c.path, c.chunk_index, c.text, c.content_hash, e.embedding
         FROM chunks c
         LEFT JOIN embeddings e
           ON e.content_hash = c.content_hash AND e.model = ?
        ORDER BY c.path, c.chunk_index`,
    )
    .all(model) as ChunkJoinRow[];
  return rows.map(rowToChunk);
}

export function getChunksForPath(db: IndexDb, path: string, model: string): IndexedChunk[] {
  const rows = db
    .prepare(
      `SELECT c.path, c.chunk_index, c.text, c.content_hash, e.embedding
         FROM chunks c
         LEFT JOIN embeddings e
           ON e.content_hash = c.content_hash AND e.model = ?
        WHERE c.path = ?
        ORDER BY c.chunk_index`,
    )
    .all(model, path) as ChunkJoinRow[];
  return rows.map(rowToChunk);
}

export function getMeta(db: IndexDb, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function documentCount(db: IndexDb): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number };
  return row.n;
}

export function embeddingCount(db: IndexDb): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number };
  return row.n;
}
