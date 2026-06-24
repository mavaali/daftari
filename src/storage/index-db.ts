// SQLite index store for search.
//
// The index is a derived cache: it holds nothing the markdown files don't
// already hold, so .daftari/index.db can be deleted and rebuilt at any time
// (see search/reindex.ts). Five tables carry the search payload:
//
//   documents      — one row per markdown file: frontmatter fields, the full
//                    body, and the (legacy) BM25 token list (JSON).
//   chunks         — one row per embedded text chunk: the chunk text and a
//                    content_hash (sha256 of the chunk text) that joins to the
//                    embeddings table for the current model.
//   embeddings     — one row per (content_hash, model) pair, with a `dim`
//                    column recording the vector dimension. Content-addressed,
//                    so identical chunk text shares one row across files and
//                    across reindexes. The composite (content_hash, model)
//                    primary key lets two providers' vectors (e.g. local-
//                    minilm 384 + openai-3-small 1536) coexist for the same
//                    chunk text — handy when switching providers without
//                    losing the old cache. `dim` is defense-in-depth: callers
//                    can detect a corrupt or cross-provider mix at read time,
//                    even though the model id already scopes the join.
//   documents_fts  — FTS5 virtual table (contentless link to `documents`).
//                    Title, tags, and body tokens, ranked with BM25. Kept in
//                    sync by AFTER INSERT / UPDATE / DELETE triggers on
//                    `documents`, so writes never touch the virtual table
//                    directly. Replaces the hand-rolled BM25 over the legacy
//                    `documents.tokens` column.
//   embeddings_vec — sqlite-vec `vec0` virtual table, an indexed mirror of
//                    `embeddings` for vector queries. Rebuilt at the active
//                    provider's dim — switching providers between server runs
//                    triggers a drop-and-recreate (the durable `embeddings`
//                    table is untouched). Population is the reindex path's
//                    job; this file just exposes the schema.
//
// A small meta table records index-wide facts (embedding dimension, whether
// vectors were built, when the index was last rebuilt, the dim that
// `embeddings_vec` was created at).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { err, ok, type Result } from "../frontmatter/types.js";
import { normalizeIsoDate } from "../utils/dates.js";

export type IndexDb = Database.Database;

// Bumped 4 → 5 to add FTS5 (`documents_fts`) and sqlite-vec (`embeddings_vec`)
// virtual tables for SQL-native search. The index is a derived cache so the
// bump triggers a clean rebuild (see openIndexDb); no in-place migration.
const SCHEMA_VERSION = "7";

// Meta key that records the dim at which `embeddings_vec` was created. Used
// on every open to decide whether to rebuild the virtual table (provider
// switch). The durable `embeddings` cache is per-(model, dim) so it survives
// the vec-table rebuild and a switch-back to the previous provider is all
// cache hits.
const VEC_DIM_META_KEY = "embeddings_vec_dim";

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

