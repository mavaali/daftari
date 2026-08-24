// Tier 1 real-semantic retrieval gate for #301. Frozen questions target the
// stable sample vault through the shipped vault_search surface under lexical
// and default-fusion configurations. The fusion arm replays committed MiniLM
// vectors; CI never loads a model or touches the network.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { err, ok, type Result } from "../../../src/frontmatter/types.js";
import type { EmbeddingProvider } from "../../../src/search/embedding-provider.js";
import { reindexVault } from "../../../src/search/reindex.js";
import {
  meanOf,
  ndcgAtK,
  recallAtK,
  reciprocalRank,
} from "../../../src/search/retrieval-metrics.js";
import { resetProviderForTests, setProviderForTests } from "../../../src/search/vector.js";
import { getAllDocuments, type IndexDb, openIndexDb } from "../../../src/storage/index-db.js";
import { vaultSearch } from "../../../src/tools/search.js";
import { sha256Hex } from "../../../src/utils/hash.js";
import { type Baseline, diffBaseline } from "../helpers/baseline.js";

const FIXTURE = resolve("test/fixtures/sample-vault");
const QUESTIONS = resolve("test/regression/fixtures/sample-vault-queries.jsonl");
const EMBEDDINGS = resolve("test/regression/fixtures/sample-vault-minilm-embeddings.json");
const BASELINE = resolve("test/regression/baselines/sample-vault-retrieval.json");
const LEXICAL = { bm25: 1, vector: 0 };
const FUSION = { bm25: 0.8, vector: 0.2 };
const K_SHORT = 5;
const K_LONG = 10;
const TOLERANCE = 0;
const SOURCES = new Set(["questions_answered", "questions_raised", "curated"]);

interface GoldenQuery {
  id: string;
  source: "questions_answered" | "questions_raised" | "curated";
  query: string;
  relevantPaths: string[];
  rationale: string;
}

interface EmbeddingFixture {
  formatVersion: 1;
  sourceProvider: "local-minilm";
  dim: number;
  vectors: Record<string, string>;
  usage: Record<string, string[]>;
}

