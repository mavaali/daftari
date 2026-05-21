// SQL-native search integration tests (#38, PR 5 of 5).
//
// Covers the contract the FTS5 + sqlite-vec rewrite is responsible for:
//   - reindex populates both virtual tables
//   - FTS5 MATCH ranking surfaces lexical hits
//   - FTS5 prefix matches partial-token queries
//   - sqlite-vec mirror is queryable end-to-end via hybridSearch
//   - a provider switch with a different dim rebuilds embeddings_vec
//   - extension-loading failure surfaces a clear, actionable error
//
// These tests live alongside the existing hybrid.test.ts which exercises
// the higher-level hybridSearch path on a real vault; here we drill into
// the SQL primitives one layer down.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type Result } from "../../src/frontmatter/types.js";
import type { EmbeddingProvider } from "../../src/search/embedding-provider.js";
import { hybridSearch } from "../../src/search/hybrid.js";
import { localMinilmProvider } from "../../src/search/providers/local-minilm.js";
import { reindexVault } from "../../src/search/reindex.js";
import {
  EMBEDDING_DIM,
  resetProviderForTests,
  setProviderForTests,
} from "../../src/search/vector.js";
import { embeddingCount, getMeta, openIndexDb } from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

describe("reindex populates both virtual tables", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("populates documents_fts and embeddings_vec to match the regular tables", async () => {
    const result = await reindexVault(vault);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const opened = openIndexDb(vault, EMBEDDING_DIM);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const db = opened.value;
    try {
      const docs = (db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
      // Contentless FTS5 tables can't be SELECT COUNT(*)'d directly
      // (the engine would try to read content from the linked table),
      // but FTS5's internal `_docsize` shadow table holds one row per
      // indexed document — that's the canonical "how many docs are in
      // the FTS index" count.
      const fts = (
        db.prepare("SELECT COUNT(*) AS n FROM documents_fts_docsize").get() as { n: number }
      ).n;
      // documents_fts is a contentless mirror — every row in `documents`
      // must show up via FTS5, and vice versa.
      expect(fts).toBe(docs);

      const embeddings = embeddingCount(db);
      const vec = (
        db.prepare("SELECT COUNT(*) AS n FROM embeddings_vec").get() as {
          n: number;
        }
      ).n;
      expect(vec).toBe(embeddings);
    } finally {
      db.close();
    }
  }, 60_000);

  it("FTS5 prefix-match query is reachable via the documents_fts virtual table", async () => {
    const result = await reindexVault(vault);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const opened = openIndexDb(vault, EMBEDDING_DIM);
    if (!opened.ok) throw opened.error;
    const db = opened.value;
    try {
      // The fixture vault contains 'cirrus' in several documents. A prefix
      // match on 'cirr*' must surface them via FTS5 directly.
      const rows = db
        .prepare(
          "SELECT d.path AS path FROM documents_fts JOIN documents AS d ON d.rowid = documents_fts.rowid WHERE documents_fts MATCH ?",
        )
        .all("cirr*") as { path: string }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((r) => r.path.includes("cirrus"))).toBe(true);
    } finally {
      db.close();
    }
  }, 60_000);

  it("hybrid search uses FTS5 + sqlite-vec and surfaces a sensible top hit", async () => {
    const result = await reindexVault(vault);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const opened = openIndexDb(vault, EMBEDDING_DIM);
    if (!opened.ok) throw opened.error;
    const db = opened.value;
    try {
      const search = await hybridSearch(db, "cirrus pooled capacity tier");
      expect(search.ok).toBe(true);
      if (!search.ok) return;
      expect(search.value.vectorUsed).toBe(true);
      expect(search.value.hits[0]?.path).toContain("cirrus");
    } finally {
      db.close();
    }
  }, 60_000);
});

