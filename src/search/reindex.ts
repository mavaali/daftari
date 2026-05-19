// Rebuilds the SQLite search index from the markdown files on disk.
//
// The index is a derived cache, so a reindex always clears it and rebuilds
// from scratch — there is no incremental update path to drift out of sync.
// Called on server start and by the vault_reindex tool / --reindex CLI flag.
//
// Embedding is best-effort: every chunk across the whole vault is embedded,
// in fixed-size sub-batches so peak memory stays flat as the vault grows. If
// the model is unavailable the documents (and their BM25 tokens) still index;
// only the vector column is left NULL and vectorEnabled is false.

import { parseDocument } from "../frontmatter/parser.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import {
  clearIndex,
  deleteDocument,
  documentCount,
  type IndexDb,
  type IndexedDocument,
  insertChunk,
  insertDocument,
  openIndexDb,
  setMeta,
} from "../storage/index-db.js";
import { listFiles, readFile, resolveVaultPath } from "../storage/local.js";
import { tokenize } from "./bm25.js";
import { chunkText, EMBEDDING_DIM, embed } from "./vector.js";

export interface ReindexResult {
  documentCount: number;
  chunkCount: number;
  vectorEnabled: boolean;
  skipped: string[];
  indexedAt: string;
}

export interface ReindexOptions {
  // Fires during the embedding phase (the slow part of a reindex) with the
  // number of chunks embedded so far and the total. Lets a caller report
  // progress so a large-vault reindex is not silent.
  onProgress?: (done: number, total: number) => void;
}

interface StagedDocument {
  doc: IndexedDocument;
  chunks: string[];
}

// Reads and parses a single markdown file into the shape the index needs.
// Returns null when the file should be skipped (unreadable, or malformed YAML
// frontmatter) so a reindex never aborts on one bad file.
async function stageOne(vaultRoot: string, relPath: string): Promise<StagedDocument | null> {
  const resolved = resolveVaultPath(vaultRoot, relPath);
  if (!resolved.ok) return null;
  const file = await readFile(resolved.value);
  if (!file.ok) return null;
  const parsed = parseDocument(file.value);
  if (!parsed.ok) return null;

  const fm = parsed.value.frontmatter;
  const body = parsed.value.content;
  // BM25 indexes title, tags, and body together so a title- or tag-only
  // match still ranks.
  const tokens = tokenize(`${fm.title} ${fm.tags.join(" ")} ${body}`);

  return {
    doc: {
      path: relPath,
      title: fm.title,
      collection: fm.collection || (relPath.split("/")[0] ?? ""),
      domain: fm.domain,
      status: fm.status,
      confidence: fm.confidence,
      updated: fm.updated,
      tags: fm.tags,
      content: body,
      tokens,
      ttlDays: fm.ttl_days,
      created: fm.created,
      supersededBy: fm.superseded_by,
    },
    chunks: chunkText(body),
  };
}

// Reads and parses every markdown file into the shape the index needs. A file
// that stageOne rejects is skipped (recorded in `skipped`) rather than
// aborting the whole rebuild.
async function stageDocuments(
  vaultRoot: string,
): Promise<Result<{ staged: StagedDocument[]; skipped: string[] }, Error>> {
  const list = await listFiles(vaultRoot);
  if (!list.ok) return list;

  const staged: StagedDocument[] = [];
  const skipped: string[] = [];

  for (const relPath of list.value) {
    const one = await stageOne(vaultRoot, relPath);
    if (one) staged.push(one);
    else skipped.push(relPath);
  }

  return ok({ staged, skipped });
}

function writeIndex(
  db: IndexDb,
  staged: StagedDocument[],
  embeddings: (Float32Array | null)[],
): number {
  let chunkCount = 0;
  let cursor = 0;
  const write = db.transaction(() => {
    clearIndex(db);
    for (const { doc, chunks } of staged) {
      insertDocument(db, doc);
      chunks.forEach((text, chunkIndex) => {
        insertChunk(db, {
          path: doc.path,
          chunkIndex,
          text,
          embedding: embeddings[cursor] ?? null,
        });
        cursor += 1;
        chunkCount += 1;
      });
    }
  });
  write();
  return chunkCount;
}

export async function reindexVault(
  vaultRoot: string,
  opts: ReindexOptions = {},
): Promise<Result<ReindexResult, Error>> {
  const staging = await stageDocuments(vaultRoot);
  if (!staging.ok) return staging;
  const { staged, skipped } = staging.value;

  // One flat list of every chunk's text; embed() processes it in sub-batches.
  const allChunkTexts: string[] = [];
  for (const s of staged) allChunkTexts.push(...s.chunks);

  const embedResult = await embed(allChunkTexts, opts.onProgress);
  const vectorEnabled = embedResult.ok;
  const embeddings: (Float32Array | null)[] = embedResult.ok
    ? embedResult.value
    : allChunkTexts.map(() => null);

  const dbResult = openIndexDb(vaultRoot);
  if (!dbResult.ok) return dbResult;
  const db = dbResult.value;

  const indexedAt = new Date().toISOString();
  try {
    const chunkCount = writeIndex(db, staged, embeddings);
    setMeta(db, "indexed_at", indexedAt);
    setMeta(db, "vector_enabled", String(vectorEnabled));
    setMeta(db, "embedding_dim", String(EMBEDDING_DIM));
    return ok({
      documentCount: staged.length,
      chunkCount,
      vectorEnabled,
      skipped,
      indexedAt,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`reindex write failed: ${reason}`));
  } finally {
    db.close();
  }
}

export interface IndexDocumentResult {
  chunkCount: number;
  vectorEnabled: boolean;
}

// Incrementally updates the index for a single document after a write.
//
// If the index has never been built it falls back to a full reindex, so the
// first write to a fresh vault still produces a complete index rather than a
// one-document one. Otherwise it re-stages just `relPath`, evicts its stale
// rows, and re-inserts — embedding only that document's chunks.
export async function indexDocument(
  vaultRoot: string,
  relPath: string,
): Promise<Result<IndexDocumentResult, Error>> {
  const dbCheck = openIndexDb(vaultRoot);
  if (!dbCheck.ok) return dbCheck;
  const indexEmpty = documentCount(dbCheck.value) === 0;
  dbCheck.value.close();

  if (indexEmpty) {
    const full = await reindexVault(vaultRoot);
    if (!full.ok) return full;
    return ok({
      chunkCount: full.value.chunkCount,
      vectorEnabled: full.value.vectorEnabled,
    });
  }

  const staged = await stageOne(vaultRoot, relPath);
  if (!staged) {
    return err(new Error(`cannot index document: ${relPath}`));
  }
  const { doc, chunks } = staged;

  const embedResult = await embed(chunks);
  const vectorEnabled = embedResult.ok;
  const embeddings: (Float32Array | null)[] = embedResult.ok
    ? embedResult.value
    : chunks.map(() => null);

  const dbResult = openIndexDb(vaultRoot);
  if (!dbResult.ok) return dbResult;
  const db = dbResult.value;
  try {
    const write = db.transaction(() => {
      deleteDocument(db, doc.path);
      insertDocument(db, doc);
      chunks.forEach((text, chunkIndex) => {
        insertChunk(db, {
          path: doc.path,
          chunkIndex,
          text,
          embedding: embeddings[chunkIndex] ?? null,
        });
      });
    });
    write();
    return ok({ chunkCount: chunks.length, vectorEnabled });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`index update failed: ${reason}`));
  } finally {
    db.close();
  }
}
