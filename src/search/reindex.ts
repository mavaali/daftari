// Rebuilds the SQLite search index from the markdown files on disk.
//
// The index is a derived cache, so a reindex always clears it and rebuilds
// from scratch — there is no incremental update path to drift out of sync.
// Called on server start and by the vault_reindex tool / --reindex CLI flag.
//
// Embedding is best-effort: every chunk across the whole vault is embedded in
// one batch. If the model is unavailable the documents (and their BM25 tokens)
// still index; only the vector column is left NULL and vectorEnabled is false.

import { parseDocument } from "../frontmatter/parser.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import {
  clearIndex,
  insertChunk,
  insertDocument,
  openIndexDb,
  setMeta,
  type IndexDb,
  type IndexedDocument,
} from "../storage/index-db.js";
import { listFiles, readFile, resolveVaultPath } from "../storage/local.js";
import { tokenize } from "./bm25.js";
import { chunkText, embed, EMBEDDING_DIM } from "./vector.js";

export interface ReindexResult {
  documentCount: number;
  chunkCount: number;
  vectorEnabled: boolean;
  skipped: string[];
  indexedAt: string;
}

interface StagedDocument {
  doc: IndexedDocument;
  chunks: string[];
}

// Reads and parses every markdown file into the shape the index needs. A file
// whose YAML frontmatter is malformed is skipped (recorded in `skipped`) rather
// than aborting the whole rebuild.
async function stageDocuments(
  vaultRoot: string,
): Promise<Result<{ staged: StagedDocument[]; skipped: string[] }, Error>> {
  const list = await listFiles(vaultRoot);
  if (!list.ok) return list;

  const staged: StagedDocument[] = [];
  const skipped: string[] = [];

  for (const relPath of list.value) {
    const resolved = resolveVaultPath(vaultRoot, relPath);
    if (!resolved.ok) {
      skipped.push(relPath);
      continue;
    }
    const file = await readFile(resolved.value);
    if (!file.ok) {
      skipped.push(relPath);
      continue;
    }
    const parsed = parseDocument(file.value);
    if (!parsed.ok) {
      skipped.push(relPath);
      continue;
    }

    const fm = parsed.value.frontmatter;
    const body = parsed.value.content;
    // BM25 indexes title, tags, and body together so a title- or tag-only
    // match still ranks.
    const tokens = tokenize(
      `${fm.title} ${fm.tags.join(" ")} ${body}`,
    );

    staged.push({
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
      },
      chunks: chunkText(body),
    });
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
): Promise<Result<ReindexResult, Error>> {
  const staging = await stageDocuments(vaultRoot);
  if (!staging.ok) return staging;
  const { staged, skipped } = staging.value;

  // One flat list of every chunk's text, embedded in a single batch.
  const allChunkTexts: string[] = [];
  for (const s of staged) allChunkTexts.push(...s.chunks);

  const embedResult = await embed(allChunkTexts);
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
