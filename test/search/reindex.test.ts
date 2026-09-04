import { mkdir, readFile, rename, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok, type Result } from "../../src/frontmatter/types.js";
import type { EmbeddingProvider } from "../../src/search/embedding-provider.js";
import { LOCAL_MINILM_DIM, localMinilmProvider } from "../../src/search/providers/local-minilm.js";
import {
  indexDocument,
  indexedFieldsFingerprint,
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
import { clearConfigCache } from "../../src/utils/config.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

describe("reindexVault", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    clearConfigCache();
    cleanupVault(vault);
  });

  async function writeIndexedConfig(indexedFields: string[]): Promise<void> {
    await mkdir(join(vault, ".daftari"), { recursive: true });
    await writeFile(
      join(vault, ".daftari", "config.yaml"),
      [
        "schema_extensions:",
        "  due_date:",
        "    type: date",
        "  priority:",
        "    type: number",
        "    default: 9",
        "  owner:",
        "    type: string",
        "  stage:",
        "    type: enum",
        "    enum: [queued, active, done]",
        "  urgent:",
        "    type: boolean",
        `indexed_fields: [${indexedFields.join(", ")}]`,
        "",
      ].join("\n"),
    );
    clearConfigCache();
  }

  function customDocument(fields: string, body = "Structured project record."): string {
    return [
      "---",
      "title: Structured Project",
      "domain: accumulation",
      "collection: projects",
      "status: canonical",
      "confidence: high",
      "created: 2026-09-01",
      "updated: 2026-09-01",
      "updated_by: agent:test",
      "provenance: direct",
      "tags: []",
      fields,
      "---",
      "",
      body,
      "",
    ].join("\n");
  }

  it("projects only authored valid configured scalar values", async () => {
    await writeIndexedConfig(["due_date", "priority", "owner", "stage", "urgent"]);
    await writeFile(
      join(vault, "projects-valid.md"),
      customDocument(
        [
          "due_date: 2026-09-15",
          "priority: 2",
          "owner: human:mihir",
          "stage: active",
          "urgent: true",
        ].join("\n"),
      ),
    );
    await writeFile(join(vault, "projects-default.md"), customDocument("owner: agent:codex"));
    await writeFile(
      join(vault, "projects-invalid.md"),
      customDocument(`due_date: "2026-02-30"\nowner: ${"x".repeat(4097)}`),
    );

    const result = await reindexVault(vault, { lexicalOnly: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const invalid = result.value.invalidFrontmatter.find(
      (entry) => entry.path === "projects-invalid.md",
    );
    expect(invalid?.reason).toContain("due_date");
    expect(invalid?.reason).toContain("owner");

    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!opened.ok) throw opened.error;
    try {
      const rows = opened.value
        .prepare(
          "SELECT path, field, kind, text_value, number_value, bool_value FROM document_fields WHERE path LIKE 'projects-%' ORDER BY path, field",
        )
        .all();
      expect(rows).toEqual([
        {
          path: "projects-default.md",
          field: "owner",
          kind: "string",
          text_value: "agent:codex",
          number_value: null,
          bool_value: null,
        },
        {
          path: "projects-valid.md",
          field: "due_date",
          kind: "date",
          text_value: "2026-09-15",
          number_value: null,
          bool_value: null,
        },
        {
          path: "projects-valid.md",
          field: "owner",
          kind: "string",
          text_value: "human:mihir",
          number_value: null,
          bool_value: null,
        },
        {
          path: "projects-valid.md",
          field: "priority",
          kind: "number",
          text_value: null,
          number_value: 2,
          bool_value: null,
        },
        {
          path: "projects-valid.md",
          field: "stage",
          kind: "enum",
          text_value: "active",
          number_value: null,
          bool_value: null,
        },
        {
          path: "projects-valid.md",
          field: "urgent",
          kind: "boolean",
          text_value: null,
          number_value: null,
          bool_value: 1,
        },
      ]);
    } finally {
      opened.value.close();
    }
  }, 60_000);

  it("replaces projected rows during incremental indexing", async () => {
    await writeIndexedConfig(["due_date", "priority", "owner"]);
    const path = "projects-incremental.md";
    await writeFile(
      join(vault, path),
      customDocument("due_date: 2026-09-15\npriority: 2\nowner: human:mihir"),
    );
    const first = await reindexVault(vault);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await writeFile(join(vault, path), customDocument("priority: 5\nowner: agent:codex"));
    const updated = await indexDocument(vault, path);
    expect(updated.ok).toBe(true);
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!opened.ok) throw opened.error;
    try {
      expect(
        opened.value
          .prepare(
            "SELECT field, text_value, number_value FROM document_fields WHERE path = ? ORDER BY field",
          )
          .all(path),
      ).toEqual([
        { field: "owner", text_value: "agent:codex", number_value: null },
        { field: "priority", text_value: null, number_value: 5 },
      ]);
    } finally {
      opened.value.close();
    }
  }, 60_000);

  it("treats an indexed-field declaration change as stale", async () => {
    await writeIndexedConfig(["priority", "stage"]);
    const first = await reindexVault(vault, { lexicalOnly: true });
    expect(first.ok).toBe(true);
    expect(await isIndexFresh(vault)).toBe(true);

    await writeIndexedConfig(["stage", "priority"]);
    expect(await isIndexFresh(vault)).toBe(false);
  }, 60_000);

  it("fingerprints indexed field names, types, enum members, and order", () => {
    const baseline = [
      { field: "stage", type: "enum" as const, enum: ["queued", "active"] },
      { field: "priority", type: "number" as const },
    ];
    expect(indexedFieldsFingerprint(baseline)).toBe(indexedFieldsFingerprint(baseline));
    expect(indexedFieldsFingerprint(baseline)).not.toBe(
      indexedFieldsFingerprint([...baseline].reverse()),
    );
    expect(indexedFieldsFingerprint(baseline)).not.toBe(
      indexedFieldsFingerprint([
        { field: "stage", type: "enum", enum: ["queued", "done"] },
        { field: "priority", type: "number" },
      ]),
    );
    expect(indexedFieldsFingerprint([{ field: "priority", type: "number" }])).not.toBe(
      indexedFieldsFingerprint([{ field: "priority", type: "string" }]),
    );
  });

  it("indexes every vault document and its chunks", async () => {
    const result = await reindexVault(vault);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.documentCount).toBe(10);
    expect(result.value.chunkCount).toBeGreaterThanOrEqual(10);
    expect(result.value.skipped).toEqual([]);
    expect(result.value.vectorEnabled).toBe(true);

    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
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
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
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

    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
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
        const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
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
        const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
        if (!opened.ok) throw opened.error;
        try {
          return embeddingCount(opened.value);
        } finally {
          opened.value.close();
        }
      })();
      expect(cacheSizeAfter).toBe(cacheSizeBefore);
    }, 120_000);

    it("moved paragraph re-embeds zero: identical chunk text in a different file is a cache hit", async () => {
      const first = await reindexVault(vault);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      // Grab an actual chunk's text from the index and use it verbatim as
      // the body of a brand-new file. Because chunkText is deterministic
      // and the body equals exactly one chunk's worth of text, the new
      // file's chunker round-trips to the same content_hash — which the
      // cache already holds.
      const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
      if (!opened.ok) throw opened.error;
      const chunkText = (() => {
        try {
          const all = getAllChunks(opened.value, EMBEDDING_MODEL);
          return all[0]?.text ?? "";
        } finally {
          opened.value.close();
        }
      })();
      expect(chunkText.length).toBeGreaterThan(0);

      await writeFile(
        join(vault, "competitive-intel/clone-paragraph.md"),
        `---\ntitle: Clone\ndomain: positioning\nstatus: draft\nconfidence: low\nupdated: 2026-05-20\ntags: []\n---\n\n${chunkText}\n`,
      );

      const second = await reindexVault(vault);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      // No new embedding work — the cloned chunk hashes to a cached row.
      expect(second.value.embeddedCount).toBe(0);
      expect(second.value.documentCount).toBe(first.value.documentCount + 1);
    }, 120_000);

    it("vault_gc reaps embeddings whose chunks no longer reference them", async () => {
      const first = await reindexVault(vault);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const cacheBefore = (() => {
        const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
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
      const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
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
      const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
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
      const dbMeta = openIndexDb(vault, LOCAL_MINILM_DIM);
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
      const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
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

      const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
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

      const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
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