// Non-virtual schema. Virtual tables (`documents_fts`, `embeddings_vec`) are
// created separately because their CREATE statements depend on runtime values
// (the active provider's dim) and need the sqlite-vec extension loaded first.
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
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created);
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
  dim          INTEGER NOT NULL,
  embedding    BLOB NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (content_hash, model)
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS staged_actions (
  id                  TEXT PRIMARY KEY,
  action_type         TEXT NOT NULL,
  target_path         TEXT NOT NULL,
  proposed_by         TEXT NOT NULL,
  proposed_at         TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  status              TEXT NOT NULL,
  rationale           TEXT NOT NULL,
  proposed_diff       TEXT NOT NULL,
  ratified_at         TEXT,
  ratified_by         TEXT,
  ratification_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_staged_status ON staged_actions(status);
CREATE INDEX IF NOT EXISTS idx_staged_target ON staged_actions(target_path);
CREATE INDEX IF NOT EXISTS idx_staged_expires ON staged_actions(expires_at);
CREATE TABLE IF NOT EXISTS derives_from_edges (
  from_path      TEXT NOT NULL,
  to_path        TEXT NOT NULL,
  strength       REAL NOT NULL,
  k_survived     INTEGER NOT NULL,
  first_observed TEXT NOT NULL,
  last_rederived TEXT NOT NULL,
  last_age_decay TEXT NOT NULL,
  status         TEXT NOT NULL,
  direction_verdict TEXT NOT NULL DEFAULT 'directed',
  PRIMARY KEY (from_path, to_path)
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON derives_from_edges(from_path);
CREATE INDEX IF NOT EXISTS idx_edges_to ON derives_from_edges(to_path);
CREATE INDEX IF NOT EXISTS idx_edges_status ON derives_from_edges(status);
`;

// FTS5 virtual table over the `documents` body + title + tags. The
// `content='documents'` link is a "contentless" external-content FTS5
// index — the virtual table stores tokens, not its own copy of the text,
// so writes pay one storage cost, not two. AFTER INSERT/UPDATE/DELETE
// triggers on `documents` keep the FTS index in sync so the write path
// never touches the virtual table directly. Porter + unicode61 is the
// stock English stemming pipeline; it lowercases, strips diacritics, and
// folds plurals / -ing forms.
//
// Also contains chunks_fts: an FTS5 external-content table over `chunks`
// using the same pattern. FTS sync relies on delete-before-insert: every
// write path deletes a path's chunk rows before inserting new ones, so
// the triggers fire in the right order. chunks_au is defensive — no current
// write path UPDATEs a chunk row in place — but is included for correctness.
// Note: recursive_triggers is OFF in this project, so INSERT OR REPLACE
// conflict triggers do NOT fire both DELETE+INSERT; that is why the
// documents write path was migrated off INSERT OR REPLACE. chunks follows
// the same pattern.
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, tags, content_body,
  content='documents',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, tags, content_body)
  VALUES (new.rowid, new.title, new.tags, new.content);
END;
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, tags, content_body)
  VALUES('delete', old.rowid, old.title, old.tags, old.content);
END;
CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, tags, content_body)
  VALUES('delete', old.rowid, old.title, old.tags, old.content);
  INSERT INTO documents_fts(rowid, title, tags, content_body)
  VALUES (new.rowid, new.title, new.tags, new.content);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`;

// Loads the sqlite-vec loadable extension and runs a 1-vector roundtrip to
// confirm ABI compatibility. Returns Result so the caller (openIndexDb) can
// surface an actionable message to the operator.
// Three realistic failure modes, each with a different fix:
//   1. Platform binary not installed — happens when `npm install` was run
//      with `--omit=optional`, so the per-platform sqlite-vec package was
//      never downloaded. Fix: re-run `npm install` without that flag.
//   2. Extension loading disabled — better-sqlite3 was compiled with
//      SQLITE_OMIT_LOAD_EXTENSION or the feature was stripped by a distro
//      package. Fix: rebuild from source.
//   3. ABI / dlopen error — native library found but refused by the OS
//      (e.g. wrong architecture, missing dylib dependency). Message carries
//      the OS reason verbatim.
// After load() returns, a 1-vector KNN roundtrip catches the case where the
// extension was dlopen'd but the SQLite virtual-table machinery is broken —
// a silent ABI mismatch that `load()` itself would not detect.
function loadVecExtension(db: IndexDb): Result<void, Error> {
  try {
    sqliteVec.load(db);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    let hint: string;
    if (reason.includes("Cannot find module") || reason.includes("not found")) {
      // require.resolve threw MODULE_NOT_FOUND — the per-platform binary
      // package was never installed (most commonly: npm install --omit=optional).
      hint =
        "The sqlite-vec platform binary was not installed. " +
        "Re-run `npm install` without --omit=optional.";
    } else if (
      reason.includes("not authorized") ||
      reason.includes("extension loading") ||
      reason.includes("SQLITE_ERROR")
    ) {
      // db.loadExtension threw because the better-sqlite3 build has
      // extension loading compiled out.
      hint =
        "Rebuild better-sqlite3 with extension loading enabled: `npm rebuild better-sqlite3 --build-from-source`.";
    } else {
      // ABI mismatch, OS security policy, or other native-load error.
      hint = "Check that the sqlite-vec binary is compatible with this platform.";
    }
    return err(new Error(`cannot load sqlite-vec extension: ${reason}. ${hint}`));
  }

  // ABI smoke-test: insert one vector and retrieve it. Uses temp.schema
  // (CREATE VIRTUAL TABLE temp._vec_smoke) because SQLite does not allow
  // CREATE TEMP VIRTUAL TABLE syntax, but does allow schema-qualified names
  // that target the temp database. The table is dropped after the test so no
  // permanent schema changes land.
  const smokeBlob = Buffer.from(new Float32Array([1.0]).buffer);
  try {
    db.exec("CREATE VIRTUAL TABLE temp._vec_smoke USING vec0(v FLOAT[1] distance_metric=cosine);");
    db.prepare("INSERT INTO temp._vec_smoke(v) VALUES (?)").run(smokeBlob);
    const rows = db
      .prepare("SELECT * FROM temp._vec_smoke WHERE v MATCH ? AND k = ?")
      .all(smokeBlob, 1) as unknown[];
    db.exec("DROP TABLE IF EXISTS temp._vec_smoke;");
    if (rows.length !== 1) {
      return err(
        new Error(
          "sqlite-vec loaded but smoke-test returned no rows — " +
            "possible ABI mismatch between the sqlite-vec binary and this build of better-sqlite3",
        ),
      );
    }
  } catch (e) {
    try {
      db.exec("DROP TABLE IF EXISTS _vec_smoke;");
    } catch {
      // best-effort cleanup; ignore secondary failure
    }
    const reason = e instanceof Error ? e.message : String(e);
    return err(
      new Error(
        `sqlite-vec loaded but smoke-test failed: ${reason} — ` +
          "possible ABI mismatch between the sqlite-vec binary and this build of better-sqlite3",
      ),
    );
  }

  return ok(undefined);
}

// Creates the sqlite-vec virtual table at the given dim, dropping any
// existing copy first. `dim` is fixed at CREATE TABLE time for vec0, so a
// provider switch (which changes the active dim) means dropping and
// recreating; the durable `embeddings` cache survives, and the next reindex
// repopulates `embeddings_vec` from it.
function createVecTable(db: IndexDb, dim: number): void {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(
      `cannot create embeddings_vec at non-positive dim ${dim} — ` +
        "the active embedding provider must declare a positive integer dim",
    );
  }
  db.exec("DROP TABLE IF EXISTS embeddings_vec;");
  db.exec(
    `CREATE VIRTUAL TABLE embeddings_vec USING vec0(
       content_hash TEXT NOT NULL,
       model        TEXT NOT NULL,
       embedding    FLOAT[${dim}] distance_metric=cosine
     );`,
  );
  setMeta(db, VEC_DIM_META_KEY, String(dim));
}

// Drops every row from `embeddings_vec`. Called by the reindex path when
// it needs to repopulate the vec table from scratch (e.g. after a dim
// rebuild). Cheaper and clearer than a per-row delete in the common case.
export function clearEmbeddingsVec(db: IndexDb): void {
  db.exec("DELETE FROM embeddings_vec;");
}

// Inserts a vector row into the sqlite-vec mirror. Separate from
// `insertEmbedding` because the durable cache and the vec index are two
// stores — the cache survives a vec-table rebuild on provider switch.
export function insertEmbeddingVec(
  db: IndexDb,
  contentHash: string,
  model: string,
  embedding: Float32Array,
): void {
  db.prepare("INSERT INTO embeddings_vec(content_hash, model, embedding) VALUES (?, ?, ?)").run(
    contentHash,
    model,
    embeddingToBlob(embedding),
  );
}

// Deletes the vec-mirror rows for a single content_hash. Used by the
// orphan gc pass so the vec index never carries vectors whose chunks are
// gone.
function deleteEmbeddingsVecForHash(db: IndexDb, contentHash: string): void {
  db.prepare("DELETE FROM embeddings_vec WHERE content_hash = ?").run(contentHash);
}

// `expectedVecDim` is the active embedding provider's dim. If the persisted
// `embeddings_vec` was created at a different dim (or doesn't exist yet),
// it is dropped and recreated at the expected dim — the durable `embeddings`
// cache is untouched, so a switch back to the previous provider is all
// cache hits. `expectedVecDim` is required — pass the active provider's dim
// (e.g. `getProvider().dim`). Tests that don't exercise vector queries should
// use `LOCAL_MINILM_DIM` from `src/search/providers/local-minilm.ts`.
export function openIndexDb(vaultRoot: string, expectedVecDim: number): Result<IndexDb, Error> {
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    const db = new Database(indexDbPath(vaultRoot));
    db.pragma("journal_mode = WAL");

    // Load sqlite-vec BEFORE any CREATE VIRTUAL TABLE that uses `vec0` runs.
    // A failure here is loud and actionable — the server refuses to start
    // rather than silently falling back to brute-force cosine.
    const loaded = loadVecExtension(db);
    if (!loaded.ok) {
      db.close();
      return loaded;
    }

    // Ensure the meta table exists before reading schema_version from it.
    db.exec(`CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );`);
    const stored = getMeta(db, "schema_version");
    if (stored !== SCHEMA_VERSION) {
      // Schema bump means a clean rebuild: every derived table is dropped and
      // the freshness manifest is cleared so the next reindex repopulates
      // everything. Trying to ALTER across this change would race column
      // additions (3 → 4 added embeddings.dim) and virtual-table creations
      // (4 → 5 added documents_fts + embeddings_vec) against existing rows;
      // the markdown files are the source of truth and the index is cheap to
      // regenerate. staged_actions is jsonl-derived and clear-and-rebuilt by
      // its own materialize path, so it stays out of the drop list. A bump that
      // changes a jsonl-derived table's COLUMNS must drop it here, because
      // CREATE IF NOT EXISTS will not alter an existing table — the 5 → 6 bump
      // adds derives_from_edges.direction_verdict, so that table is dropped and
      // re-materialized from edges.jsonl on the next reindex.
      db.exec(
        "DROP TRIGGER IF EXISTS documents_ai;" +
          "DROP TRIGGER IF EXISTS documents_ad;" +
          "DROP TRIGGER IF EXISTS documents_au;" +
          "DROP TABLE IF EXISTS documents_fts;" +
          "DROP TABLE IF EXISTS embeddings_vec;" +
          "DROP TABLE IF EXISTS documents;" +
          "DROP TRIGGER IF EXISTS chunks_ai;" +
          "DROP TRIGGER IF EXISTS chunks_ad;" +
          "DROP TRIGGER IF EXISTS chunks_au;" +
          "DROP TABLE IF EXISTS chunks_fts;" +
          "DROP TABLE IF EXISTS chunks;" +
          "DROP TABLE IF EXISTS embeddings;" +
          "DROP TABLE IF EXISTS derives_from_edges;",
      );
      db.prepare("DELETE FROM meta WHERE key = ?").run("vault_manifest");
      db.prepare("DELETE FROM meta WHERE key = ?").run(VEC_DIM_META_KEY);
    }
    db.exec(SCHEMA);
    db.exec(FTS_SCHEMA);

    // If the persisted dim matches AND the virtual table already exists, leave
    // it alone — recreating would drop all the indexed vectors for no reason.
    const targetDim = expectedVecDim;
    const persistedDimRaw = getMeta(db, VEC_DIM_META_KEY);
    const persistedDim = persistedDimRaw ? Number.parseInt(persistedDimRaw, 10) : null;
    const vecTableExists =
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?")
          .get("embeddings_vec") as { n: number }
      ).n > 0;
    if (!vecTableExists || persistedDim !== targetDim) {
      createVecTable(db, targetDim);
    }

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
  // Normalize the date columns to canonical YYYY-MM-DD, or "" when the value is
  // not a real ISO date. The index is a derived cache, so cleaning here keeps a
  // malformed `created`/`updated` (which the frontmatter layer preserves raw on
  // disk, #113) from poisoning date-math consumers — getDocumentsInDateRange,
  // the coverage window, decay — without ever rewriting the source file. "" is
  // the established "undateable" sentinel the date readers already handle.
  const created = normalizeIsoDate(doc.created) ?? "";
  const updated = normalizeIsoDate(doc.updated) ?? "";
  // ON CONFLICT(path) DO UPDATE (rather than INSERT OR REPLACE) is required
  // so the AFTER UPDATE trigger on `documents` fires and keeps
  // `documents_fts` in sync. SQLite's OR REPLACE conflict resolution does
  // NOT fire DELETE/UPDATE triggers for the conflicting row — using it
  // would leave the FTS5 index pointing at stale terms after every
  // document overwrite.
  db.prepare(
    `INSERT INTO documents
       (path, title, collection, domain, status, confidence, updated, tags, content, tokens,
        ttl_days, created, superseded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       title         = excluded.title,
       collection    = excluded.collection,
       domain        = excluded.domain,
       status        = excluded.status,
       confidence    = excluded.confidence,
       updated       = excluded.updated,
       tags          = excluded.tags,
       content       = excluded.content,
       tokens        = excluded.tokens,
       ttl_days      = excluded.ttl_days,
       created       = excluded.created,
       superseded_by = excluded.superseded_by`,
  ).run(
    doc.path,
    doc.title,
    doc.collection,
    doc.domain,
    doc.status,
    doc.confidence,
    updated,
    JSON.stringify(doc.tags),
    doc.content,
    JSON.stringify(doc.tokens),
    doc.ttlDays,
    created,
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

// Persists a vector under (content_hash, model). `dim` is asserted to match
// `embedding.length` — a mismatch would write a corrupt row that the cosine
// math reads back as silent garbage. The store stays oblivious to which
// provider produced the vector; callers pass the provider's `id` and `dim`.
export function insertEmbedding(
  db: IndexDb,
  contentHash: string,
  model: string,
  embedding: Float32Array,
  createdAt: string,
  dim: number,
): void {
  if (embedding.length !== dim) {
    throw new Error(
      `embedding length ${embedding.length} does not match declared dim ${dim} ` +
        `for model '${model}' — refusing to write a corrupt cache row`,
    );
  }
  db.prepare(
    `INSERT OR REPLACE INTO embeddings (content_hash, model, dim, embedding, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(contentHash, model, dim, embeddingToBlob(embedding), createdAt);
}

// Deletes every embeddings row whose content_hash is referenced by no chunks
// row, and removes the matching rows from the sqlite-vec mirror. Called at
// the end of a reindex to reap entries for chunks that no longer exist
// anywhere in the vault. Returns the number of `embeddings` rows deleted —
// the vec-mirror counts piggy-back and are not reported separately.
export function gcOrphanedEmbeddings(db: IndexDb): number {
  // Collect the orphan hashes first so we can drop them from both stores in
  // one pass. The `embeddings_vec` virtual table doesn't support correlated
  // subqueries on its meta columns reliably, so we go through prepared
  // deletes by hash.
  const orphans = db
    .prepare(
      `SELECT content_hash
         FROM embeddings
        WHERE content_hash NOT IN (SELECT content_hash FROM chunks)`,
    )
    .all() as { content_hash: string }[];
  if (orphans.length === 0) return 0;
  const drop = db.transaction(() => {
    const dropEmb = db.prepare("DELETE FROM embeddings WHERE content_hash = ?");
    for (const { content_hash } of orphans) {
      dropEmb.run(content_hash);
      deleteEmbeddingsVecForHash(db, content_hash);
    }
  });
  drop();
  return orphans.length;
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

// Documents whose `created` date falls within [start, end] inclusive, ordered
// most-recent first (ties by path for determinism). Undateable docs (empty
// `created`) are excluded. ISO dates sort lexically so string comparison is a
// valid date range. Backs the coverage pass's date-window pull.
export function getDocumentsInDateRange(
  db: IndexDb,
  start: string,
  end: string,
): IndexedDocument[] {
  const rows = db
    .prepare(
      `SELECT * FROM documents
        WHERE created != '' AND created >= ? AND created <= ?
        ORDER BY created DESC, path ASC`,
    )
    .all(start, end) as DocumentRow[];
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
  dim: number | null;
}

// Converts a join row to the public chunk shape. The embedding is read iff
// its stored dim matches the active provider's expected dim — a mismatch
// would only happen if a row was written under different metadata than its
// blob (a bug or hand-edit), and we'd rather skip it than score with garbage.
// `expectedDim` may be 0 to opt out of the check (legacy callers in tests).
function rowToChunk(row: ChunkJoinRow, expectedDim: number): IndexedChunk {
  let embedding: Float32Array | null = null;
  if (row.embedding) {
    const blobOk = expectedDim === 0 || row.embedding.length === expectedDim * 4;
    const dimOk = expectedDim === 0 || row.dim === expectedDim;
    if (blobOk && dimOk) {
      embedding = blobToEmbedding(row.embedding);
    }
    // Silent skip — vector ranking just falls back as if this row had no
    // embedding for the join. A noisy log here would be invoked per-chunk on
    // a long mismatch; the conditions are bugs surfaced by tests instead.
  }
  return {
    path: row.path,
    chunkIndex: row.chunk_index,
    text: row.text,
    contentHash: row.content_hash,
    embedding,
  };
}

// Reads every chunk LEFT JOINed against the embeddings cache, filtered to
// `model`. A chunk whose content_hash has no embeddings row for this model
// (e.g. the model was unavailable during reindex) comes back with embedding =
// null and the vector ranker simply skips it, matching the old NULL-blob
// behaviour. `expectedDim` is a defense-in-depth check: any row whose stored
// dim or blob byte length disagrees is treated as missing, so a corrupt or
// cross-provider mix can't poison cosine math.
export function getAllChunks(db: IndexDb, model: string, expectedDim = 0): IndexedChunk[] {
  const rows = db
    .prepare(
      `SELECT c.path, c.chunk_index, c.text, c.content_hash, e.embedding, e.dim
         FROM chunks c
         LEFT JOIN embeddings e
           ON e.content_hash = c.content_hash AND e.model = ?
        ORDER BY c.path, c.chunk_index`,
    )
    .all(model) as ChunkJoinRow[];
  return rows.map((row) => rowToChunk(row, expectedDim));
}

export function getChunksForPath(
  db: IndexDb,
  path: string,
  model: string,
  expectedDim = 0,
): IndexedChunk[] {
  const rows = db
    .prepare(
      `SELECT c.path, c.chunk_index, c.text, c.content_hash, e.embedding, e.dim
         FROM chunks c
         LEFT JOIN embeddings e
           ON e.content_hash = c.content_hash AND e.model = ?
        WHERE c.path = ?
        ORDER BY c.chunk_index`,
    )
    .all(model, path) as ChunkJoinRow[];
  return rows.map((row) => rowToChunk(row, expectedDim));
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

// Counts embedding cache rows for `model` whose stored `dim` does not match
// `expectedDim`. A non-zero result means some cached vectors will be silently
// skipped by `rowToChunk`'s dim-guard, so vector search falls back to
// keyword-only for those chunks. Exposed via vault_status so operators can
// detect a corrupt cache without digging through logs.
export function countDimMismatches(db: IndexDb, model: string, expectedDim: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM embeddings WHERE model = ? AND dim != ?")
    .get(model, expectedDim) as { n: number };
  return row.n;
}

// --- staged actions --------------------------------------------------------
//
// The staged_actions table is a derived index of the append-only canonical
// log .daftari/staged-actions.jsonl (see src/curation/staged-actions.ts).
// Like every table in this file it is rebuildable: a reindex collapses the
// jsonl to current state and repopulates the table. These functions are the
// SQL primitives the collapse uses; the curation layer owns the jsonl and the
// lifecycle logic. The row shape mirrors the jsonl record one-for-one.

export interface StagedActionRow {
  id: string;
  action_type: string;
  target_path: string;
  proposed_by: string;
  proposed_at: string;
  expires_at: string;
  status: string;
  rationale: string;
  proposed_diff: string; // JSON-encoded delta or write payload
  ratified_at: string | null;
  ratified_by: string | null;
  ratification_reason: string | null;
  // Carried on the in-memory row and in the JSONL decision record; NOT stored
  // in the staged_actions sqlite table (no DDL/upsert change needed).
  decided_by_principal?: string | null;
}

// Inserts or replaces a staged-action row by id. Used by the jsonl→sqlite
// rebuild; the proposal and its later decision collapse to one current row.
export function upsertStagedAction(db: IndexDb, row: StagedActionRow): void {
  db.prepare(
    `INSERT INTO staged_actions
       (id, action_type, target_path, proposed_by, proposed_at, expires_at, status,
        rationale, proposed_diff, ratified_at, ratified_by, ratification_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       action_type         = excluded.action_type,
       target_path         = excluded.target_path,
       proposed_by         = excluded.proposed_by,
       proposed_at         = excluded.proposed_at,
       expires_at          = excluded.expires_at,
       status              = excluded.status,
       rationale           = excluded.rationale,
       proposed_diff       = excluded.proposed_diff,
       ratified_at         = excluded.ratified_at,
       ratified_by         = excluded.ratified_by,
       ratification_reason = excluded.ratification_reason`,
  ).run(
    row.id,
    row.action_type,
    row.target_path,
    row.proposed_by,
    row.proposed_at,
    row.expires_at,
    row.status,
    row.rationale,
    row.proposed_diff,
    row.ratified_at,
    row.ratified_by,
    row.ratification_reason,
  );
}

// Drops every staged-action row. Called at the start of a rebuild so a
// reindex never leaves rows for actions the jsonl no longer reflects.
export function clearStagedActions(db: IndexDb): void {
  db.exec("DELETE FROM staged_actions;");
}

export function getStagedAction(db: IndexDb, id: string): StagedActionRow | null {
  const row = db.prepare("SELECT * FROM staged_actions WHERE id = ?").get(id) as
    | StagedActionRow
    | undefined;
  return row ?? null;
}

export function getAllStagedActions(db: IndexDb): StagedActionRow[] {
  return db.prepare("SELECT * FROM staged_actions ORDER BY id").all() as StagedActionRow[];
}

// Returns rows in a given status, soonest-to-expire first — the order the
// lint surface and the future loop want.
export function getStagedActionsByStatus(db: IndexDb, status: string): StagedActionRow[] {
  return db
    .prepare("SELECT * FROM staged_actions WHERE status = ? ORDER BY expires_at")
    .all(status) as StagedActionRow[];
}

// --- derives_from edges ------------------------------------------------------
//
// The derives_from_edges table is a derived index of the append-only canonical
// log .daftari/edges.jsonl (see src/curation/edges.ts). A reindex collapses
// the jsonl and repopulates the table; `strength` and `status` are materialized
// as of `last_age_decay` and age from there (the curation layer recomputes the
// live value via agedStrength). The table exists for the future consolidation
// loop's traversal engine, which wants concurrent SQL reads (spec §11.3); v1
// read paths use the jsonl directly. Column set is exactly §11.3's schema.

export interface DerivesFromEdgeRow {
  from_path: string;
  to_path: string;
  strength: number;
  k_survived: number;
  first_observed: string;
  last_rederived: string;
  last_age_decay: string;
  status: string; // candidate | trigger-bearing | revoked
  direction_verdict: string; // directed | symmetric
}

// Inserts or replaces an edge row by (from_path, to_path). Used by the
// jsonl→sqlite rebuild.
export function upsertDerivesFromEdge(db: IndexDb, row: DerivesFromEdgeRow): void {
  db.prepare(
    `INSERT INTO derives_from_edges
       (from_path, to_path, strength, k_survived, first_observed, last_rederived,
        last_age_decay, status, direction_verdict)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(from_path, to_path) DO UPDATE SET
       strength       = excluded.strength,
       k_survived     = excluded.k_survived,
       first_observed = excluded.first_observed,
       last_rederived = excluded.last_rederived,
       last_age_decay = excluded.last_age_decay,
       status         = excluded.status,
       direction_verdict = excluded.direction_verdict`,
  ).run(
    row.from_path,
    row.to_path,
    row.strength,
    row.k_survived,
    row.first_observed,
    row.last_rederived,
    row.last_age_decay,
    row.status,
    row.direction_verdict,
  );
}

// Drops every edge row. Called at the start of a rebuild so a reindex never
// leaves rows for edges the jsonl no longer reflects.
export function clearDerivesFromEdges(db: IndexDb): void {
  db.exec("DELETE FROM derives_from_edges;");
}

export function getAllDerivesFromEdges(db: IndexDb): DerivesFromEdgeRow[] {
  return db
    .prepare("SELECT * FROM derives_from_edges ORDER BY from_path, to_path")
    .all() as DerivesFromEdgeRow[];
}
