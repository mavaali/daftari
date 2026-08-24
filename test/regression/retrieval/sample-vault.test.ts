// Tier 1 real-semantic retrieval gate for #301. The frozen questions target
// the stable sample vault and are scored under both shipped lexical
// granularities. Hermetic by construction: lexical-only reindex, no provider
// warmup, no model download, no network, and exact (zero-tolerance) goldens.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hybridSearch } from "../../../src/search/hybrid.js";
import { reindexVault } from "../../../src/search/reindex.js";
import {
  meanOf,
  ndcgAtK,
  recallAtK,
  reciprocalRank,
} from "../../../src/search/retrieval-metrics.js";
import { getProvider } from "../../../src/search/vector.js";
import { getAllDocuments, type IndexDb, openIndexDb } from "../../../src/storage/index-db.js";
import { type Baseline, diffBaseline } from "../helpers/baseline.js";

const FIXTURE = resolve("test/fixtures/sample-vault");
const QUESTIONS = resolve("test/regression/fixtures/sample-vault-queries.jsonl");
const BASELINE = resolve("test/regression/baselines/sample-vault-retrieval.json");
const LEXICAL = { bm25: 1, vector: 0 };
const K_SHORT = 5;
const K_LONG = 10;
const TOLERANCE = 0;

interface GoldenQuery {
  id: string;
  source: "questions_answered" | "questions_raised" | "curated";
  query: string;
  relevantPaths: string[];
  rationale: string;
}

interface MetricSamples {
  recall5: (number | null)[];
  recall10: (number | null)[];
  rr: (number | null)[];
  ndcg10: (number | null)[];
}

const questions: GoldenQuery[] = readFileSync(QUESTIONS, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as GoldenQuery);

function round6(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1e6) / 1e6;
}

function relevantRanks(ranked: string[], relevant: string[]): number[] {
  return relevant.map((path) => {
    const index = ranked.indexOf(path);
    return index === -1 ? 0 : index + 1;
  });
}

function emptySamples(): MetricSamples {
  return { recall5: [], recall10: [], rr: [], ndcg10: [] };
}

describe("retrieval regression (real-semantic sample vault)", () => {
  let vault: string;
  let db: IndexDb;
  const actual: Baseline = {};
  const corpusPaths = new Set<string>();
  const samples = { document: emptySamples(), chunk: emptySamples() };

  beforeAll(async () => {
    vault = mkdtempSync(join(tmpdir(), "daftari-sample-golden-"));
    cpSync(FIXTURE, vault, { recursive: true });
    const reindexed = await reindexVault(vault, { lexicalOnly: true });
    if (!reindexed.ok) throw reindexed.error;
    expect(reindexed.value.documentCount).toBe(10);
    expect(reindexed.value.vectorEnabled).toBe(false);
    expect(reindexed.value.embeddedCount).toBe(0);
    expect(reindexed.value.skipped).toEqual([]);
    expect(reindexed.value.invalidFrontmatter.map(({ path }) => path)).toEqual([
      "_drafts/incomplete-note.md",
    ]);

    const opened = openIndexDb(vault, getProvider().dim);
    if (!opened.ok) throw opened.error;
    db = opened.value;
    for (const document of getAllDocuments(db)) corpusPaths.add(document.path);

    for (const question of questions) {
      const perArm: Baseline[string] = {
        relevantPaths: question.relevantPaths,
      };
      for (const granularity of ["document", "chunk"] as const) {
        const result = await hybridSearch(db, question.query, {
          limit: K_LONG,
          weights: LEXICAL,
          lexicalGranularity: granularity,
        });
        if (!result.ok) throw result.error;
        expect(result.value.vectorUsed).toBe(false);
        const ranked = result.value.hits.map(({ path }) => path);
        const recall5 = recallAtK(ranked, question.relevantPaths, K_SHORT);
        const recall10 = recallAtK(ranked, question.relevantPaths, K_LONG);
        const rr = reciprocalRank(ranked, question.relevantPaths);
        const ndcg10 = ndcgAtK(ranked, question.relevantPaths, K_LONG);
        samples[granularity].recall5.push(recall5);
        samples[granularity].recall10.push(recall10);
        samples[granularity].rr.push(rr);
        samples[granularity].ndcg10.push(ndcg10);
        perArm[`${granularity}Ranks`] = relevantRanks(ranked, question.relevantPaths);
        perArm[`${granularity}Recall@${K_SHORT}`] = round6(recall5);
        perArm[`${granularity}Recall@${K_LONG}`] = round6(recall10);
        perArm[`${granularity}Mrr`] = round6(rr);
        perArm[`${granularity}Ndcg@${K_LONG}`] = round6(ndcg10);
      }
      actual[`query:${question.id}`] = perArm;
    }

    for (const granularity of ["document", "chunk"] as const) {
      actual[`summary:${granularity}`] = {
        questionCount: questions.length,
        tolerance: TOLERANCE,
        [`meanRecall@${K_SHORT}`]: round6(meanOf(samples[granularity].recall5)),
        [`meanRecall@${K_LONG}`]: round6(meanOf(samples[granularity].recall10)),
        mrr: round6(meanOf(samples[granularity].rr)),
        [`meanNdcg@${K_LONG}`]: round6(meanOf(samples[granularity].ndcg10)),
      };
    }
  }, 30_000);

  afterAll(() => {
    db?.close();
    if (vault) rmSync(vault, { recursive: true, force: true });
  });

  it("freezes 20–50 unique, explained questions whose answer paths exist", () => {
    expect(questions.length).toBeGreaterThanOrEqual(20);
    expect(questions.length).toBeLessThanOrEqual(50);
    expect(new Set(questions.map(({ id }) => id)).size).toBe(questions.length);
    for (const question of questions) {
      expect(question.query.trim().length).toBeGreaterThan(0);
      expect(question.rationale.trim().length).toBeGreaterThan(0);
      expect(question.relevantPaths.length).toBeGreaterThan(0);
      for (const path of question.relevantPaths) expect(corpusPaths.has(path)).toBe(true);
    }
  });

  it("uses the Tier-1 deterministic tolerance of zero", () => {
    expect(TOLERANCE).toBe(0);
  });

  it("matches per-query ranks and aggregate recall/MRR/nDCG@10 goldens", () => {
    expect(diffBaseline(BASELINE, actual)).toEqual([]);
  });
});
