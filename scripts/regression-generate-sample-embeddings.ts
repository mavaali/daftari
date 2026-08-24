// Regenerate the committed MiniLM vectors used by the #301 Tier-1 retrieval
// gate. This developer-only command may load/download the local model; the
// regression test itself only replays the resulting fixture.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EmbeddingProvider } from "../src/search/embedding-provider.js";
import {
  LOCAL_MINILM_DIM,
  LOCAL_MINILM_ID,
  localMinilmProvider,
} from "../src/search/providers/local-minilm.js";
import { reindexVault } from "../src/search/reindex.js";
import { resetProviderForTests, setProviderForTests } from "../src/search/vector.js";
import { embeddingToBlob, getAllChunks, openIndexDb } from "../src/storage/index-db.js";
import { sha256Hex } from "../src/utils/hash.js";
import {
  copyTrackedSampleVault,
  listTrackedSampleVaultFiles,
  SAMPLE_VAULT_FILES,
} from "../test/regression/helpers/sample-vault-fixture.js";

const root = resolve(import.meta.dirname, "..");
const sourceVault = join(root, "test/fixtures/sample-vault");
const questionsPath = join(root, "test/regression/fixtures/sample-vault-queries.jsonl");
const outputPath = join(root, "test/regression/fixtures/sample-vault-minilm-embeddings.json");
const vectors = new Map<string, string>();

function encode(vector: Float32Array): string {
  return embeddingToBlob(vector).toString("base64");
}

const recordingProvider: EmbeddingProvider = {
  id: LOCAL_MINILM_ID,
  dim: LOCAL_MINILM_DIM,
  warm: () => localMinilmProvider.warm(),
  async embed(texts, onProgress) {
    const result = await localMinilmProvider.embed(texts, onProgress);
    if (!result.ok) return result;
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const vector = result.value[i];
      if (text === undefined || vector === undefined)
        throw new Error("MiniLM result count mismatch");
      vectors.set(sha256Hex(text), encode(vector));
    }
    return result;
  },
};

const questions = readFileSync(questionsPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { id: string; query: string });
const vault = mkdtempSync(join(tmpdir(), "daftari-sample-embedding-fixture-"));

try {
  const tracked = listTrackedSampleVaultFiles(root);
  if (JSON.stringify(tracked) !== JSON.stringify([...SAMPLE_VAULT_FILES].sort())) {
    throw new Error("sample-vault tracked files differ from the frozen regression manifest");
  }
  copyTrackedSampleVault(sourceVault, vault);
  setProviderForTests(recordingProvider);
  const reindexed = await reindexVault(vault);
  if (!reindexed.ok) throw reindexed.error;
  const queryVectors = await recordingProvider.embed(questions.map(({ query }) => query));
  if (!queryVectors.ok) throw queryVectors.error;

  const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
  if (!opened.ok) throw opened.error;
  const usage = new Map<string, string[]>();
  try {
    for (const chunk of getAllChunks(opened.value, LOCAL_MINILM_ID, LOCAL_MINILM_DIM)) {
      const labels = usage.get(chunk.contentHash) ?? [];
      labels.push(`chunk:${chunk.path}#${chunk.chunkIndex}`);
      usage.set(chunk.contentHash, labels);
    }
  } finally {
    opened.value.close();
  }
  for (const question of questions) {
    const hash = sha256Hex(question.query);
    const labels = usage.get(hash) ?? [];
    labels.push(`query:${question.id}`);
    usage.set(hash, labels);
  }

  const sortedVectors = Object.fromEntries([...vectors].sort(([a], [b]) => a.localeCompare(b)));
  const sortedUsage = Object.fromEntries(
    [...usage]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hash, labels]) => [hash, [...labels].sort()]),
  );
  if (JSON.stringify(Object.keys(sortedVectors)) !== JSON.stringify(Object.keys(sortedUsage))) {
    throw new Error("recorded vector and usage hashes differ");
  }
  writeFileSync(
    outputPath,
    `${JSON.stringify(
      {
        formatVersion: 1,
        sourceProvider: LOCAL_MINILM_ID,
        dim: LOCAL_MINILM_DIM,
        vectors: sortedVectors,
        usage: sortedUsage,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${vectors.size} precomputed vectors to ${outputPath}`);
} finally {
  resetProviderForTests();
  rmSync(vault, { recursive: true, force: true });
}
