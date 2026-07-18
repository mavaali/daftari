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
import { rebuildEdgesIndex } from "../curation/edges.js";
import { rebuildStagedActionsIndex } from "../curation/staged-actions.js";
import { buildPathIndexes, outgoingLinkTargets } from "../curation/vault-docs.js";
import { parseDocument } from "../frontmatter/parser.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import {
  allDocumentPaths,
  type ChunkRowInput,
  clearEmbeddingsVec,
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
  insertEmbeddingVec,
  openIndexDb,
  replaceDocLinks,
  setMeta,
} from "../storage/index-db.js";
import { listFiles, readFile, resolveVaultPath } from "../storage/local.js";
import { sha256Hex } from "../utils/hash.js";
import { tokenize } from "./bm25.js";
import { chunkText, embed, getProvider } from "./vector.js";

// Opens the index DB with the active embedding provider's dim, so the
// sqlite-vec virtual table is created (or rebuilt) at the right
// dimensionality. Every reindex / index-document path opens the DB this
// way; a caller that doesn't care about vectors (a freshness probe,
// say) can fall back to `openIndexDb(vault)` which uses a default dim.
function openIndexForActiveProvider(vaultRoot: string) {
  return openIndexDb(vaultRoot, getProvider().dim);
}

// Repopulates the sqlite-vec mirror from the durable `embeddings` cache
// for the given model. Called at the end of every full reindex so the vec
// table always reflects the current vault. The previous mirror contents
// are dropped wholesale — simpler and faster than a diff for the sizes
// this index reaches in practice.
function rebuildEmbeddingsVec(db: IndexDb, modelId: string): void {
  const rebuild = db.transaction(() => {
    clearEmbeddingsVec(db);
    const rows = db
      .prepare(
        `SELECT e.content_hash AS content_hash, e.embedding AS embedding
           FROM embeddings AS e
          WHERE e.model = ?
            AND e.content_hash IN (SELECT content_hash FROM chunks)`,
      )
      .all(modelId) as { content_hash: string; embedding: Buffer }[];
    const insert = db.prepare(
      "INSERT INTO embeddings_vec(content_hash, model, embedding) VALUES (?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(row.content_hash, modelId, row.embedding);
    }
  });
  rebuild();
}

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
      const st = await stat(resolved.value.absPath);
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
  const dbResult = openIndexForActiveProvider(vaultRoot);
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

// A vault file flagged during a reindex, with a human-readable reason. Used
// for two distinct buckets in ReindexResult — `skipped` (could not be indexed
// at all) and `invalidFrontmatter` (indexed, but its frontmatter failed schema
// validation) — so the server/CLI can surface *why* instead of staying silent.
export interface FlaggedDocument {
  path: string;
  reason: string;
}

export interface ReindexResult {
  documentCount: number;
  chunkCount: number;
  vectorEnabled: boolean;
  // Files that could not be indexed at all: unreadable, or malformed YAML
  // frontmatter. Not present in the index.
  skipped: FlaggedDocument[];
  // Files that WERE indexed but whose frontmatter violates the schema (e.g. an
  // out-of-enum value). validateFrontmatter coerces the offending fields to
  // their defaults for the index row, so the index value can differ from what
  // the file declares. Reported here so that coercion is never silent — the
  // markdown file remains the source of truth; `vault_lint` is the repair path.
  invalidFrontmatter: FlaggedDocument[];
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
  // Test seam (#54): how many cache-miss chunks are embedded and COMMITTED
  // per batch. Production uses EMBED_COMMIT_BATCH; tests shrink it to drive
  // the interrupted-build resume path without a large fixture.
  embedCommitBatch?: number;
}

// #54: embeddings land in the durable content-addressed cache PER BATCH, not
// in one end-of-build transaction. The cache thereby doubles as the resume
// checkpoint: a process-lock takeover SIGTERM mid-build loses at most one
// batch, and the next build's existingEmbeddingHashes() pass sees every
// committed batch as a cache hit and embeds only the remainder — no cursor,
// no new state, the table the build already consults IS the watermark.
const EMBED_COMMIT_BATCH = 64;

