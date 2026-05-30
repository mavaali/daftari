import { describe, expect, it } from "vitest";
import {
  mergeIndex,
  mergeLint,
  mergeReindex,
  mergeSearch,
  mergeStatus,
  mergeThemes,
} from "../src/tools/merge.js";

// ---------------------------------------------------------------------------
// mergeSearch
// ---------------------------------------------------------------------------

describe("mergeSearch", () => {
  it("interleaves by score, prefixes paths with vault, recomputes count", () => {
    const out = mergeSearch([
      {
        vault: "a",
        ok: true,
        value: {
          count: 1,
          hits: [{ path: "x.md", score: 0.91, collection: "c", snippet: "..." }],
        },
      },
      {
        vault: "b",
        ok: true,
        value: {
          count: 1,
          hits: [{ path: "y.md", score: 0.87, collection: "c", snippet: "..." }],
        },
      },
    ]);
    expect(out.hits.map((h) => h.path)).toEqual(["a:x.md", "b:y.md"]);
    expect(out.count).toBe(2);
    expect(out.errors).toEqual([]);
  });

  it("surfaces per-vault errors without failing the merge", () => {
    const out = mergeSearch([
      {
        vault: "a",
        ok: true,
        value: { count: 1, hits: [{ path: "x.md", score: 0.5, collection: "c" }] },
      },
      { vault: "b", ok: false, error: "child crashed" },
    ]);
    expect(out.hits).toHaveLength(1);
    expect(out.count).toBe(1);
    expect(out.errors).toEqual([{ vault: "b", error: "child crashed" }]);
  });

  it("sorts descending by score across vaults", () => {
    const out = mergeSearch([
      {
        vault: "a",
        ok: true,
        value: {
          count: 2,
          hits: [
            { path: "low.md", score: 0.3, collection: "c" },
            { path: "high.md", score: 0.95, collection: "c" },
          ],
        },
      },
      {
        vault: "b",
        ok: true,
        value: { count: 1, hits: [{ path: "mid.md", score: 0.6, collection: "c" }] },
      },
    ]);
    expect(out.hits.map((h) => h.path)).toEqual(["a:high.md", "b:mid.md", "a:low.md"]);
    expect(out.count).toBe(3);
  });

  it("adds vault field to each hit", () => {
    const out = mergeSearch([
      {
        vault: "myvault",
        ok: true,
        value: { count: 1, hits: [{ path: "doc.md", score: 0.8, collection: "notes" }] },
      },
    ]);
    expect(out.hits[0]).toMatchObject({ vault: "myvault", path: "myvault:doc.md" });
  });
});

// ---------------------------------------------------------------------------
// mergeIndex
// ---------------------------------------------------------------------------

const baseEntry = {
  title: "T",
  collection: "c",
  domain: "d",
  status: "s",
  confidence: "med",
  updated: "2026-01-01",
  tags: [],
  questionsAnswered: [],
  questionsRaised: [],
  valid: true,
};

describe("mergeIndex", () => {
  it("concatenates entries, prefixes paths, sums count", () => {
    const out = mergeIndex([
      {
        vault: "a",
        ok: true,
        value: { count: 1, entries: [{ ...baseEntry, path: "a.md" }] },
      },
      {
        vault: "b",
        ok: true,
        value: { count: 1, entries: [{ ...baseEntry, path: "b.md" }] },
      },
    ]);
    expect(out.entries.map((e) => e.path)).toEqual(["a:a.md", "b:b.md"]);
    expect(out.count).toBe(2);
    expect(out.errors).toEqual([]);
  });

  it("sorts entries asc by prefixed path", () => {
    const out = mergeIndex([
      {
        vault: "z",
        ok: true,
        value: { count: 1, entries: [{ ...baseEntry, path: "alpha.md" }] },
      },
      {
        vault: "a",
        ok: true,
        value: { count: 1, entries: [{ ...baseEntry, path: "beta.md" }] },
      },
    ]);
    // "a:beta.md" < "z:alpha.md" lexicographically
    expect(out.entries.map((e) => e.path)).toEqual(["a:beta.md", "z:alpha.md"]);
  });

  it("surfaces per-vault errors without failing the merge", () => {
    const out = mergeIndex([
      {
        vault: "a",
        ok: true,
        value: { count: 1, entries: [{ ...baseEntry, path: "a.md" }] },
      },
      { vault: "b", ok: false, error: "vault offline" },
    ]);
    expect(out.entries).toHaveLength(1);
    expect(out.count).toBe(1);
    expect(out.errors).toEqual([{ vault: "b", error: "vault offline" }]);
  });

  it("adds vault field to each entry", () => {
    const out = mergeIndex([
      {
        vault: "myvault",
        ok: true,
        value: { count: 1, entries: [{ ...baseEntry, path: "doc.md" }] },
      },
    ]);
    expect(out.entries[0]).toMatchObject({ vault: "myvault", path: "myvault:doc.md" });
  });
});

