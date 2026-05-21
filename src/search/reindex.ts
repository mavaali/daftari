// Rebuilds the SQLite search index from the markdown files on disk.
//
// The index is a derived cache, so a reindex always clears it and rebuilds
// from scratch — there is no incremental update path to drift out of sync.
// Called on server start and by the vault_reindex tool / --reindex CLI flag.
//
// Embedding is content-addressed: each chunk's text is hashed (sha256), and
// the embeddings table is keyed by (content_hash, model). A reindex hashes
// every chunk, asks the cache which (hash, model) pairs already exist, and
// only embeds the misses. Edits to one file re-embed that file's changed
// chunks; renames, moved paragraphs, and identical text in two files all
// hit the cache and embed zero. Orphaned cache rows (chunks that no longer
// reference them) are reaped at the end of the pass.
//
// If the model is unavailable the documents (and their BM25 tokens) still
// index; chunks are written with their content_hash but no embedding row is
// inserted, so the join in vector.ts comes back null and search degrades to
// lexical-only.

import { stat } from "node:fs/promises";
import { parseDocument } from "../frontmatter/parser.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import {
  type ChunkRowInput,
  clearIndex,
  deleteDocument,
  documentCount,
  existingEmbeddingHashes,
  gcOrphanedEmbeddings,
  getMeta,
  type IndexDb,
  type IndexedDocument,
  insertChunkRow,
  insertDocument,
  insertEmbedding,
  openIndexDb,
  setMeta,
} from "../storage/index-db.js";
import { listFiles, readFile, resolveVaultPath } from "../storage/local.js";
import { sha256Hex } from "../utils/hash.js";
import { tokenize } from "./bm25.js";
import { chunkText, embed, getProvider } from "./vector.js";

// Manifest key in the meta table: JSON object mapping vault-relative path to
// mtime in ms. Written at the end of a successful reindex and updated by
// indexDocument after each incremental write, so a startup freshness check
// can decide whether the persisted index already reflects the files on disk.
const MANIFEST_META_KEY = "vault_manifest";

// Walks the vault and produces a fresh path→mtimeMs map. Returns null if any
// file cannot be stat'd or the file listing fails — caller treats null as
// "can't prove freshness, fall back to a full reindex."
async function buildManifest(vaultRoot: string): Promise<Record<string, number> | null> {
  const list = await listFiles(vaultRoot);
  if (!list.ok) return null;
  const manifest: Record<string, number> = {};
  for (const relPath of list.value) {
    const resolved = resolveVaultPath(vaultRoot, relPath);
    if (!resolved.ok) return null;
    try {
      const st = await stat(resolved.value);
      manifest[relPath] = st.mtimeMs;
    } catch {
      return null;
    }
  }
  return manifest;
}

function readManifest(db: IndexDb): Record<string, number> | null {
  const raw = getMeta(db, MANIFEST_META_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, number>;
  } catch {
    return null;
  }
}

function writeManifest(db: IndexDb, manifest: Record<string, number>): void {
  setMeta(db, MANIFEST_META_KEY, JSON.stringify(manifest));
}

