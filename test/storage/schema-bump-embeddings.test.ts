// The durable embedding cache must survive a SCHEMA_VERSION bump.
//
// `embeddings` is keyed on (content_hash, model, dim) — a content-addressed
// cache, not a projection of the `documents` schema. No column change to
// `documents` can invalidate a row in it, so dropping it on a bump means
// paying a hosted provider to regenerate vectors that were already correct.
// `embeddings_vec` is a different animal: a vec0 mirror, rebuilt from the
// cache by the next reindex at zero provider cost, so it stays in the drop
// list.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import {
  embeddingCount,
  type IndexDb,
  insertEmbedding,
  insertEmbeddingVec,
  openIndexDb,
  setMeta,
} from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const MODEL = "test-model-v1";
const CREATED_AT = "2026-07-26T00:00:00Z";

function sampleVector(): Float32Array {
  return Float32Array.from({ length: LOCAL_MINILM_DIM }, (_, i) => (i % 7) / 7);
}

function open(vault: string): IndexDb {
  const opened = openIndexDb(vault, LOCAL_MINILM_DIM, "float32");
  if (!opened.ok) throw opened.error;
  return opened.value;
}

// Rewrites the persisted schema_version so the next open takes the bump path.
// Cheaper and more honest than trying to reach the private SCHEMA_VERSION
// const: what matters is that `stored !== SCHEMA_VERSION`.
function simulateOlderSchema(vault: string): void {
  const db = open(vault);
  setMeta(db, "schema_version", "0");
  db.close();
}

function tableExists(db: IndexDb, name: string): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
    .get(name) as { n: number };
  return row.n > 0;
}

function vecRowCount(db: IndexDb): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM embeddings_vec").get() as { n: number };
  return row.n;
}

describe("schema bump", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("preserves durable embedding cache rows across a schema_version change", () => {
    const seed = open(vault);
    insertEmbedding(seed, "hash-a", MODEL, sampleVector(), CREATED_AT, LOCAL_MINILM_DIM);
    insertEmbedding(seed, "hash-b", MODEL, sampleVector(), CREATED_AT, LOCAL_MINILM_DIM);
    expect(embeddingCount(seed)).toBe(2);
    seed.close();

    simulateOlderSchema(vault);

    const reopened = open(vault);
    expect(embeddingCount(reopened)).toBe(2);
    reopened.close();
  });

  it("rebuilds embeddings_vec empty across a schema_version change", () => {
    const seed = open(vault);
    insertEmbedding(seed, "hash-a", MODEL, sampleVector(), CREATED_AT, LOCAL_MINILM_DIM);
    // `collection` is the vec0 partition key added by the retrieval-fusion
    // work (#303) so the KNN scan can pre-filter by readable collection.
    insertEmbeddingVec(seed, "hash-a", MODEL, "pricing", sampleVector());
    expect(vecRowCount(seed)).toBe(1);
    seed.close();

    simulateOlderSchema(vault);

    const reopened = open(vault);
    expect(tableExists(reopened, "embeddings_vec")).toBe(true);
    expect(vecRowCount(reopened)).toBe(0);
    reopened.close();
  });

  it("still drops the derived document tables across a schema_version change", () => {
    const seed = open(vault);
    insertEmbedding(seed, "hash-a", MODEL, sampleVector(), CREATED_AT, LOCAL_MINILM_DIM);
    seed.close();

    simulateOlderSchema(vault);

    const reopened = open(vault);
    // The cache exemption must not turn into a general "stop dropping things":
    // `documents` is a projection of the markdown files and is still rebuilt.
    const docs = reopened.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number };
    expect(docs.n).toBe(0);
    reopened.close();
  });
});