// ---------------------------------------------------------------------------
// mergeStatus
// ---------------------------------------------------------------------------

const baseStatus = {
  fileCount: 10,
  invalidCount: 1,
  embeddingDimMismatches: 0,
  stalenessDistribution: { fresh: 7, aging: 2, stale: 1, total: 10 },
};

describe("mergeStatus", () => {
  it("sums numeric counters and staleness distribution across vaults", () => {
    const out = mergeStatus([
      { vault: "a", ok: true, value: { ...baseStatus } },
      { vault: "b", ok: true, value: { ...baseStatus, fileCount: 5, invalidCount: 0 } },
    ]);
    expect(out.fileCount).toBe(15);
    expect(out.invalidCount).toBe(1);
    expect(out.stalenessDistribution).toEqual({ fresh: 14, aging: 4, stale: 2, total: 20 });
    expect(out.errors).toEqual([]);
  });

  it("preserves per-vault detail in byVault", () => {
    const out = mergeStatus([
      { vault: "a", ok: true, value: { ...baseStatus } },
      { vault: "b", ok: true, value: { ...baseStatus, fileCount: 3 } },
    ]);
    expect(out.byVault["a"]).toBeDefined();
    expect(out.byVault["b"]?.fileCount).toBe(3);
  });

  it("surfaces per-vault errors without failing the merge", () => {
    const out = mergeStatus([
      { vault: "a", ok: true, value: { ...baseStatus } },
      { vault: "b", ok: false, error: "index locked" },
    ]);
    expect(out.fileCount).toBe(10);
    expect(out.errors).toEqual([{ vault: "b", error: "index locked" }]);
  });
});

// ---------------------------------------------------------------------------
// mergeLint
// ---------------------------------------------------------------------------

describe("mergeLint", () => {
  it("merges checks, prefixes finding paths, sums totalFindings", () => {
    const out = mergeLint([
      {
        vault: "a",
        ok: true,
        value: {
          generatedAt: "2026-01-01T00:00:00Z",
          filter: null,
          totalFindings: 1,
          checks: { staleFiles: [{ path: "old.md", detail: "stale" }] },
        },
      },
      {
        vault: "b",
        ok: true,
        value: {
          generatedAt: "2026-01-01T00:00:00Z",
          filter: null,
          totalFindings: 1,
          checks: { staleFiles: [{ path: "also-old.md", detail: "stale" }] },
        },
      },
    ]);
    expect(out.totalFindings).toBe(2);
    expect(out.checks["staleFiles"]).toHaveLength(2);
    expect(out.checks["staleFiles"]?.map((f) => f.path)).toEqual(["a:old.md", "b:also-old.md"]);
    expect(out.errors).toEqual([]);
  });

  it("aggregates findings across different check names", () => {
    const out = mergeLint([
      {
        vault: "a",
        ok: true,
        value: {
          generatedAt: "2026-01-01T00:00:00Z",
          filter: null,
          totalFindings: 2,
          checks: {
            staleFiles: [{ path: "s.md", detail: "stale" }],
            orphanFiles: [{ path: "o.md", detail: "orphan" }],
          },
        },
      },
    ]);
    expect(out.totalFindings).toBe(2);
    expect(out.checks["staleFiles"]?.[0]?.path).toBe("a:s.md");
    expect(out.checks["orphanFiles"]?.[0]?.path).toBe("a:o.md");
  });

  it("surfaces per-vault errors without failing the merge", () => {
    const out = mergeLint([
      {
        vault: "a",
        ok: true,
        value: {
          generatedAt: "2026-01-01T00:00:00Z",
          filter: null,
          totalFindings: 0,
          checks: {},
        },
      },
      { vault: "b", ok: false, error: "read failed" },
    ]);
    expect(out.totalFindings).toBe(0);
    expect(out.errors).toEqual([{ vault: "b", error: "read failed" }]);
  });

  it("adds vault field to each finding", () => {
    const out = mergeLint([
      {
        vault: "myvault",
        ok: true,
        value: {
          generatedAt: "2026-01-01T00:00:00Z",
          filter: null,
          totalFindings: 1,
          checks: { staleFiles: [{ path: "x.md", detail: "stale" }] },
        },
      },
    ]);
    expect(out.checks["staleFiles"]?.[0]).toMatchObject({ vault: "myvault" });
  });
});

// ---------------------------------------------------------------------------
// mergeThemes
//
// NOTE: VaultTheme uses representativeDocs/secondaryDocs (string[]), NOT
// sources. This test verifies the correct fields are prefixed.
// ---------------------------------------------------------------------------