function manifestsMatch(a: Record<string, number>, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

// Returns true when the persisted index already reflects every markdown file
// on disk: doc count is non-zero, a manifest exists, and every file's mtime
// matches the stored value. Used by `main()` to skip a 20+ minute re-embed
// pass on every restart of a vault that hasn't changed.
export async function isIndexFresh(vaultRoot: string): Promise<boolean> {
  const dbResult = openIndexDb(vaultRoot);
  if (!dbResult.ok) return false;
  const db = dbResult.value;
  try {
    if (documentCount(db) === 0) return false;
    const stored = readManifest(db);
    if (!stored) return false;
    const current = await buildManifest(vaultRoot);
    if (!current) return false;
    return manifestsMatch(stored, current);
  } finally {
    db.close();
  }
}

export interface ReindexResult {
  documentCount: number;
  chunkCount: number;
  vectorEnabled: boolean;
  skipped: string[];
  indexedAt: string;
  // Cache stats: how many chunks needed a fresh embedding vs hit the cache,
  // and how many orphaned embedding rows the gc pass reaped. Useful for
  // tests and for surfacing the O(vault) → O(changed chunks) win.
  embeddedCount: number;
  cacheHits: number;
  orphansRemoved: number;
}

export interface ReindexOptions {
  // Fires during the embedding phase (the slow part of a reindex) with the
  // number of chunks embedded so far and the total. Lets a caller report
  // progress so a large-vault reindex is not silent. Total is the number of
  // chunks actually being embedded (cache misses), not the whole vault — a
  // fully-cached reindex calls this zero times.
  onProgress?: (done: number, total: number) => void;
}

interface StagedDocument {
  doc: IndexedDocument;
  chunks: string[];
  hashes: string[];
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

  const chunks = chunkText(body);
  const hashes = chunks.map((t) => sha256Hex(t));

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
    chunks,
    hashes,
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

// Inserts the chunk rows in a single transaction. Embeddings are persisted by
// the caller (with a model identifier) so the chunk write stays oblivious to
// which model produced the vectors.
function writeChunkRows(db: IndexDb, staged: StagedDocument[]): number {
  let chunkCount = 0;
  const write = db.transaction(() => {
    clearIndex(db);
    for (const { doc, chunks, hashes } of staged) {
      insertDocument(db, doc);
      chunks.forEach((text, chunkIndex) => {
        const row: ChunkRowInput = {
          path: doc.path,
          chunkIndex,
          text,
          contentHash: hashes[chunkIndex] ?? "",
        };
        insertChunkRow(db, row);
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

  // Open the index first so we can ask the embeddings cache which (hash,
  // model) pairs already exist before deciding what to embed.
  const dbResult = openIndexDb(vaultRoot);
  if (!dbResult.ok) return dbResult;
  const db = dbResult.value;

  const indexedAt = new Date().toISOString();
  try {
    // Flatten every chunk's text + hash so we can dedupe and query the cache
    // in one shot. A single hash may appear in multiple files (or repeatedly
    // in one file) — embed it once.
    const allHashes: string[] = [];
    const allTexts: string[] = [];
    for (const s of staged) {
      for (let i = 0; i < s.chunks.length; i++) {
        const h = s.hashes[i] ?? "";
        const t = s.chunks[i] ?? "";
        allHashes.push(h);
        allTexts.push(t);
      }
    }

    const provider = getProvider();
    const cached = existingEmbeddingHashes(db, provider.id, allHashes);

    // Build the deduped miss list. Each unique missing hash gets embedded
    // exactly once; identical chunk text in multiple places shares the row.
    const missTextByHash = new Map<string, string>();
    for (let i = 0; i < allHashes.length; i++) {
      const h = allHashes[i] ?? "";
      if (cached.has(h)) continue;
      if (missTextByHash.has(h)) continue;
      missTextByHash.set(h, allTexts[i] ?? "");
    }
    const missHashes = [...missTextByHash.keys()];
    const missTexts = missHashes.map((h) => missTextByHash.get(h) ?? "");

    const totalChunks = allHashes.length;
    const cacheHits = totalChunks - allHashes.filter((h) => !cached.has(h)).length;

    let vectorEnabled = true;
    if (missTexts.length > 0) {
      const embedResult = await embed(missTexts, opts.onProgress);
      if (embedResult.ok) {
        const writeEmbeds = db.transaction(() => {
          for (let i = 0; i < missHashes.length; i++) {
            const h = missHashes[i] ?? "";
            const vec = embedResult.value[i];
            if (!vec) continue;
            insertEmbedding(db, h, provider.id, vec, indexedAt, provider.dim);
          }
        });
        writeEmbeds();
      } else {
        // Model unavailable. We still want documents + chunk rows so BM25
        // works; vector ranking simply degrades to nothing for this reindex.
        vectorEnabled = false;
      }
    } else if (totalChunks === 0) {
      // No chunks at all (empty vault). Treat as vectorEnabled=true by
      // convention — there is nothing to embed but also nothing failed.
      vectorEnabled = true;
    } else {
      // Everything was cached. Vector ranking has data already, so the
      // reindex did not need to load the model — still vector-enabled.
      vectorEnabled = true;
    }

    const chunkCount = writeChunkRows(db, staged);
    const orphansRemoved = gcOrphanedEmbeddings(db);

    setMeta(db, "indexed_at", indexedAt);
    setMeta(db, "vector_enabled", String(vectorEnabled));
    setMeta(db, "embedding_dim", String(provider.dim));
    setMeta(db, "embedding_model", provider.id);
    // Persist a freshness manifest so the next startup can skip this whole
    // pass when nothing on disk has changed.
    const manifest = await buildManifest(vaultRoot);
    if (manifest) writeManifest(db, manifest);
    return ok({
      documentCount: staged.length,
      chunkCount,
      vectorEnabled,
      skipped,
      indexedAt,
      embeddedCount: missHashes.length,
      cacheHits,
      orphansRemoved,
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
// one-document one. Otherwise it re-stages just `relPath`, hashes its chunks,
// embeds only those whose (hash, model) pair is not already in the embeddings
// cache, evicts the document's stale chunk rows, and re-inserts.
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
  const { doc, chunks, hashes } = staged;

  const dbResult = openIndexDb(vaultRoot);
  if (!dbResult.ok) return dbResult;
  const db = dbResult.value;
  const createdAt = new Date().toISOString();

  try {
    const provider = getProvider();
    const cached = existingEmbeddingHashes(db, provider.id, hashes);
    const missTextByHash = new Map<string, string>();
    for (let i = 0; i < hashes.length; i++) {
      const h = hashes[i] ?? "";
      if (cached.has(h)) continue;
      if (missTextByHash.has(h)) continue;
      missTextByHash.set(h, chunks[i] ?? "");
    }
    const missHashes = [...missTextByHash.keys()];
    const missTexts = missHashes.map((h) => missTextByHash.get(h) ?? "");

    let vectorEnabled = true;
    if (missTexts.length > 0) {
      const embedResult = await embed(missTexts);
      if (embedResult.ok) {
        const writeEmbeds = db.transaction(() => {
          for (let i = 0; i < missHashes.length; i++) {
            const h = missHashes[i] ?? "";
            const vec = embedResult.value[i];
            if (!vec) continue;
            insertEmbedding(db, h, provider.id, vec, createdAt, provider.dim);
          }
        });
        writeEmbeds();
      } else {
        vectorEnabled = false;
      }
    }

    const write = db.transaction(() => {
      deleteDocument(db, doc.path);
      insertDocument(db, doc);
      chunks.forEach((text, chunkIndex) => {
        insertChunkRow(db, {
          path: doc.path,
          chunkIndex,
          text,
          contentHash: hashes[chunkIndex] ?? "",
        });
      });
    });
    write();
    // Keep the freshness manifest in sync with this single write so the next
    // startup still sees a current index. Stat the file we just indexed and
    // patch only its entry — re-statting the whole vault would defeat the
    // point of the incremental path.
    const stored = readManifest(db);
    if (stored) {
      const resolved = resolveVaultPath(vaultRoot, relPath);
      if (resolved.ok) {
        try {
          const st = await stat(resolved.value);
          stored[relPath] = st.mtimeMs;
          writeManifest(db, stored);
        } catch {
          // ignore — manifest just stays stale for this entry; worst case is
          // one extra reindex on next startup.
        }
      }
    }
    return ok({ chunkCount: chunks.length, vectorEnabled });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`index update failed: ${reason}`));
  } finally {
    db.close();
  }
}
