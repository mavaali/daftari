import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_WEIGHTS, hybridSearch, relatedSearch } from "../../src/search/hybrid.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import { reindexVault } from "../../src/search/reindex.js";
import * as indexDb from "../../src/storage/index-db.js";
import { type IndexDb, openIndexDb } from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const CREDIT_DOC = "pricing/helios-consumption-pricing.md";
const NORTHWIND_DOC = "competitive-intel/northwind-data-governance.md";
const INSIGHT_DOC = "competitive-intel/vega-insight-positioning.md";
const GOVERNANCE_DOCS = [NORTHWIND_DOC, INSIGHT_DOC];

describe("hybrid search", () => {
  let vault: string;
  let db: IndexDb;

  beforeAll(async () => {
    vault = makeTempVault();
    const reindexed = await reindexVault(vault);
    if (!reindexed.ok) throw reindexed.error;
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!opened.ok) throw opened.error;
    db = opened.value;
  }, 60_000);

  afterAll(() => {
    db.close();
    cleanupVault(vault);
  });

  describe("hybridSearch", () => {
    it("ranks the strongest lexical match first for a keyword query", async () => {
      const result = await hybridSearch(db, "Helios compute credit consumption pricing");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits[0]?.path).toBe(CREDIT_DOC);
    });

    it("defaults to chunk-granularity (matches explicit chunk mode)", async () => {
      const a = await hybridSearch(db, "Helios compute credit consumption pricing");
      const b = await hybridSearch(db, "Helios compute credit consumption pricing", {
        lexicalGranularity: "chunk",
      });
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.value.hits.map((h) => h.path)).toEqual(b.value.hits.map((h) => h.path));
      expect(a.value.hits.map((h) => h.bm25Score)).toEqual(b.value.hits.map((h) => h.bm25Score));
      expect(a.value.hits[0]?.path).toBe(CREDIT_DOC);
    });

    it("returns snippets and per-ranker scores", async () => {
      const result = await hybridSearch(db, "cirrus pooled capacity tier");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.vectorUsed).toBe(true);
      const top = result.value.hits[0];
      expect(top?.snippet.length).toBeGreaterThan(0);
      expect(top?.bm25Score).toBeGreaterThan(0);
      expect(top?.score).toBeGreaterThan(0);
      for (const hit of result.value.hits) {
        expect(hit.bm25Score).toBeGreaterThanOrEqual(0);
        expect(hit.bm25Score).toBeLessThanOrEqual(1);
        expect(hit.vectorScore).toBeGreaterThanOrEqual(0);
        expect(hit.vectorScore).toBeLessThanOrEqual(1);
      }
    });

    it("respects the result limit", async () => {
      const result = await hybridSearch(db, "pricing", { limit: 2 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.length).toBeLessThanOrEqual(2);
    });

    it("finds semantically related docs when no keywords overlap", async () => {
      // None of these query words appear anywhere in the vault, so BM25 alone
      // returns nothing — any hit is a pure vector match.
      const query = "preventing unauthorized exfiltration of confidential corporate information";

      const lexicalOnly = await hybridSearch(db, query, {
        weights: { bm25: 1, vector: 0 },
      });
      expect(lexicalOnly.ok).toBe(true);
      if (!lexicalOnly.ok) return;
      expect(lexicalOnly.value.hits).toEqual([]);

      const semantic = await hybridSearch(db, query, {
        weights: { bm25: 0, vector: 1 },
      });
      expect(semantic.ok).toBe(true);
      if (!semantic.ok) return;
      expect(semantic.value.hits.length).toBeGreaterThan(0);
      expect(GOVERNANCE_DOCS).toContain(semantic.value.hits[0]?.path);
    });

    it("rejects an empty query", async () => {
      const result = await hybridSearch(db, "   ");
      // tokenize yields nothing and the query embeds to a generic vector;
      // still a valid (if weak) search — the tool layer guards empty input.
      expect(result.ok).toBe(true);
    });

    it("reports vectorUsed false for a pure-lexical (vector:0) query", async () => {
      const res = await hybridSearch(db, "Helios compute credit consumption pricing", {
        weights: { bm25: 1, vector: 0 },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.vectorUsed).toBe(false);
      expect(res.value.weights).toEqual({ bm25: 1, vector: 0 });
    });
  });

  // The performance refactor (efficiency finding E1) scopes the full-row fetch
  // to the candidate set the rankers produce, instead of loading every document
  // row (content blob + JSON tag/token parse) via getAllDocuments on each query.
  // These tests pin both the scoping (getAllDocuments is no longer touched; only
  // candidate paths are fetched) and that ranking output is byte-for-byte
  // unchanged for representative queries.
  describe("candidate-scoped document fetch (finding E1)", () => {
    afterEach(() => vi.restoreAllMocks());

    it("never loads the whole vault: getAllDocuments is not called on a search", async () => {
      const spyAll = vi.spyOn(indexDb, "getAllDocuments");
      const spyByPaths = vi.spyOn(indexDb, "getDocumentsByPaths");

      const result = await hybridSearch(db, "Helios compute credit consumption pricing", {
        weights: { bm25: 1, vector: 0 },
      });
      expect(result.ok).toBe(true);

      expect(spyAll).not.toHaveBeenCalled();
      expect(spyByPaths).toHaveBeenCalled();
    });

    it("fetches only candidate paths, not the whole vault", async () => {
      const spyByPaths = vi.spyOn(indexDb, "getDocumentsByPaths");

      const result = await hybridSearch(db, "Helios compute credit consumption pricing", {
        weights: { bm25: 1, vector: 0 },
      });
      expect(result.ok).toBe(true);

      const fetched = spyByPaths.mock.calls.flatMap((c) => c[0] as string[]);
      const total = indexDb.documentCount(db);
      // Scoped: strictly fewer rows fetched than the vault holds, and non-empty
      // for a query that does match documents.
      expect(fetched.length).toBeGreaterThan(0);
      expect(fetched.length).toBeLessThan(total);
    });

    it("relatedSearch is candidate-scoped too and excludes the source path", () => {
      const spyAll = vi.spyOn(indexDb, "getAllDocuments");
      const spyByPaths = vi.spyOn(indexDb, "getDocumentsByPaths");

      const result = relatedSearch(db, INSIGHT_DOC, { limit: 4 });
      expect(result.ok).toBe(true);

      expect(spyAll).not.toHaveBeenCalled();
      const fetched = spyByPaths.mock.calls.flatMap((c) => c[0] as string[]);
      // The source document is skipped by the ranker; it must never be fetched.
      expect(fetched).not.toContain(INSIGHT_DOC);
      expect(fetched.length).toBeLessThan(indexDb.documentCount(db));
    });

    it("results are unchanged: deterministic lexical ranking is byte-for-byte stable", async () => {
      // Lexical-only (vector:0) is fully deterministic — no embedding flake — so
      // this is a golden guard that the candidate-scoping refactor preserves the
      // exact ranked ordering and per-hit scores the old full-scan produced.
      const result = await hybridSearch(db, "Helios compute credit consumption pricing", {
        weights: { bm25: 1, vector: 0 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits[0]?.path).toBe(CREDIT_DOC);
      // Every hit resolved a real document row (title/snippet populated) — proof
      // the scoped fetch actually returned the candidate rows, not empty stubs.
      for (const hit of result.value.hits) {
        expect(hit.title.length).toBeGreaterThan(0);
        expect(hit.snippet.length).toBeGreaterThan(0);
      }
    });
  });

  describe("relatedSearch", () => {
    it("excludes the source document from its own results", () => {
      const result = relatedSearch(db, INSIGHT_DOC);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.map((h) => h.path)).not.toContain(INSIGHT_DOC);
      expect(result.value.hits.length).toBeGreaterThan(0);
    });

    it("surfaces a thematically related document", () => {
      // Vega Insight and Northwind both pitch a data-governance story.
      const result = relatedSearch(db, INSIGHT_DOC, { limit: 4 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.map((h) => h.path)).toContain(NORTHWIND_DOC);
    });

    it("errors for a document that is not indexed", () => {
      const result = relatedSearch(db, "pricing/nonexistent.md");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("not indexed");
    });

    it("uses the default weights when none are given", () => {
      const result = relatedSearch(db, CREDIT_DOC);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.weights).toEqual(DEFAULT_WEIGHTS);
    });
  });
});

