import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ok, type Result } from "../../src/frontmatter/types.js";
import type { EmbeddingProvider } from "../../src/search/embedding-provider.js";
import type { CompiledFieldFilter } from "../../src/search/field-filters.js";
import { hybridSearch } from "../../src/search/hybrid.js";
import { resetProviderForTests, setProviderForTests } from "../../src/search/vector.js";
import { embeddingToBlob, type IndexDb, openIndexDb } from "../../src/storage/index-db.js";

const DOCUMENT_COUNT = 10_000;
const MATCHING_COUNT = 1_000;
const VECTOR_DIM = 384;
const WARM_RUNS = 5;
const MEASURED_RUNS = 20;
const P95_BUDGET_MS = 250;

const queryVector = new Float32Array(VECTOR_DIM);
queryVector[0] = 1;

const benchmarkProvider: EmbeddingProvider = {
  id: "indexed-fields-benchmark",
  dim: VECTOR_DIM,
  async warm(): Promise<Result<void, Error>> {
    return ok(undefined);
  },
  async embed(texts: string[]): Promise<Result<Float32Array[], Error>> {
    return ok(texts.map(() => queryVector));
  },
};

const filters: CompiledFieldFilter[] = [{ field: "priority", type: "number", op: "eq", value: 1 }];

// Timing is opt-in so ordinary CI proves correctness without converting a
// wall-clock measurement into a flaky gate. Run with:
// DAFTARI_PERF=1 npx vitest run test/search/indexed-fields-performance.test.ts
// Measured 2026-09-04 after adversarial remediation on Apple M4 Pro (arm64):
// 20 warmed runs, p95 156.62 ms.
describe.skipIf(process.env.DAFTARI_PERF !== "1")("indexed field search performance", () => {
  let vault: string;
  let db: IndexDb;

  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-indexed-fields-perf-"));
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    setProviderForTests(benchmarkProvider);
    const opened = openIndexDb(vault, VECTOR_DIM);
    if (!opened.ok) throw opened.error;
    db = opened.value;

    const insertDocument = db.prepare(
      `INSERT INTO documents
         (path, title, collection, domain, status, confidence, updated, tags, content, tokens,
          ttl_days, created, superseded_by, valid_from, valid_until)
       VALUES (?, ?, 'projects', 'accumulation', 'canonical', 'high', '2026-09-04', '[]', ?,
               '["benchmark"]', NULL, '2026-09-01', NULL, NULL, NULL)`,
    );
    const insertField = db.prepare(
      `INSERT INTO document_fields
         (path, field, kind, text_value, number_value, bool_value)
       VALUES (?, 'priority', 'number', NULL, ?, NULL)`,
    );
    const insertChunk = db.prepare(
      "INSERT INTO chunks (path, chunk_index, text, content_hash) VALUES (?, 0, ?, ?)",
    );
    const insertEmbedding = db.prepare(
      `INSERT INTO embeddings (content_hash, model, dim, embedding, created_at)
       VALUES (?, ?, ?, ?, '2026-09-04')`,
    );
    const vectorBlob = embeddingToBlob(queryVector);
    db.transaction(() => {
      for (let i = 0; i < DOCUMENT_COUNT; i++) {
        const path = `projects/benchmark-${i.toString().padStart(5, "0")}.md`;
        const content = `benchmark exact vector document ${i}`;
        const hash = `benchmark-hash-${i.toString().padStart(5, "0")}`;
        insertDocument.run(path, `Benchmark ${i}`, content);
        insertField.run(path, i < MATCHING_COUNT ? 1 : 0);
        insertChunk.run(path, content, hash);
        insertEmbedding.run(hash, benchmarkProvider.id, VECTOR_DIM, vectorBlob);
      }
    })();
  }, 60_000);

  afterAll(() => {
    db.close();
    resetProviderForTests();
    rmSync(vault, { recursive: true, force: true });
  });

  it("keeps a warmed 10%-selective exact filtered-vector query within the local p95 budget", async () => {
    const run = async (): Promise<number> => {
      const started = performance.now();
      const result = await hybridSearch(db, "benchmark", {
        weights: { bm25: 0, vector: 1 },
        filters,
        limit: 10,
      });
      const elapsed = performance.now() - started;
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      expect(result.value.vectorUsed).toBe(true);
      expect(result.value.hits).toHaveLength(10);
      expect(
        result.value.hits.every((hit) => Number(hit.path.slice(19, 24)) < MATCHING_COUNT),
      ).toBe(true);
      return elapsed;
    };

    for (let i = 0; i < WARM_RUNS; i++) await run();
    const timings: number[] = [];
    for (let i = 0; i < MEASURED_RUNS; i++) timings.push(await run());
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    console.info(
      `indexed-fields benchmark: docs=${DOCUMENT_COUNT} selectivity=10% runs=${MEASURED_RUNS} p95=${p95.toFixed(2)}ms`,
    );
    expect(p95).toBeLessThanOrEqual(P95_BUDGET_MS);
  }, 60_000);
});