// Human-readable warning lines for a reindex result's `skipped` and
// `invalidFrontmatter` buckets, or [] when both are empty. Callers write these
// to stderr so documents missing from the index — or indexed with coerced
// frontmatter — are surfaced at reindex time rather than only by a later
// vault_lint pass. Pure: no I/O, so it is unit-testable without a model.
export function reindexWarnings(result: ReindexResult): string[] {
  const lines: string[] = [];
  if (result.skipped.length > 0) {
    lines.push(`${result.skipped.length} document(s) not indexed:`);
    for (const s of result.skipped) lines.push(`  ${s.path}: ${s.reason}`);
  }
  if (result.invalidFrontmatter.length > 0) {
    lines.push(
      `${result.invalidFrontmatter.length} document(s) indexed with invalid frontmatter ` +
        `(values coerced; the markdown file is the source of truth — run vault_lint to repair):`,
    );
    for (const s of result.invalidFrontmatter) lines.push(`  ${s.path}: ${s.reason}`);
  }
  return lines;
}

interface StagedDocument {
  doc: IndexedDocument;
  chunks: string[];
  hashes: string[];
}

// The result of staging one file: either a document ready to index (carrying
// an `invalidReason` when its frontmatter failed schema validation but was
// coerced for the index), or a reason it could not be indexed at all. Skipping
// (rather than aborting) keeps one bad file from sinking the whole rebuild;
// carrying reasons keeps both buckets visible to the caller.
type StageOutcome =
  | { kind: "staged"; staged: StagedDocument; invalidReason: string | null }
  | { kind: "skipped"; reason: string };

// Reads and parses a single markdown file into the shape the index needs.
// A file that cannot be read or whose YAML is malformed is "skipped" (not
// indexed). A file that parses but has schema-invalid frontmatter is still
// staged for indexing — validation is advisory (a read of such a file
// succeeds; the source of truth is the markdown) — but its `invalidReason` is
// returned so the coercion the index applies is reported rather than silent.
async function stageOne(vaultRoot: string, relPath: string): Promise<StageOutcome> {
  const resolved = resolveVaultPath(vaultRoot, relPath);
  if (!resolved.ok)
    return { kind: "skipped", reason: `path could not be resolved: ${resolved.error.message}` };
  const file = await readFile(resolved.value.absPath);
  if (!file.ok) return { kind: "skipped", reason: `file could not be read: ${file.error.message}` };
  const parsed = parseDocument(file.value);
  if (!parsed.ok) return { kind: "skipped", reason: parsed.error.message };

  // Frontmatter that parses (valid YAML) but violates the schema — e.g. an
  // unknown enum value. validateFrontmatter *coerces* such fields to their
  // fallbacks, so the index row can differ from what the file declares. We
  // still index it (advisory, never hide content — same posture as vault_read),
  // but surface the issues so the divergence isn't silent. vault_lint is the
  // repair path; vault_write rejects the same frontmatter at the write boundary.
  let invalidReason: string | null = null;
  if (!parsed.value.validation.valid) {
    const summary = parsed.value.validation.issues
      .map((issue) => `${issue.field} (${issue.message})`)
      .join("; ");
    invalidReason = `invalid frontmatter: ${summary}`;
  }

  const fm = parsed.value.frontmatter;
  const body = parsed.value.content;
  // BM25 indexes title, tags, and body together so a title- or tag-only
  // match still ranks.
  const tokens = tokenize(`${fm.title} ${fm.tags.join(" ")} ${body}`);

  const chunks = chunkText(body);
  const hashes = chunks.map((t) => sha256Hex(t));

  return {
    kind: "staged",
    invalidReason,
    staged: {
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
    },
  };
}

// Reads and parses every markdown file into the shape the index needs. A file
// that stageOne rejects is skipped (recorded in `skipped`) rather than
// aborting the whole rebuild.
async function stageDocuments(vaultRoot: string): Promise<
  Result<
    {
      staged: StagedDocument[];
      skipped: FlaggedDocument[];
      invalidFrontmatter: FlaggedDocument[];
    },
    Error
  >
