import { readFile, rename, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok, type Result } from "../../src/frontmatter/types.js";
import type { EmbeddingProvider } from "../../src/search/embedding-provider.js";
import { LOCAL_MINILM_DIM, localMinilmProvider } from "../../src/search/providers/local-minilm.js";
import {
  indexDocument,
  isIndexFresh,
  type ReindexResult,
  reindexVault,
  reindexWarnings,
} from "../../src/search/reindex.js";
import {
  EMBEDDING_MODEL,
  resetProviderForTests,
  setProviderForTests,
} from "../../src/search/vector.js";
import {
  embeddingCount,
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

    const opened = openIndexDb(vault, LOCAL_MINILM_DIM, "float32");
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const db = opened.value;
    try {
      expect(getAllDocuments(db)).toHaveLength(10);
      const chunks = getAllChunks(db, EMBEDDING_MODEL);
      expect(chunks.every((c) => c.embedding !== null)).toBe(true);
      expect(getMeta(db, "vector_enabled")).toBe("true");
      expect(getMeta(db, "indexed_at")).not.toBeNull();
    } finally {
      db.close();
    }
  }, 60_000);

  it("reports a doc with invalid frontmatter instead of coercing it silently", async () => {
    // An agent writer (e.g. session-distillery) writes a file DIRECTLY to disk,
    // bypassing vault_write's validation gate. `domain: tooling` and
    // `confidence: EXPLICIT` are not valid enum values — validateFrontmatter
    // coerces them to `accumulation`/`low` for the index. Per daftari's
    // advisory model the doc stays indexed and searchable (the markdown file
    // is the source of truth), but the divergence must be SURFACED at reindex,
    // not swallowed: that silent coercion was the bug.
    const badPath = "competitive-intel/agent-written-bad.md";
    await writeFile(
      join(vault, badPath),
      "---\ntitle: Agent Written\ndomain: tooling\nstatus: draft\n" +
        "confidence: EXPLICIT\nupdated: 2026-05-20\ntags: []\n---\n\n" +
        "Body with real content an agent distilled.\n",
    );

    const result = await reindexVault(vault);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Reported in invalidFrontmatter, with a reason naming the offending fields.
    const entry = result.value.invalidFrontmatter.find((s) => s.path === badPath);
    expect(entry).toBeDefined();
    expect(entry?.reason).toMatch(/domain/);
    expect(entry?.reason).toMatch(/confidence/);

    // It is NOT treated as unindexable — `skipped` is for unreadable / malformed
    // files, not advisory schema issues.
    expect(result.value.skipped.map((s) => s.path)).not.toContain(badPath);

    // Still indexed and searchable — advisory, not rejected (matches the
    // _drafts/incomplete-note.md fixture's documented intent).
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM, "float32");
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const db = opened.value;
    try {
      expect(getDocument(db, badPath)).not.toBeNull();
    } finally {
      db.close();
    }

    // The source-of-truth file on disk is untouched — the bad value is not
    // silently rewritten.
    const onDisk = await readFile(join(vault, badPath), "utf-8");
    expect(onDisk).toMatch(/confidence: EXPLICIT/);
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

    // Progress fires during embedding, every call carries the same total
    // (the number of cache misses being embedded — on a cold reindex of a
    // fresh vault that equals embeddedCount), `done` advances strictly, and
    // the last call reports completion.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([, total]) => total === result.value.embeddedCount)).toBe(true);
    expect(calls.every(([done], i) => i === 0 || done > (calls[i - 1]?.[0] ?? 0))).toBe(true);
    expect(calls[calls.length - 1]?.[0]).toBe(result.value.embeddedCount);
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

    const opened = openIndexDb(vault, LOCAL_MINILM_DIM, "float32");
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

  describe("content-addressed embedding cache", () => {
    it("cache hit on unchanged content: a second reindex embeds zero new chunks", async () => {
      const first = await reindexVault(vault);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.embeddedCount).toBeGreaterThan(0);
      expect(first.value.cacheHits).toBe(0);

      const second = await reindexVault(vault);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      // No file changed → every chunk hashes to a cached row → zero embeds.
      expect(second.value.embeddedCount).toBe(0);
      expect(second.value.cacheHits).toBe(second.value.chunkCount);
      // Orphans are zero too: clearIndex preserved the cache and every row
      // still has a referencing chunk after the rewrite.
      expect(second.value.orphansRemoved).toBe(0);
    }, 120_000);

    it("edit re-embeds only the changed chunks; the rest are cache hits", async () => {
      const first = await reindexVault(vault);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const initialEmbeds = first.value.embeddedCount;

      // Change the body of one file by appending a fresh paragraph. The
      // unchanged paragraphs still hash to cached rows; only the new
      // chunk(s) need embedding.
      const target = join(vault, "pricing/cirrus-capacity-tiers.md");
      const original = await readFile(target, "utf-8");
      const edited = `${original}\n\nThis is a new paragraph that did not previously exist anywhere in the vault and so its sha256 is uncached.\n`;
      await writeFile(target, edited);

      const second = await reindexVault(vault);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      // Strictly fewer embeds than the cold reindex.
      expect(second.value.embeddedCount).toBeLessThan(initialEmbeds);
      // And strictly less than the whole vault — most chunks still cached.
      expect(second.value.embeddedCount).toBeLessThan(second.value.chunkCount);
      expect(second.value.cacheHits).toBeGreaterThan(0);
    }, 120_000);

    it("rename re-embeds zero: content hashes do not depend on path", async () => {
      const first = await reindexVault(vault);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const cacheSizeBefore = (() => {
        const opened = openIndexDb(vault, LOCAL_MINILM_DIM, "float32");
        if (!opened.ok) throw opened.error;
        try {
          return embeddingCount(opened.value);
        } finally {
          opened.value.close();
        }
      })();

      // Move a file to a new path inside the same collection. Body unchanged.
      const from = join(vault, "competitive-intel/cirrus-realtime-early-read.md");
      const to = join(vault, "competitive-intel/cirrus-realtime-renamed.md");
      await rename(from, to);

      const second = await reindexVault(vault);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.embeddedCount).toBe(0);
      // Cache size unchanged — every old hash is still referenced (by the
      // renamed file) so no orphans were reaped.
      const cacheSizeAfter = (() => {
        const opened = openIndexDb(vault, LOCAL_MINILM_DIM, "float32");
        if (!opened.ok) throw opened.error;
        try {
          return embeddingCount(opened.value);
        } finally {
          opened.value.close();
        }
      })();
      expect(cacheSizeAfter).toBe(cacheSizeBefore);
    }, 120_000);

    // Contextual chunking (spec 2026-07-26-contextual-chunking-reranker-design.md
    // Decision 2 / plan C7): the chunk hash covers the breadcrumb context
    // (collection > title > headings > tags) AS WELL AS the body text — the
    // context is part of the chunk's retrieval identity now, not a
    // pre-contextual-chunking cache key of text alone. So identical body text
    // is a cache hit ONLY when the surrounding metadata (title/collection/tags)
    // also matches; a differently-titled document with the same paragraph is
    // an intentional cache MISS (a stale-vector hit would silently serve
    // pre-edit semantics, which the spec judges worse than the recompute).
    it("identical body text under IDENTICAL title/collection/tags shares one embedding row (same-pass dedupe)", async () => {
      const first = await reindexVault(vault);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const uniqueParagraph =
        "orthogonal quokka fandango cache-identity probe text that appears nowhere else.";
      const frontmatter =
        "---\ntitle: Twin Doc\ndomain: positioning\nstatus: draft\nconfidence: low\n" +
        "updated: 2026-05-20\ntags: [probe]\n---\n\n";
      await writeFile(
        join(vault, "competitive-intel/twin-a.md"),
        `${frontmatter}${uniqueParagraph}\n`,
      );
      await writeFile(
        join(vault, "competitive-intel/twin-b.md"),
        `${frontmatter}${uniqueParagraph}\n`,
      );

      const second = await reindexVault(vault);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      // Both new files hash identically (same context AND same text) — the
      // in-pass miss-dedupe (missTextByHash) embeds the shared hash exactly
      // once, not twice.
      expect(second.value.embeddedCount).toBe(1);
      expect(second.value.documentCount).toBe(first.value.documentCount + 2);
    }, 120_000);

    it("identical body text under DIFFERENT titles produces two embedding rows, not a cache hit (C7)", async () => {
      const first = await reindexVault(vault);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const uniqueParagraph =
        "cerulean marmoset syzygy cache-identity probe text that appears nowhere else.";
      const frontmatterFor = (title: string): string =>
        `---\ntitle: ${title}\ndomain: positioning\nstatus: draft\nconfidence: low\n` +
        "updated: 2026-05-20\ntags: [probe]\n---\n\n";
      await writeFile(
        join(vault, "competitive-intel/distinct-a.md"),
        `${frontmatterFor("Distinct Title A")}${uniqueParagraph}\n`,
      );
      await writeFile(
        join(vault, "competitive-intel/distinct-b.md"),
        `${frontmatterFor("Distinct Title B")}${uniqueParagraph}\n`,
      );

      const second = await reindexVault(vault);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      // Same body text, different titles => different breadcrumb context =>
      // different content_hash => NOT deduped. Two embedding rows, not one.
      expect(second.value.embeddedCount).toBe(2);
      expect(second.value.documentCount).toBe(first.value.documentCount + 2);
    }, 120_000);

    it("vault_gc reaps embeddings whose chunks no longer reference them", async () => {
      const first = await reindexVault(vault);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const cacheBefore = (() => {
        const opened = openIndexDb(vault, LOCAL_MINILM_DIM, "float32");
        if (!opened.ok) throw opened.error;
        try {
          return embeddingCount(opened.value);
        } finally {
          opened.value.close();
        }
      })();
      expect(cacheBefore).toBeGreaterThan(0);

      // Rewrite a file with completely fresh text so its OLD chunks become
      // orphans in the embeddings cache. The new chunks add new rows; the
      // gc pass should remove the orphan rows the file used to reference.
      const target = join(vault, "pricing/cirrus-capacity-tiers.md");
      await writeFile(
        target,
        "---\ntitle: Cirrus Capacity Tiers\ndomain: pricing\nstatus: draft\nconfidence: low\nupdated: 2026-05-20\ntags: []\n---\n\nentirely new prose that shares no chunk with the prior version of this file.\n",
      );

      const second = await reindexVault(vault);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.orphansRemoved).toBeGreaterThan(0);

      // After the reindex, every surviving embeddings row must be referenced
      // by at least one chunk row.
      const opened = openIndexDb(vault, LOCAL_MINILM_DIM, "float32");
      if (!opened.ok) throw opened.error;
      const db = opened.value;
      try {
        const orphanCount = db
          .prepare(
            "SELECT COUNT(*) AS n FROM embeddings WHERE content_hash NOT IN (SELECT content_hash FROM chunks)",
          )
          .get() as { n: number };
        expect(orphanCount.n).toBe(0);
        // The sqlite-vec mirror is also reaped: no `embeddings_vec` row
        // references a content_hash that has no chunk row. (Direct
        // correlated subqueries on vec0 columns are awkward, so we count
        // via a LEFT JOIN sanity check.)
        const vecOrphans = db
          .prepare(
            "SELECT COUNT(*) AS n FROM embeddings_vec v LEFT JOIN chunks c ON c.content_hash = v.content_hash WHERE c.content_hash IS NULL",
          )
          .get() as { n: number };
        expect(vecOrphans.n).toBe(0);
      } finally {
        db.close();
      }
    }, 120_000);
  });

  // Hermetic: reindexWarnings is a pure formatter over a ReindexResult, so it
  // needs no vault and no model. It is the surface that makes skipped /
  // invalid-frontmatter docs visible instead of silent.
  describe("reindexWarnings", () => {
    const base: ReindexResult = {
      documentCount: 1,
      chunkCount: 1,
      vectorEnabled: true,
      skipped: [],
      invalidFrontmatter: [],
      indexedAt: "2026-06-20T00:00:00.000Z",
      embeddedCount: 0,
      cacheHits: 1,
      orphansRemoved: 0,
    };

    it("returns no lines when nothing was skipped or flagged", () => {
      expect(reindexWarnings(base)).toEqual([]);
    });

    it("reports invalid-frontmatter docs with their reason and a repair hint", () => {
      const lines = reindexWarnings({
        ...base,
        invalidFrontmatter: [{ path: "a/bad.md", reason: "invalid frontmatter: domain (…)" }],
      });
      expect(lines.some((l) => /invalid frontmatter/.test(l) && /vault_lint/.test(l))).toBe(true);
      expect(lines).toContain("  a/bad.md: invalid frontmatter: domain (…)");
    });

    it("reports skipped (unindexable) docs separately from flagged ones", () => {
      const lines = reindexWarnings({
        ...base,
        skipped: [{ path: "b/broken.md", reason: "malformed YAML frontmatter: bad indent" }],
      });
      expect(lines.some((l) => /not indexed/.test(l))).toBe(true);
      expect(lines).toContain("  b/broken.md: malformed YAML frontmatter: bad indent");
    });
  });

  // Provider switch: when the active provider's `id` changes between two
  // reindexes, the second reindex sees zero cache hits for the new id and
  // re-embeds the whole vault under it. This is the "natural" behaviour
  // claimed by the design — the composite (content_hash, model) PK scopes
  // the cache lookup to the active provider's id. We exercise it with a
  // wrapper around local-minilm (different `id`, same embedder) so the test
  // doesn't pay the cost of two real model loads or hit the network.
  describe("provider switch", () => {
    afterEach(() => {
      // Always restore the default provider so the next test starts clean.
      resetProviderForTests();
    });

    it("a provider switch invalidates the cache for the new id and re-embeds everything", async () => {
      // First reindex under the default local-minilm provider. This loads
      // the model once and populates rows under model='local-minilm'.
      const first = await reindexVault(vault);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.embeddedCount).toBeGreaterThan(0);
      expect(first.value.cacheHits).toBe(0);

      // Wrap local-minilm in a different id ("alt-minilm") to simulate a
      // provider switch. The vectors are identical (so cosine math stays
      // valid), but the cache lookup scopes by id — so every chunk is a
      // cache miss under the new id and re-embedding happens for all of them.
      const altProvider: EmbeddingProvider = {
        id: "alt-minilm",
        dim: localMinilmProvider.dim,
        async warm(): Promise<Result<void, Error>> {
          return ok(undefined);
        },
        embed: localMinilmProvider.embed.bind(localMinilmProvider),
      };
      setProviderForTests(altProvider);

      // Vec-coherence check (C1): a provider switch on an otherwise
      // unchanged vault must be detected as stale BEFORE the reindex that
      // fixes it — this is what makes "config change + background reindex"
      // an actually-triggered migration rather than a silent no-op.
      expect(await isIndexFresh(vault)).toBe(false);

      const second = await reindexVault(vault);
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      // Headline: the new id has no cached rows, so every chunk is a miss
      // and the second reindex embeds the whole vault again under it.
      expect(second.value.cacheHits).toBe(0);
      expect(second.value.embeddedCount).toBeGreaterThan(0);
      expect(second.value.embeddedCount).toBe(first.value.embeddedCount);

      // Both providers' rows coexist in the cache (the composite PK lets
      // them) — a switch-back to the original id would be all cache hits.
      const opened = openIndexDb(vault, LOCAL_MINILM_DIM, "float32");
      if (!opened.ok) throw opened.error;
      const db = opened.value;
      try {
        const localCount = db
          .prepare("SELECT COUNT(*) AS n FROM embeddings WHERE model = ?")
          .get("local-minilm") as { n: number };
        const altCount = db
          .prepare("SELECT COUNT(*) AS n FROM embeddings WHERE model = ?")
          .get("alt-minilm") as { n: number };
        expect(localCount.n).toBeGreaterThan(0);
        expect(altCount.n).toBeGreaterThan(0);
      } finally {
        db.close();
      }

      // The current provider's id is what gets written to meta.
      const dbMeta = openIndexDb(vault, LOCAL_MINILM_DIM, "float32");
      if (!dbMeta.ok) throw dbMeta.error;
      try {
        expect(getMeta(dbMeta.value, "embedding_model")).toBe("alt-minilm");
        expect(getMeta(dbMeta.value, "embedding_dim")).toBe(String(localMinilmProvider.dim));
      } finally {
        dbMeta.value.close();
      }
    }, 240_000);

    it("embeddings written under the active provider carry the provider's dim", async () => {
      // After a reindex under local-minilm (default), every embeddings row
      // must have dim = 384. This proves insertEmbedding is being called
      // with the provider's dim rather than a hard-coded constant.
      const result = await reindexVault(vault);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const opened = openIndexDb(vault, LOCAL_MINILM_DIM, "float32");
      if (!opened.ok) throw opened.error;
      const db = opened.value;
      try {
        const wrongDim = db
          .prepare("SELECT COUNT(*) AS n FROM embeddings WHERE dim != ?")
          .get(384) as { n: number };
        expect(wrongDim.n).toBe(0);
        // EMBEDDING_MODEL is the deprecated alias still pointing at the
        // local-minilm id; suppress the "import unused" lint hint via use.
        expect(EMBEDDING_MODEL).toBe("local-minilm");
      } finally {
        db.close();
      }
    }, 120_000);
  });

  // 2026-07-26 embedding-refresh-quantization spec, Phase 3d / dispositions
  // C1 (freshness coherence) and C9 (native-dim cache, dim-free id). A fake
  // Matryoshka-style provider — same cache id, varying `dim`/`nativeDim` —
  // keeps these tests fast and network-free instead of paying local-minilm's
  // real embed cost like the "provider switch" tests above.
  describe("dim / quantize coherence (C1, C9)", () => {
    const FAKE_ID = "fake-truncatable";
    const NATIVE_DIM = 8;

    function fakeVectorFor(text: string): Float32Array {
      const v = new Float32Array(NATIVE_DIM);
      for (let i = 0; i < NATIVE_DIM; i++) v[i] = ((text.charCodeAt(i % text.length) ?? 1) % 7) + 1;
      let norm = 0;
      for (const x of v) norm += x * x;
      const inv = 1 / Math.sqrt(norm);
      for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) * inv;
      return v;
    }

    function fakeTruncatableProvider(dim: number, counter: { calls: number }): EmbeddingProvider {
      return {
        id: FAKE_ID,
        dim,
        nativeDim: NATIVE_DIM,
        async warm(): Promise<Result<void, Error>> {
          return ok(undefined);
        },
        async embed(texts) {
          counter.calls += texts.length;
          return ok(texts.map((t) => fakeVectorFor(t)));
        },
      };
    }

    afterEach(() => {
      resetProviderForTests();
    });

    it("a dim flip on the same provider id is all cache hits — zero embed calls, mirror rebuilt truncated", async () => {
      const counter = { calls: 0 };
      setProviderForTests(fakeTruncatableProvider(NATIVE_DIM, counter), "float32");
      const first = await reindexVault(vault);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.embeddedCount).toBeGreaterThan(0);
      const embedsAtNativeDim = counter.calls;
      expect(embedsAtNativeDim).toBeGreaterThan(0);

      // Flip dim 8 -> 4 on the SAME provider id. isIndexFresh must catch
      // this (embeddings_vec gets drop-recreated at the new dim, emptying
      // it, under an unchanged model id — the case check (a) alone misses).
      counter.calls = 0;
      setProviderForTests(fakeTruncatableProvider(4, counter), "float32");
      expect(await isIndexFresh(vault)).toBe(false);

      const second = await reindexVault(vault);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.embeddedCount).toBe(0); // zero embed() calls — pure cache hits
      expect(second.value.cacheHits).toBeGreaterThan(0);
      expect(counter.calls).toBe(0); // the provider's own embed() was never invoked

      const opened = openIndexDb(vault, 4, "float32");
      if (!opened.ok) throw opened.error;
      try {
        expect(getMeta(opened.value, "embeddings_vec_dim")).toBe("4");
        const row = opened.value.prepare("SELECT embedding FROM embeddings_vec LIMIT 1").get() as
          | { embedding: Buffer }
          | undefined;
        expect(row).toBeDefined();
        expect(row?.embedding.byteLength).toBe(4 * 4); // 4 float32 components, truncated
        const vecCount = opened.value.prepare("SELECT COUNT(*) AS n FROM embeddings_vec").get() as {
          n: number;
        };
        expect(vecCount.n).toBeGreaterThan(0);
      } finally {
        opened.value.close();
      }

      // Switch back to dim 8 — also all cache hits.
      counter.calls = 0;
      setProviderForTests(fakeTruncatableProvider(NATIVE_DIM, counter), "float32");
      expect(await isIndexFresh(vault)).toBe(false);
      const third = await reindexVault(vault);
      expect(third.ok).toBe(true);
      if (!third.ok) return;
      expect(third.value.embeddedCount).toBe(0);
      expect(counter.calls).toBe(0);
    }, 60_000);

    it("a quantize flip alone (provider/dim unchanged) is caught by isIndexFresh and repopulates via cache hits", async () => {
      const counter = { calls: 0 };
      setProviderForTests(fakeTruncatableProvider(NATIVE_DIM, counter), "float32");
      const first = await reindexVault(vault);
      expect(first.ok).toBe(true);
      expect(await isIndexFresh(vault)).toBe(true);

      // Same provider object (same id, same dim) — only the quantize STATE
      // flips. This is exactly the case check (a) (embedding_model meta)
      // cannot see: the model id is unchanged.
      counter.calls = 0;
      setProviderForTests(fakeTruncatableProvider(NATIVE_DIM, counter), "int8");
      expect(await isIndexFresh(vault)).toBe(false);

      const second = await reindexVault(vault);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.embeddedCount).toBe(0); // all cache hits
      expect(counter.calls).toBe(0);

      const opened = openIndexDb(vault, NATIVE_DIM, "int8");
      if (!opened.ok) throw opened.error;
      try {
        expect(getMeta(opened.value, "embeddings_vec_kind")).toBe("int8");
        const vecCount = opened.value.prepare("SELECT COUNT(*) AS n FROM embeddings_vec").get() as {
          n: number;
        };
        expect(vecCount.n).toBeGreaterThan(0); // KNN-non-empty after the repopulating reindex
      } finally {
        opened.value.close();
      }
      expect(await isIndexFresh(vault)).toBe(true); // now coherent again
    }, 60_000);
  });

  describe("valid-time columns", () => {
    it("carries authored validity endpoints from frontmatter into the index", async () => {
      await writeFile(
        join(vault, "pricing/plan-pro-q1.md"),
        "---\ntitle: Plan Pro Q1 pricing\ndomain: accumulation\ncollection: pricing\n" +
          "status: canonical\nconfidence: high\ncreated: 2026-01-05\nupdated: 2026-01-05\n" +
          "updated_by: agent:test\nprovenance: direct\n" +
          "valid_from: 2026-01-01\nvalid_until: 2026-03-31\ntags: []\n---\n\n" +
          "Plan Pro was 49 USD per seat per month.\n",
      );

      const result = await reindexVault(vault);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const opened = openIndexDb(vault, LOCAL_MINILM_DIM, "float32");
      if (!opened.ok) throw opened.error;
      const db = opened.value;
      try {
        const doc = getDocument(db, "pricing/plan-pro-q1.md");
        expect(doc?.validFrom).toBe("2026-01-01");
        expect(doc?.validUntil).toBe("2026-03-31");
      } finally {
        db.close();
      }
    }, 60_000);

    it("indexes a document with no authored validity as null on both endpoints", async () => {
      const result = await reindexVault(vault);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const opened = openIndexDb(vault, LOCAL_MINILM_DIM, "float32");
      if (!opened.ok) throw opened.error;
      const db = opened.value;
      try {
        // Every fixture document predates the feature — the pre-adoption state.
        const docs = getAllDocuments(db);
        expect(docs.length).toBeGreaterThan(0);
        expect(docs.every((d) => d.validFrom === null && d.validUntil === null)).toBe(true);
      } finally {
        db.close();
      }
    }, 60_000);
  });
});
