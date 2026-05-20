import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexDocument, isIndexFresh, reindexVault } from "../../src/search/reindex.js";
import {
  getAllChunks,
  getAllDocuments,
  getDocument,
  getMeta,
  openIndexDb,
} from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

describe("reindexVault", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("indexes every vault document and its chunks", async () => {
    const result = await reindexVault(vault);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.documentCount).toBe(10);
    expect(result.value.chunkCount).toBeGreaterThanOrEqual(10);
    expect(result.value.skipped).toEqual([]);
    expect(result.value.vectorEnabled).toBe(true);

    const opened = openIndexDb(vault);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const db = opened.value;
    try {
      expect(getAllDocuments(db)).toHaveLength(10);
      const chunks = getAllChunks(db);
      expect(chunks.every((c) => c.embedding !== null)).toBe(true);
      expect(getMeta(db, "vector_enabled")).toBe("true");
      expect(getMeta(db, "indexed_at")).not.toBeNull();
    } finally {
      db.close();
    }
  }, 60_000);

  it("is idempotent: a second reindex yields the same counts", async () => {
    const first = await reindexVault(vault);
    const second = await reindexVault(vault);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.documentCount).toBe(first.value.documentCount);
    expect(second.value.chunkCount).toBe(first.value.chunkCount);
  }, 60_000);

  it("reports embedding progress through the onProgress callback", async () => {
    const calls: Array<[number, number]> = [];
    const result = await reindexVault(vault, {
      onProgress: (done, total) => calls.push([done, total]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Progress fires during embedding, every call carries the vault's full
    // chunk count as the total, `done` advances strictly, and the last call
    // reports completion.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([, total]) => total === result.value.chunkCount)).toBe(true);
    expect(calls.every(([done], i) => i === 0 || done > (calls[i - 1]?.[0] ?? 0))).toBe(true);
    expect(calls[calls.length - 1]?.[0]).toBe(result.value.chunkCount);
  }, 60_000);

  it("reports fresh after a reindex and stale once a file is touched", async () => {
    const first = await reindexVault(vault);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(await isIndexFresh(vault)).toBe(true);

    // Touch an existing file so its mtime moves forward past the manifest.
    const sample = join(vault, "competitive-intel/northwind-data-governance.md");
    const future = new Date(Date.now() + 5_000);
    await utimes(sample, future, future);

    expect(await isIndexFresh(vault)).toBe(false);
  }, 60_000);

  it("reports stale when a new file appears in the vault", async () => {
    const first = await reindexVault(vault);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await isIndexFresh(vault)).toBe(true);

    // A new file with no manifest entry must invalidate freshness, otherwise
    // the search index never learns about content added out-of-band.
    await writeFile(
      join(vault, "competitive-intel/new-doc.md"),
      "---\ntitle: New Doc\n---\n\nBody.\n",
    );

    expect(await isIndexFresh(vault)).toBe(false);
  }, 60_000);

  it("reports stale when the index has never been built", async () => {
    expect(await isIndexFresh(vault)).toBe(false);
  });

  it("incremental indexDocument keeps the freshness manifest in sync", async () => {
    const first = await reindexVault(vault);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await isIndexFresh(vault)).toBe(true);

    // Rewriting a file moves its mtime; the incremental indexer must update
    // the manifest entry or the very next restart would re-embed the vault.
    const target = "competitive-intel/northwind-data-governance.md";
    const future = new Date(Date.now() + 5_000);
    await utimes(join(vault, target), future, future);
    expect(await isIndexFresh(vault)).toBe(false);

    const updated = await indexDocument(vault, target);
    expect(updated.ok).toBe(true);

    expect(await isIndexFresh(vault)).toBe(true);
  }, 60_000);

  it("populates ttlDays, created, and supersededBy from frontmatter after reindex", async () => {
    const result = await reindexVault(vault);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const opened = openIndexDb(vault);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const db = opened.value;
    try {
      // competitive-intel/northwind-data-governance.md has:
      //   ttl_days: 120, created: 2026-03-10, superseded_by: null
      const doc = getDocument(db, "competitive-intel/northwind-data-governance.md");
      expect(doc).not.toBeNull();
      if (!doc) return;
      expect(doc.ttlDays).toBe(120);
      expect(doc.created).toBe("2026-03-10");
      expect(doc.supersededBy).toBeNull();
    } finally {
      db.close();
    }
  }, 60_000);
});