describe("provider switch rebuilds embeddings_vec at the new dim", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    resetProviderForTests();
    cleanupVault(vault);
  });

  it("switching to a different-dim provider drops and recreates the vec table; the embeddings cache survives", async () => {
    // First reindex under local-minilm (384 dim). embeddings_vec is sized
    // accordingly.
    const first = await reindexVault(vault);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    {
      const opened = openIndexDb(vault, 384);
      if (!opened.ok) throw opened.error;
      try {
        expect(getMeta(opened.value, "embeddings_vec_dim")).toBe("384");
      } finally {
        opened.value.close();
      }
    }

    // Now flip to a fake provider at a different dim. We don't actually
    // need to run an embed pass; opening the index with the new dim is
    // enough to trigger the rebuild.
    const fakeProvider: EmbeddingProvider = {
      id: "fake-1024",
      dim: 1024,
      async warm(): Promise<Result<void, Error>> {
        return ok(undefined);
      },
      async embed(): Promise<Result<Float32Array[], Error>> {
        return ok([]);
      },
    };
    setProviderForTests(fakeProvider);

    const opened = openIndexDb(vault, 1024);
    if (!opened.ok) throw opened.error;
    const db = opened.value;
    try {
      expect(getMeta(db, "embeddings_vec_dim")).toBe("1024");
      // embeddings_vec was dropped and recreated empty.
      const vecCount = (
        db.prepare("SELECT COUNT(*) AS n FROM embeddings_vec").get() as {
          n: number;
        }
      ).n;
      expect(vecCount).toBe(0);
      // The durable embeddings cache survived — the previous reindex's
      // local-minilm rows are still there.
      const cached = embeddingCount(db);
      expect(cached).toBeGreaterThan(0);
      const localCount = (
        db.prepare("SELECT COUNT(*) AS n FROM embeddings WHERE model = ?").get("local-minilm") as {
          n: number;
        }
      ).n;
      expect(localCount).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  }, 60_000);

  it("a wrapper provider with the SAME dim re-uses the existing vec table without dropping it", async () => {
    // Reindex with default local-minilm (384 dim) — populates embeddings_vec.
    const first = await reindexVault(vault);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    let vecBefore = 0;
    {
      const opened = openIndexDb(vault, 384);
      if (!opened.ok) throw opened.error;
      try {
        vecBefore = (
          opened.value.prepare("SELECT COUNT(*) AS n FROM embeddings_vec").get() as { n: number }
        ).n;
      } finally {
        opened.value.close();
      }
    }
    expect(vecBefore).toBeGreaterThan(0);

    // Swap to a wrapper at the same dim; the vec table should be left intact.
    const altProvider: EmbeddingProvider = {
      id: "alt-minilm",
      dim: localMinilmProvider.dim,
      async warm(): Promise<Result<void, Error>> {
        return ok(undefined);
      },
      embed: localMinilmProvider.embed.bind(localMinilmProvider),
    };
    setProviderForTests(altProvider);

    const opened = openIndexDb(vault, altProvider.dim);
    if (!opened.ok) throw opened.error;
    try {
      const vecAfter = (
        opened.value.prepare("SELECT COUNT(*) AS n FROM embeddings_vec").get() as { n: number }
      ).n;
      // Same dim => the persisted vec table was kept — every row that was
      // there before this open is still there.
      expect(vecAfter).toBe(vecBefore);
    } finally {
      opened.value.close();
    }
  }, 60_000);
});

describe("extension loading guard", () => {
  it("surfaces a clear, actionable error when sqlite-vec cannot load", async () => {
    // Stub the sqlite-vec module so `load()` throws — simulating the
    // failure mode where better-sqlite3 was built without extension
    // loading. openIndexDb must turn this into a Result.err with the
    // documented rebuild instructions, not crash with a stack trace.
    vi.resetModules();
    vi.doMock("sqlite-vec", () => ({
      load: () => {
        throw new Error("extension loading disabled");
      },
      getLoadablePath: () => "/nonexistent/path",
    }));

    // Dynamic import after the mock is installed so the storage module
    // picks up the stubbed sqlite-vec.
    const { openIndexDb: scopedOpen } = await import("../../src/storage/index-db.js?reload");

    const tmpVault = mkdtempSync(join(tmpdir(), "daftari-vec-fail-"));
    try {
      const result = scopedOpen(tmpVault, 384);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // The error must mention the rebuild guidance — that's the
      // operator-facing actionable next step.
      expect(result.error.message).toContain("sqlite-vec");
      expect(result.error.message).toContain("npm rebuild better-sqlite3");
    } finally {
      rmSync(tmpVault, { recursive: true, force: true });
      vi.doUnmock("sqlite-vec");
      vi.resetModules();
    }
  });
});
