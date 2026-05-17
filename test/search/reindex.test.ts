import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reindexVault } from "../../src/search/reindex.js";
import {
  getAllChunks,
  getAllDocuments,
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

  it(
    "indexes every vault document and its chunks",
    async () => {
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
    },
    60_000,
  );

  it(
    "is idempotent: a second reindex yields the same counts",
    async () => {
      const first = await reindexVault(vault);
      const second = await reindexVault(vault);
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.value.documentCount).toBe(first.value.documentCount);
      expect(second.value.chunkCount).toBe(first.value.chunkCount);
    },
    60_000,
  );
});