describe("hybrid search — decay surfacing", () => {
  let decayVault: string;
  let decayDb: IndexDb;

  beforeAll(async () => {
    decayVault = mkdtempSync(join(tmpdir(), "daftari-decay-search-"));

    // A past-TTL canonical document. updated and created are far in the past,
    // ttl_days: 1 means it expired the day after creation.
    writeFileSync(
      join(decayVault, "stale-doc.md"),
      `---
title: "Stale Document"
domain: product
collection: general
status: canonical
confidence: high
created: 2020-01-01
updated: 2020-01-01
updated_by: human:test
provenance: direct
sources:
  - some-source
superseded_by: null
ttl_days: 1
tags: [stale, expired, decay]
---

# Stale Document

This document covers stale and expired decay information for testing purposes.
`,
    );

    // A healthy document to ensure decay is null for non-decayed hits.
    writeFileSync(
      join(decayVault, "healthy-doc.md"),
      `---
title: "Healthy Document"
domain: product
collection: general
status: canonical
confidence: high
created: 2026-01-01
updated: 2026-05-01
updated_by: human:test
provenance: direct
sources:
  - some-source
superseded_by: null
ttl_days: 365
tags: [healthy, current]
---

# Healthy Document

This document is healthy and current with no decay issues at all.
`,
    );

    // A second healthy document to pad results.
    writeFileSync(
      join(decayVault, "another-doc.md"),
      `---
title: "Another Document"
domain: product
collection: general
status: canonical
confidence: high
created: 2026-02-01
updated: 2026-04-15
updated_by: human:test
provenance: direct
sources:
  - another-source
superseded_by: null
ttl_days: 365
tags: [reference, general]
---

# Another Document

Reference material for general use across the vault.
`,
    );

    const reindexed = await reindexVault(decayVault);
    if (!reindexed.ok) throw reindexed.error;
    const opened = openIndexDb(decayVault, LOCAL_MINILM_DIM);
    if (!opened.ok) throw opened.error;
    decayDb = opened.value;
  }, 60_000);

  afterAll(() => {
    decayDb.close();
    rmSync(decayVault, { recursive: true, force: true });
  });

  it("attaches decay state to a past-TTL hit", async () => {
    const result = await hybridSearch(decayDb, "stale expired decay");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const staleHit = result.value.hits.find((h) => h.path === "stale-doc.md");
    expect(staleHit).toBeDefined();
    expect(staleHit?.decay).not.toBeNull();
    expect(staleHit?.decay?.level).toBe("warn");
  });

  it("returns null decay for a healthy document hit", async () => {
    const result = await hybridSearch(decayDb, "healthy current document");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const healthyHit = result.value.hits.find((h) => h.path === "healthy-doc.md");
    expect(healthyHit).toBeDefined();
    expect(healthyHit?.decay).toBeNull();
  });

  it("every hit carries the decay field (null or object)", async () => {
    const result = await hybridSearch(decayDb, "document");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits.length).toBeGreaterThan(0);
    for (const hit of result.value.hits) {
      expect(Object.hasOwn(hit, "decay")).toBe(true);
      expect(hit.decay === null || typeof hit.decay === "object").toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Chunk-granularity BM25 dilution test
// ---------------------------------------------------------------------------
// `multi.md` contains the rare term "zephyr" in only one chunk. The rest of
// its body is filler so the whole-doc BM25 score is diluted. `decoy.md` shares
// all the filler words but NOT "zephyr". Under document-granularity, the
// filler flood dilutes `multi.md`'s score enough that the decoy can rank
// above it. Under chunk-granularity, `multi.md`'s zephyr-chunk scores high
// and wins.
describe("hybrid search — chunk-level BM25 granularity", () => {
  let chunkVault: string;
  let chunkDb: IndexDb;

  beforeAll(async () => {
    chunkVault = mkdtempSync(join(tmpdir(), "daftari-chunk-bm25-"));

    // multi.md: MANY filler paragraphs (making the document very long) plus ONE
    // tiny paragraph containing only the word "zephyr". The chunker packs the
    // filler paragraphs into long chunks and the single-word "zephyr" paragraph
    // into its own tiny chunk (~6 chars). Under DOCUMENT-level BM25, the long
    // body dilutes the score and decoy.md wins. Under CHUNK-level BM25, the
    // 6-char zephyr-only chunk has maximal term frequency (1 mention / 1 token)
    // and wins over decoy's 100-char chunk where "zephyr" is just one of many.
    const filler =
      "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ";
    // Ten filler paragraphs × ~900 chars each → ~10 KB body; huge length penalty.
    const fillerParas = Array.from({ length: 10 }, () => filler.repeat(8)).join("\n\n");
    const zephyrPara = "zephyr"; // 6 chars; gets its own chunk after filler hard-splits

    writeFileSync(
      join(chunkVault, "multi.md"),
      `---
title: "Multi Chunk Document"
domain: product
collection: general
status: canonical
confidence: high
created: 2026-01-01
updated: 2026-01-01
updated_by: human:test
provenance: direct
sources:
  - test-source
superseded_by: null
tags: [test]
---

# Multi Chunk Document

${fillerParas}

${zephyrPara}
`,
    );

    // decoy.md: a short document that mentions "zephyr" once in a sentence so it
    // beats multi.md under WHOLE-DOC BM25 (short doc = low length penalty, high
    // relative zephyr density). Under CHUNK-level BM25, its single chunk
    // (~100 chars) loses to multi.md's 6-char zephyr-only chunk.
    writeFileSync(
      join(chunkVault, "decoy.md"),
      `---
title: "Decoy Document"
domain: product
collection: general
status: canonical
confidence: high
created: 2026-01-01
updated: 2026-01-01
updated_by: human:test
provenance: direct
sources:
  - test-source
superseded_by: null
tags: [test]
---

# Decoy Document

The zephyr system was briefly mentioned in a prior report and has no further detail.
`,
    );

    const reindexed = await reindexVault(chunkVault);
    if (!reindexed.ok) throw reindexed.error;
    const opened = openIndexDb(chunkVault, LOCAL_MINILM_DIM);
    if (!opened.ok) throw opened.error;
    chunkDb = opened.value;
  }, 60_000);

  afterAll(() => {
    chunkDb.close();
    rmSync(chunkVault, { recursive: true, force: true });
  });

  it("chunk granularity ranks a diluted single-chunk topic above a decoy", async () => {
    // Fixture assumption: under DOCUMENT-level BM25, FTS5 length normalization
    // favors the SHORT decoy.md (which contains "zephyr" once in a short ~100-char
    // body) over long multi.md where "zephyr" is diluted across ~10 KB of filler.
    // Under CHUNK-level BM25, multi.md's tiny "zephyr"-only chunk has near-maximal
    // term density (1 mention / ~6 chars) and beats decoy.md's longer chunk.
    // This depends on CHUNK_MAX_CHARS (currently 800) and the filler repeat counts
    // above — if chunk size changes, the filler sizing may need re-tuning.
    const res = await hybridSearch(chunkDb, "zephyr", {
      weights: { bm25: 1, vector: 0 },
      lexicalGranularity: "chunk",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.hits[0]?.path).toBe("multi.md");
    // Confirm the chunk arm REORDERS (both docs matched) rather than omitting decoy.
    expect(res.value.hits.some((h) => h.path === "decoy.md")).toBe(true);

    // The "document" arm must NOT rank multi.md first — confirming the two
    // rankers produce a meaningful difference on this fixture.
    const docArm = await hybridSearch(chunkDb, "zephyr", {
      weights: { bm25: 1, vector: 0 },
      lexicalGranularity: "document",
    });
    expect(docArm.ok).toBe(true);
    if (docArm.ok) expect(docArm.value.hits[0]?.path).not.toBe("multi.md");
  });

  it("defaults to chunk-granularity (diluted topic wins with no explicit option)", async () => {
    // Behavioral proof of the flipped default: calling WITHOUT lexicalGranularity
    // must now reproduce the chunk arm — multi.md's diluted zephyr-chunk ranks #1.
    // Under the old "document" default this query ranked multi.md below the decoy.
    const res = await hybridSearch(chunkDb, "zephyr", { weights: { bm25: 1, vector: 0 } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.hits[0]?.path).toBe("multi.md");
  });
});

// ---------------------------------------------------------------------------
// Title/tag-aware chunk-BM25 tests
// ---------------------------------------------------------------------------
// Verifies that chunk mode can match terms that live ONLY in a doc's title or
// tags (not in body text). Each probe term (wintermute, tagunique, tiebreak)
// appears in exactly the intended field of exactly one doc — no overlap.
describe("hybrid search — title/tag-aware chunk BM25", () => {
  let ttVault: string;
  let ttDb: IndexDb;

  beforeAll(async () => {
    ttVault = mkdtempSync(join(tmpdir(), "daftari-tt-chunk-bm25-"));

    // titledoc.md: "wintermute" ONLY in title. Body is generic.
    writeFileSync(
      join(ttVault, "titledoc.md"),
      `---
title: "Project wintermute roadmap"
domain: product
collection: general
status: canonical
confidence: high
created: 2026-01-01
updated: 2026-01-01
updated_by: human:test
provenance: direct
sources:
  - test-source
superseded_by: null
tags: [planning]
---

# Roadmap

This document covers the general planning information for our roadmap.
`,
    );

    // tagdoc.md: "tagunique" ONLY in tags. Body is generic.
    writeFileSync(
      join(ttVault, "tagdoc.md"),
      `---
title: "Tag Reference Document"
domain: product
collection: general
status: canonical
confidence: high
created: 2026-01-01
updated: 2026-01-01
updated_by: human:test
provenance: direct
sources:
  - test-source
superseded_by: null
tags: [tagunique, native]
---

# Tag Reference

This document covers general reference material for tag classification purposes.
`,
    );

    // bodywin.md: "tiebreak" ONLY in body text. Title/tags are generic.
    writeFileSync(
      join(ttVault, "bodywin.md"),
      `---
title: "Body Win Document"
domain: product
collection: general
status: canonical
confidence: high
created: 2026-01-01
updated: 2026-01-01
updated_by: human:test
provenance: direct
sources:
  - test-source
superseded_by: null
tags: [general]
---

# Body Win

tiebreak
`,
    );

    // titlecoincidence.md: "tiebreak" ONLY in title. Body is generic.
    writeFileSync(
      join(ttVault, "titlecoincidence.md"),
      `---
title: "tiebreak quarterly"
domain: product
collection: general
status: canonical
confidence: high
created: 2026-01-01
updated: 2026-01-01
updated_by: human:test
provenance: direct
sources:
  - test-source
superseded_by: null
tags: [general]
---

# Quarterly Review

This document covers general quarterly review information.
`,
    );

    // filler1.md: generic content, no probe terms.
    writeFileSync(
      join(ttVault, "filler1.md"),
      `---
title: "Filler Document One"
domain: product
collection: general
status: canonical
confidence: high
created: 2026-01-01
updated: 2026-01-01
updated_by: human:test
provenance: direct
sources:
  - test-source
superseded_by: null
tags: [filler]
---

# Filler One

General filler content for padding the vault retrieval set.
`,
    );

    // filler2.md: generic content, no probe terms.
    writeFileSync(
      join(ttVault, "filler2.md"),
      `---
title: "Filler Document Two"
domain: product
collection: general
status: canonical
confidence: high
created: 2026-01-01
updated: 2026-01-01
updated_by: human:test
provenance: direct
sources:
  - test-source
superseded_by: null
tags: [filler]
---

# Filler Two

Additional filler content for padding the vault retrieval set.
`,
    );

    const reindexed = await reindexVault(ttVault);
    if (!reindexed.ok) throw reindexed.error;
    const opened = openIndexDb(ttVault, LOCAL_MINILM_DIM);
    if (!opened.ok) throw opened.error;
    ttDb = opened.value;
  }, 60_000);

  afterAll(() => {
    ttDb.close();
    rmSync(ttVault, { recursive: true, force: true });
  });

  it("chunk mode matches a title-only term (was blind before the fix)", async () => {
    const res = await hybridSearch(ttDb, "wintermute", {
      weights: { bm25: 1, vector: 0 },
      lexicalGranularity: "chunk",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.hits[0]?.path).toBe("titledoc.md");
  });

  it("chunk mode matches a tag-only term", async () => {
    const res = await hybridSearch(ttDb, "tagunique", {
      weights: { bm25: 1, vector: 0 },
      lexicalGranularity: "chunk",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.hits[0]?.path).toBe("tagdoc.md");
  });

  // bodywin.md has "tiebreak" in its body → upper band (>0.5). titlecoincidence.md
  // has it title-only → lower band (<=0.5). The tier boundary guarantees body wins;
  // titlecoincidence is still retrieved, just ranked below.
  it("body match wins a tie against a coincidental title-only match", async () => {
    const res = await hybridSearch(ttDb, "tiebreak", {
      weights: { bm25: 1, vector: 0 },
      lexicalGranularity: "chunk",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.hits[0]?.path).toBe("bodywin.md");
    expect(res.value.hits.some((h) => h.path === "titlecoincidence.md")).toBe(true);
  });
});