interface MetricSamples {
  recall5: (number | null)[];
  recall10: (number | null)[];
  rr: (number | null)[];
  ndcg10: (number | null)[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty, trimmed string`);
  }
  return value;
}

function parseQuestion(line: string, lineNumber: number): GoldenQuery {
  const raw = record(JSON.parse(line), `question line ${lineNumber}`);
  const id = nonEmptyString(raw.id, `question line ${lineNumber} id`);
  const source = nonEmptyString(raw.source, `question ${id} source`);
  if (!SOURCES.has(source)) throw new Error(`question ${id} has unknown source ${source}`);
  const query = nonEmptyString(raw.query, `question ${id} query`);
  const rationale = nonEmptyString(raw.rationale, `question ${id} rationale`);
  if (!Array.isArray(raw.relevantPaths) || raw.relevantPaths.length === 0) {
    throw new Error(`question ${id} relevantPaths must be a non-empty array`);
  }
  const relevantPaths = raw.relevantPaths.map((path, index) =>
    nonEmptyString(path, `question ${id} relevantPaths[${index}]`),
  );
  return { id, source: source as GoldenQuery["source"], query, relevantPaths, rationale };
}

function parseEmbeddingFixture(): EmbeddingFixture {
  const raw = record(JSON.parse(readFileSync(EMBEDDINGS, "utf8")), "embedding fixture");
  if (raw.formatVersion !== 1) throw new Error("embedding fixture formatVersion must be 1");
  if (raw.sourceProvider !== "local-minilm") {
    throw new Error("embedding fixture sourceProvider must be local-minilm");
  }
  if (!Number.isInteger(raw.dim) || (raw.dim as number) <= 0) {
    throw new Error("embedding fixture dim must be a positive integer");
  }
  const vectors = record(raw.vectors, "embedding fixture vectors");
  const usage = record(raw.usage, "embedding fixture usage");
  const vectorKeys = Object.keys(vectors).sort();
  if (
    vectorKeys.length === 0 ||
    JSON.stringify(vectorKeys) !== JSON.stringify(Object.keys(usage).sort())
  ) {
    throw new Error("embedding fixture vectors and usage must have the same non-empty hash set");
  }
  for (const hash of vectorKeys) {
    if (!/^[0-9a-f]{64}$/.test(hash) || typeof vectors[hash] !== "string") {
      throw new Error(`embedding fixture has invalid vector row ${hash}`);
    }
    const bytes = Buffer.from(vectors[hash], "base64");
    if (bytes.byteLength !== (raw.dim as number) * Float32Array.BYTES_PER_ELEMENT) {
      throw new Error(`embedding fixture vector ${hash} has the wrong byte length`);
    }
    const labels = usage[hash];
    if (
      !Array.isArray(labels) ||
      labels.length === 0 ||
      labels.some((label) => typeof label !== "string")
    ) {
      throw new Error(`embedding fixture usage ${hash} must be a non-empty string array`);
    }
  }
  return raw as unknown as EmbeddingFixture;
}

const questions = readFileSync(QUESTIONS, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line, index) => parseQuestion(line, index + 1));
const embeddingFixture = parseEmbeddingFixture();

const providerCalls = { warm: 0, embed: 0, inputs: 0 };
const usedVectorHashes = new Set<string>();
const fixtureProvider: EmbeddingProvider = {
  id: embeddingFixture.sourceProvider,
  dim: embeddingFixture.dim,
  async warm(): Promise<Result<void, Error>> {
    providerCalls.warm += 1;
    return err(new Error("the regression fixture provider must never be warmed"));
  },
  async embed(texts: string[]): Promise<Result<Float32Array[], Error>> {
    providerCalls.embed += 1;
    providerCalls.inputs += texts.length;
    const vectors: Float32Array[] = [];
    for (const text of texts) {
      const hash = sha256Hex(text);
      const encoded = embeddingFixture.vectors[hash];
      if (encoded === undefined) {
        return err(new Error(`precomputed embedding missing for input ${hash}`));
      }
      usedVectorHashes.add(hash);
      const bytes = Buffer.from(encoded, "base64");
      vectors.push(new Float32Array(bytes.buffer, bytes.byteOffset, embeddingFixture.dim).slice());
    }
    return ok(vectors);
  },
};

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
  const samples = { lexical: emptySamples(), fusion: emptySamples() };
  const fusionRankChanges: string[] = [];

  beforeAll(async () => {
    setProviderForTests(fixtureProvider);
    vault = mkdtempSync(resolve(tmpdir(), "daftari-sample-golden-"));
    cpSync(FIXTURE, vault, { recursive: true });
    const reindexed = await reindexVault(vault);
    if (!reindexed.ok) throw reindexed.error;
    expect(reindexed.value.documentCount).toBe(10);
    expect(reindexed.value.vectorEnabled).toBe(true);
    expect(reindexed.value.embeddedCount).toBeGreaterThan(0);
    expect(reindexed.value.skipped).toEqual([]);
    expect(reindexed.value.invalidFrontmatter.map(({ path }) => path)).toEqual([
      "_drafts/incomplete-note.md",
    ]);

    const opened = openIndexDb(vault, embeddingFixture.dim);
    if (!opened.ok) throw opened.error;
    db = opened.value;
    for (const document of getAllDocuments(db)) corpusPaths.add(document.path);

    for (const question of questions) {
      const perArm: Baseline[string] = {
        relevantPaths: question.relevantPaths.join(", "),
      };
      for (const [arm, weights] of [
        ["lexical", LEXICAL],
        ["fusion", FUSION],
      ] as const) {
        const embedsBefore = providerCalls.embed;
        const result = await vaultSearch(vault, {
          query: question.query,
          limit: K_LONG,
          weights,
        });
        if (!result.ok) throw result.error;
        expect(result.value.vectorUsed).toBe(arm === "fusion");
        expect(result.value.weights).toEqual(weights);
        if (arm === "lexical") expect(providerCalls.embed).toBe(embedsBefore);
        const ranked = result.value.hits.map(({ path }) => path);
        const recall5 = recallAtK(ranked, question.relevantPaths, K_SHORT);
        const recall10 = recallAtK(ranked, question.relevantPaths, K_LONG);
        const rr = reciprocalRank(ranked, question.relevantPaths);
        const ndcg10 = ndcgAtK(ranked, question.relevantPaths, K_LONG);
        samples[arm].recall5.push(recall5);
        samples[arm].recall10.push(recall10);
        samples[arm].rr.push(rr);
        samples[arm].ndcg10.push(ndcg10);
        perArm[`${arm}Ranks`] = relevantRanks(ranked, question.relevantPaths).join(", ");
        perArm[`${arm}Recall@${K_SHORT}`] = round6(recall5);
        perArm[`${arm}Recall@${K_LONG}`] = round6(recall10);
        perArm[`${arm}Mrr`] = round6(rr);
        perArm[`${arm}Ndcg@${K_LONG}`] = round6(ndcg10);
      }
      if (perArm.lexicalRanks !== perArm.fusionRanks) fusionRankChanges.push(question.id);
      actual[`query:${question.id}`] = perArm;
    }

    for (const arm of ["lexical", "fusion"] as const) {
      actual[`summary:${arm}`] = {
        questionCount: questions.length,
        tolerance: TOLERANCE,
        [`meanRecall@${K_SHORT}`]: round6(meanOf(samples[arm].recall5)),
        [`meanRecall@${K_LONG}`]: round6(meanOf(samples[arm].recall10)),
        mrr: round6(meanOf(samples[arm].rr)),
        [`meanNdcg@${K_LONG}`]: round6(meanOf(samples[arm].ndcg10)),
      };
    }
  }, 30_000);

  afterAll(() => {
    db?.close();
    if (vault) rmSync(vault, { recursive: true, force: true });
    resetProviderForTests();
  });

  it("freezes 20–50 normalized, explained questions whose answer paths exist", () => {
    expect(questions.length).toBeGreaterThanOrEqual(20);
    expect(questions.length).toBeLessThanOrEqual(50);
    const normalize = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
    expect(new Set(questions.map(({ id }) => normalize(id))).size).toBe(questions.length);
    expect(new Set(questions.map(({ query }) => normalize(query))).size).toBe(questions.length);
    for (const question of questions) {
      expect(SOURCES.has(question.source)).toBe(true);
      expect(new Set(question.relevantPaths.map(normalize)).size).toBe(
        question.relevantPaths.length,
      );
      for (const path of question.relevantPaths) expect(corpusPaths.has(path)).toBe(true);
    }
  });

  it("uses every committed vector without model warmup or fallback", () => {
    expect(providerCalls.warm).toBe(0);
    expect(providerCalls.embed).toBeGreaterThan(0);
    expect(providerCalls.inputs).toBeGreaterThan(questions.length);
    expect([...usedVectorHashes].sort()).toEqual(Object.keys(embeddingFixture.vectors).sort());
  });

  it("keeps the fusion arm behaviorally distinct from lexical retrieval", () => {
    expect(fusionRankChanges.length).toBeGreaterThan(0);
  });

  it("uses the Tier-1 deterministic tolerance of zero", () => {
    expect(TOLERANCE).toBe(0);
  });

  it("matches public-surface lexical/fusion ranks and aggregate metric goldens", () => {
    expect(diffBaseline(BASELINE, actual)).toEqual([]);
  });
});