describe("mergeThemes", () => {
  it("collects themes from all vaults, prefixes representativeDocs and secondaryDocs", () => {
    const out = mergeThemes([
      {
        vault: "a",
        ok: true,
        value: {
          themes: [
            {
              label: "theme1",
              documentCount: 2,
              coherence: 0.8,
              representativeDocs: ["doc1.md", "doc2.md"],
              secondaryDocs: ["doc3.md"],
              relatedTags: ["tag1"],
            },
          ],
        },
      },
      {
        vault: "b",
        ok: true,
        value: {
          themes: [
            {
              label: "theme2",
              documentCount: 1,
              coherence: null,
              representativeDocs: ["doc4.md"],
              secondaryDocs: [],
              relatedTags: [],
            },
          ],
        },
      },
    ]);
    expect(out.themes).toHaveLength(2);
    expect(out.themes[0]?.vault).toBe("a");
    expect(out.themes[0]?.representativeDocs).toEqual(["a:doc1.md", "a:doc2.md"]);
    expect(out.themes[0]?.secondaryDocs).toEqual(["a:doc3.md"]);
    expect(out.themes[1]?.representativeDocs).toEqual(["b:doc4.md"]);
    expect(out.errors).toEqual([]);
  });

  it("surfaces per-vault errors without failing the merge", () => {
    const out = mergeThemes([
      {
        vault: "a",
        ok: true,
        value: {
          themes: [
            {
              label: "t",
              documentCount: 1,
              coherence: null,
              representativeDocs: ["x.md"],
              secondaryDocs: [],
              relatedTags: [],
            },
          ],
        },
      },
      { vault: "b", ok: false, error: "embedding unavailable" },
    ]);
    expect(out.themes).toHaveLength(1);
    expect(out.errors).toEqual([{ vault: "b", error: "embedding unavailable" }]);
  });

  it("handles empty themes array from a vault", () => {
    const out = mergeThemes([
      { vault: "a", ok: true, value: { themes: [] } },
      {
        vault: "b",
        ok: true,
        value: {
          themes: [
            {
              label: "t",
              documentCount: 1,
              coherence: null,
              representativeDocs: ["y.md"],
              secondaryDocs: [],
              relatedTags: [],
            },
          ],
        },
      },
    ]);
    expect(out.themes).toHaveLength(1);
    expect(out.themes[0]?.vault).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// mergeReindex
//
// NOTE: Real fields are documentCount/chunkCount (NOT filesProcessed/chunksProcessed).
// ---------------------------------------------------------------------------

describe("mergeReindex", () => {
  it("sums documentCount and chunkCount, preserves byVault detail", () => {
    const out = mergeReindex([
      {
        vault: "a",
        ok: true,
        value: {
          vault: "/vaults/a",
          documentCount: 10,
          chunkCount: 50,
          vectorEnabled: true,
          skipped: [],
          indexedAt: "2026-01-01T00:00:00Z",
          embeddedCount: 50,
          cacheHits: 0,
          orphansRemoved: 0,
        },
      },
      {
        vault: "b",
        ok: true,
        value: {
          vault: "/vaults/b",
          documentCount: 5,
          chunkCount: 20,
          vectorEnabled: true,
          skipped: [],
          indexedAt: "2026-01-01T00:00:00Z",
          embeddedCount: 20,
          cacheHits: 0,
          orphansRemoved: 0,
        },
      },
    ]);
    expect(out.documentCount).toBe(15);
    expect(out.chunkCount).toBe(70);
    expect(out.byVault["a"]).toBeDefined();
    expect(out.byVault["b"]).toBeDefined();
    expect(out.errors).toEqual([]);
  });

  it("handles missing documentCount/chunkCount gracefully (treats as 0)", () => {
    const out = mergeReindex([{ vault: "a", ok: true, value: { vault: "/vaults/a" } }]);
    expect(out.documentCount).toBe(0);
    expect(out.chunkCount).toBe(0);
  });

  it("surfaces per-vault errors without failing the merge", () => {
    const out = mergeReindex([
      {
        vault: "a",
        ok: true,
        value: {
          vault: "/vaults/a",
          documentCount: 3,
          chunkCount: 9,
          vectorEnabled: false,
          skipped: [],
          indexedAt: "2026-01-01T00:00:00Z",
          embeddedCount: 0,
          cacheHits: 0,
          orphansRemoved: 0,
        },
      },
      { vault: "b", ok: false, error: "reindex failed" },
    ]);
    expect(out.documentCount).toBe(3);
    expect(out.errors).toEqual([{ vault: "b", error: "reindex failed" }]);
  });
});
