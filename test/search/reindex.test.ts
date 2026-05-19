import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reindexVault } from "../../src/search/reindex.js";
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