> {
  const list = await listFiles(vaultRoot);
  if (!list.ok) return list;

  const staged: StagedDocument[] = [];
  const skipped: FlaggedDocument[] = [];
  const invalidFrontmatter: FlaggedDocument[] = [];

  for (const relPath of list.value) {
    const one = await stageOne(vaultRoot, relPath);
    if (one.kind === "skipped") {
      skipped.push({ path: relPath, reason: one.reason });
      continue;
    }
    staged.push(one.staged);
    if (one.invalidReason) invalidFrontmatter.push({ path: relPath, reason: one.invalidReason });
  }

  return ok({ staged, skipped, invalidFrontmatter });
}

// Inserts the chunk rows in a single transaction. Embeddings are persisted by
// the caller (with a model identifier) so the chunk write stays oblivious to
// which model produced the vectors.
function writeChunkRows(db: IndexDb, staged: StagedDocument[]): number {
  let chunkCount = 0;
  // Link resolution runs against the FULL staged path set, built up front —
  // insertion order can never drop an edge whose target lands later (#8).
  const linkIndexes = buildPathIndexes(staged.map(({ doc }) => ({ path: doc.path })));
  const write = db.transaction(() => {
    clearIndex(db);
    for (const { doc, chunks, hashes } of staged) {
      insertDocument(db, doc);
      replaceDocLinks(db, doc.path, outgoingLinkTargets(doc.content, doc.path, linkIndexes));
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
  const { staged, skipped, invalidFrontmatter } = staging.value;

  // Open the index first so we can ask the embeddings cache which (hash,
  // model) pairs already exist before deciding what to embed. Pass the
  // active provider's dim so the sqlite-vec mirror is sized correctly
  // (rebuilt if a previous reindex used a different provider).
  const dbResult = openIndexForActiveProvider(vaultRoot);
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
    let committedEmbeds = 0;
    if (missTexts.length > 0) {
      const batchSize = opts.embedCommitBatch ?? EMBED_COMMIT_BATCH;
      for (let start = 0; start < missHashes.length; start += batchSize) {
        const sliceHashes = missHashes.slice(start, start + batchSize);
        const sliceTexts = missTexts.slice(start, start + batchSize);
        const embedResult = await embed(
          sliceTexts,
          opts.onProgress
            ? (done, _total) => opts.onProgress?.(committedEmbeds + done, missHashes.length)
            : undefined,
        );
        if (!embedResult.ok) {
          // Model unavailable (or died mid-build). Batches already committed
          // stay in the cache — the next build resumes past them. Documents
          // + chunk rows still land below so BM25 works; vector ranking
          // degrades to nothing for this reindex.
          vectorEnabled = false;
          break;
        }
        const writeEmbeds = db.transaction(() => {
          for (let i = 0; i < sliceHashes.length; i++) {
            const h = sliceHashes[i] ?? "";
            const vec = embedResult.value[i];
            if (!vec) continue;
            insertEmbedding(db, h, provider.id, vec, indexedAt, provider.dim);
          }
        });
        writeEmbeds();
        committedEmbeds += sliceHashes.length;
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

    // Rebuild the staged-actions index from its canonical jsonl. Like every
    // table here it is a derived cache of an on-disk source of truth; this
    // keeps it in sync after a cold start or a manual index wipe. Best-effort:
    // the staging queue lives in the jsonl, so a rebuild miss never loses data.
    rebuildStagedActionsIndex(db, vaultRoot);

    // Same posture for the derives_from edge store: the jsonl is canonical;
    // this table is the loop's concurrent-read surface (spec §11.3).
    rebuildEdgesIndex(db, vaultRoot);

    // Rebuild the sqlite-vec mirror from the durable `embeddings` cache.
    // The cache is per-(model, content_hash) and is the source of truth;
    // the mirror is a SQL-queryable index of it. We rebuild rather than
    // diff because (a) it's small (one row per active-model chunk) and
    // (b) a vec-table rebuild on provider switch lands here with an empty
    // table, so we need a full repopulation anyway.
    rebuildEmbeddingsVec(db, provider.id);

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
      invalidFrontmatter,
      indexedAt,
      // COMMITTED count, not attempted: an interrupted build reports what it
      // actually banked (#54).
      embeddedCount: committedEmbeds,
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
  // Non-null when the indexed document's frontmatter failed schema validation
  // (values were coerced for the index). The reactive watcher logs this so an
  // out-of-band write of an invalid file is surfaced, not silently coerced —
  // the same guarantee the full-reindex `invalidFrontmatter` bucket gives.
  invalidFrontmatter: string | null;
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
  // Open the index once and keep this handle for both the empty-check and the
  // incremental write. The previous code opened, checked the count, closed,
  // then reopened — paying the sqlite-vec extension load and 1-vector ABI
  // smoke-test twice per write (finding E5). If the index turns out to be
  // empty we close this handle and delegate to reindexVault, which manages
  // its own connection.
  const dbResult = openIndexForActiveProvider(vaultRoot);
  if (!dbResult.ok) return dbResult;
  const db = dbResult.value;

  if (documentCount(db) === 0) {
    db.close();
    const full = await reindexVault(vaultRoot);
    if (!full.ok) return full;
    return ok({
      chunkCount: full.value.chunkCount,
      vectorEnabled: full.value.vectorEnabled,
      invalidFrontmatter:
        full.value.invalidFrontmatter.find((f) => f.path === relPath)?.reason ?? null,
    });
  }

  const outcome = await stageOne(vaultRoot, relPath);
  if (outcome.kind !== "staged") {
    db.close();
    return err(new Error(`cannot index document: ${relPath} (${outcome.reason})`));
  }
  const { doc, chunks, hashes } = outcome.staged;

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
    const newlyEmbedded: Array<{ hash: string; vec: Float32Array }> = [];
    if (missTexts.length > 0) {
      const embedResult = await embed(missTexts);
      if (embedResult.ok) {
        const writeEmbeds = db.transaction(() => {
          for (let i = 0; i < missHashes.length; i++) {
            const h = missHashes[i] ?? "";
            const vec = embedResult.value[i];
            if (!vec) continue;
            insertEmbedding(db, h, provider.id, vec, createdAt, provider.dim);
            newlyEmbedded.push({ hash: h, vec });
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
      // Refresh this doc's OUTGOING links against the indexed path universe.
      // Inbound edges to it update as their sources are re-indexed — a doc
      // created after a bare-name link to it was indexed stays unlinked until
      // the linker's next write or a full reindex (accepted
      // reindex-granularity staleness, #8).
      replaceDocLinks(
        db,
        doc.path,
        outgoingLinkTargets(
          doc.content,
          doc.path,
          buildPathIndexes(allDocumentPaths(db).map((p) => ({ path: p }))),
        ),
      );
      chunks.forEach((text, chunkIndex) => {
        insertChunkRow(db, {
          path: doc.path,
          chunkIndex,
          text,
          contentHash: hashes[chunkIndex] ?? "",
        });
      });
      // Mirror only the newly-embedded vectors into `embeddings_vec`.
      // Hashes that were already cached are already in the vec table from
      // a prior reindex / indexDocument call — re-inserting them would be
      // duplicates. INSERT OR IGNORE isn't supported on vec0 virtual
      // tables, so we keep this list to just the new vectors.
      for (const { hash, vec } of newlyEmbedded) {
        insertEmbeddingVec(db, hash, provider.id, vec);
      }
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
          const st = await stat(resolved.value.absPath);
          stored[relPath] = st.mtimeMs;
          writeManifest(db, stored);
        } catch {
          // ignore — manifest just stays stale for this entry; worst case is
          // one extra reindex on next startup.
        }
      }
    }
    return ok({
      chunkCount: chunks.length,
      vectorEnabled,
      invalidFrontmatter: outcome.invalidReason,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`index update failed: ${reason}`));
  } finally {
    db.close();
  }
}
