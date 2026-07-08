// Tier 1 PR gate: lexical BM25 hit@1/hit@5 on the native-shape vault, both
// granularity arms, per-query goldens. Hermetic: a stub embedding provider
// replaces MiniLM (no model load, no network); reindex runs on a throwaway
// copy of the committed fixture. Vector-weighted retrieval is Tier 2's job
// (docs/superpowers/specs/2026-07-07-regression-suite-design.md).
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ok, type Result } from "../../../src/frontmatter/types.js";
import type { EmbeddingProvider } from "../../../src/search/embedding-provider.js";
import { hybridSearch } from "../../../src/search/hybrid.js";
import { reindexVault } from "../../../src/search/reindex.js";
import { resetProviderForTests, setProviderForTests } from "../../../src/search/vector.js";
import { type IndexDb, openIndexDb } from "../../../src/storage/index-db.js";
import { type Baseline, diffBaseline } from "../helpers/baseline.js";

const FIXTURE = resolve("test/regression/fixtures/native-vault");
const BASELINE = resolve("test/regression/baselines/retrieval.json");
const LEX = { bm25: 1, vector: 0 };

// Stub provider: reindex embeds every chunk through this instead of loading
// MiniLM. Zero vectors are fine — the suite never ranks by vector (weight 0).
const STUB_DIM = 8;
const stubProvider: EmbeddingProvider = {
  id: "regression-stub",
  dim: STUB_DIM,
  async warm(): Promise<Result<void, Error>> {
    return ok(undefined);
  },
  async embed(texts: string[]): Promise<Result<Float32Array[], Error>> {
    return ok(texts.map(() => new Float32Array(STUB_DIM)));
  },
};

interface Query {
  id: string;
  type: string;
  query: string;
  relevantPath: string;
}

const queries: Query[] = readFileSync(join(FIXTURE, "queries.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Query);

describe("retrieval regression (lexical BM25, native-shape vault)", () => {
  let vault: string;
  let db: IndexDb;
  const outcomes: Baseline = {};
  // Populated per query by the beforeAll sweep; invariant + golden tests read it.
  const docHit1: Record<string, boolean> = {};

  beforeAll(async () => {
    setProviderForTests(stubProvider);
    vault = mkdtempSync(join(tmpdir(), "daftari-regression-"));
    cpSync(join(FIXTURE, "vault"), vault, { recursive: true });
    const reindexed = await reindexVault(vault);
    if (!reindexed.ok) throw reindexed.error;
    // Corpus validity: every doc indexed, none coerced. A silently-coerced
    // fixture makes every downstream number meaningless.
    expect(reindexed.value.skipped).toEqual([]);
    expect(reindexed.value.invalidFrontmatter).toEqual([]);
    expect(reindexed.value.documentCount).toBe(100);
    const opened = openIndexDb(vault, STUB_DIM);
    if (!opened.ok) throw opened.error;
    db = opened.value;

    for (const q of queries) {
      const arms: Record<string, { hit1: boolean; hit5: boolean }> = {};
      for (const granularity of ["document", "chunk"] as const) {
        const res = await hybridSearch(db, q.query, {
          limit: 5,
          weights: LEX,
          lexicalGranularity: granularity,
        });
        if (!res.ok) throw res.error;
        // Lexical purity: a vector-touching lexical gate is a broken gate.
        expect(res.value.vectorUsed).toBe(false);
        const hits = res.value.hits;
        arms[granularity] = {
          hit1: hits[0]?.path === q.relevantPath,
          hit5: hits.slice(0, 5).some((h) => h.path === q.relevantPath),
        };
      }
      docHit1[q.id] = arms.document.hit1;
      outcomes[q.id] = {
        type: q.type,
        docHit1: arms.document.hit1,
        docHit5: arms.document.hit5,
        chunkHit1: arms.chunk.hit1,
        chunkHit5: arms.chunk.hit5,
      };
    }
  }, 120_000);

  afterAll(() => {
    db?.close();
    if (vault) rmSync(vault, { recursive: true, force: true });
    resetProviderForTests();
  });

  it("validity invariant: the document arm finds every field-isolated token at hit@1", () => {
    // The document arm indexes title+tags+body, so a miss means the corpus or
    // ground truth is broken (prefix collision, tokenization) — numbers invalid.
    const misses = queries.filter((q) => !docHit1[q.id]).map((q) => q.id);
    expect(misses).toEqual([]);
  });

  it("goldens: per-query hit@1/hit@5 under both granularities match baselines/retrieval.json", () => {
    expect(Object.keys(outcomes)).toHaveLength(300);
    expect(diffBaseline(BASELINE, outcomes)).toEqual([]);
  });
});
