// ACL pushdown into the vector KNN scan.
// Spec: docs/superpowers/specs/2026-07-26-retrieval-fusion-overhaul-design.md,
// Decision 3.
//
// The bug this closes: `vecRanking` asked sqlite-vec for the K nearest chunks
// vault-wide and the readable-collection filter ran afterwards, in the tool
// handler. A role that can read a minority of collections could have its whole
// K budget consumed by unreadable chunks and post-filtered to near-nothing —
// the vector half of hybrid search going dark for exactly the users RBAC
// exists for. It is invisible in unrestricted benchmarks, so it gets a test
// that pins the restricted case directly.
//
// These tests never load an embedding model: vectors are written into the
// index by hand and `relatedSearch` reads them back, so the whole path runs
// offline and deterministically.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readableCollections } from "../../src/access/rbac.js";
import { ok, type Result } from "../../src/frontmatter/types.js";
import type { EmbeddingProvider } from "../../src/search/embedding-provider.js";
import { relatedSearch, setVecKnnK } from "../../src/search/hybrid.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import { reindexVault } from "../../src/search/reindex.js";
import {
  getProvider,
  resetProviderForTests,
  setProviderForTests,
} from "../../src/search/vector.js";
import {
  deleteDocument,
  hasEmbeddingVec,
  type IndexDb,
  type IndexedDocument,
  insertChunkRow,
  insertDocument,
  insertEmbedding,
  insertEmbeddingVec,
  openIndexDb,
  pruneStaleVecRows,
} from "../../src/storage/index-db.js";
import type { RoleConfig } from "../../src/utils/config.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const DIM = LOCAL_MINILM_DIM;

// A unit vector pointing mostly along `axis`, so "closeness" is controllable
// without a model: same axis ⇒ near, different axis ⇒ far.
function vec(axis: number): Float32Array {
  const v = new Float32Array(DIM);
  v[axis % DIM] = 1;
  return v;
}

function doc(path: string, collection: string): IndexedDocument {
  return {
    path,
    title: path,
    collection,
    domain: "accumulation",
    status: "canonical",
    confidence: "high",
    updated: "2026-05-01",
    tags: [],
    content: `body of ${path}`,
    tokens: ["body"],
    ttlDays: null,
    created: "2026-01-01",
    supersededBy: null,
  };
}

// Indexes one document with a single chunk whose vector is `axis`, mirroring
// it into embeddings_vec under the document's own collection.
function indexDoc(db: IndexDb, path: string, collection: string, axis: number, hash: string): void {
  const model = getProvider().id;
  insertDocument(db, doc(path, collection));
  insertChunkRow(db, { path, chunkIndex: 0, text: `body of ${path}`, contentHash: hash });
  insertEmbedding(db, hash, model, vec(axis), "2026-05-01", DIM);
  insertEmbeddingVec(db, hash, model, collection, vec(axis));
}

let vault: string;
let db: IndexDb;

beforeEach(() => {
  vault = makeTempVault();
  const opened = openIndexDb(vault, DIM);
  if (!opened.ok) throw opened.error;
  db = opened.value;
});

afterEach(() => {
  db.close();
  cleanupVault(vault);
});

describe("readableCollections", () => {
  const role = (read: string[]): RoleConfig => ({
    read,
    write: [],
    promote: false,
    ratify: false,
  });

  it("returns undefined for a wildcard reader — no filter needed", () => {
    expect(readableCollections(role(["*"]))).toBeUndefined();
  });

  it("returns the declared collections for a scoped role", () => {
    expect(readableCollections(role(["pricing", "notes"]))).toEqual(["pricing", "notes"]);
  });

  // The distinction that matters: [] means "reads nothing", undefined means
  // "no filter". Collapsing one into the other would hand the deny-all guest
  // an unfiltered vector scan.
  it("returns an empty list for the deny-all guest, NOT undefined", () => {
    expect(readableCollections(null)).toEqual([]);
  });
});

describe("vector KNN is constrained to readable collections", () => {
  // Source in `pricing`; one near neighbour in `pricing`, one near neighbour
  // in `secret`. A pricing-only reader must see the first and never the second.
  beforeEach(() => {
    indexDoc(db, "pricing/source.md", "pricing", 1, "h-source");
    indexDoc(db, "pricing/near.md", "pricing", 1, "h-near-readable");
    indexDoc(db, "secret/near.md", "secret", 1, "h-near-secret");
  });

  it("unfiltered (no access context) sees both collections", () => {
    const r = relatedSearch(db, "pricing/source.md", { overFetch: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const paths = r.value.hits.map((h) => h.path);
    expect(paths).toContain("pricing/near.md");
    expect(paths).toContain("secret/near.md");
  });

  // What pushdown promises is precisely this: no unreadable chunk contributes
  // a VECTOR score. It does not promise unreadable docs vanish from the
  // candidate set — the lexical half is unfiltered by design, and the tool
  // handler's canRead filter remains the authorization boundary covering it
  // (spec Decision 3). Asserting absence here would be asserting a contract
  // this layer never had.
  it("an unreadable collection contributes no vector score to a scoped reader", () => {
    const r = relatedSearch(db, "pricing/source.md", {
      overFetch: true,
      readableCollections: ["pricing"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byPath = new Map(r.value.hits.map((h) => [h.path, h]));
    expect(byPath.get("pricing/near.md")?.vectorScore).toBeGreaterThan(0);
    expect(byPath.get("secret/near.md")?.vectorScore ?? 0).toBe(0);
  });

  it("an empty allow-list yields no vector hits at all", () => {
    const r = relatedSearch(db, "pricing/source.md", {
      overFetch: true,
      readableCollections: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.vectorUsed).toBe(false);
  });
});

describe("K-budget starvation (the bug the pushdown fixes)", () => {
  // 80 unreadable near-neighbours — more than the fan-out this suite PINS to
  // 64 — plus one readable one. Pinning keeps the starvation arithmetic true
  // by construction regardless of the config default (256 since MAV-159).
  // Vault-wide, the scan's whole budget goes to `secret`, and a post-filter
  // leaves the reader with nothing. Constrained, the reader's own document
  // is found.
  beforeEach(() => {
    setVecKnnK(64);
    indexDoc(db, "pricing/source.md", "pricing", 1, "h-source");
    for (let i = 0; i < 80; i++) {
      indexDoc(db, `secret/noise-${i}.md`, "secret", 1, `h-noise-${i}`);
    }
    indexDoc(db, "pricing/needle.md", "pricing", 1, "h-needle");
  });

  afterEach(() => {
    setVecKnnK(256);
  });

  it("finds the readable needle that a vault-wide scan would starve out", () => {
    const constrained = relatedSearch(db, "pricing/source.md", {
      overFetch: true,
      readableCollections: ["pricing"],
    });
    expect(constrained.ok).toBe(true);
    if (!constrained.ok) return;
    const needle = constrained.value.hits.find((h) => h.path === "pricing/needle.md");
    expect(needle?.vectorScore).toBeGreaterThan(0);
    // Every doc carrying a vector score is one the reader may read. (Unreadable
    // docs can still appear via the unfiltered lexical half — see above.)
    const vectorScored = constrained.value.hits.filter((h) => h.vectorScore > 0);
    expect(vectorScored.length).toBeGreaterThan(0);
    expect(vectorScored.every((h) => h.collection === "pricing")).toBe(true);
  });
});

// The write side. A stub provider makes the real reindex path run offline, so
// the per-collection row logic is covered here rather than only in the
// model-dependent suites.
describe("reindex writes one vec row per (hash, collection)", () => {
  const stub: EmbeddingProvider = {
    id: "stub-acl",
    dim: DIM,
    async warm(): Promise<Result<void, Error>> {
      return ok(undefined);
    },
    // Deterministic and content-independent: identical text in two files
    // therefore shares a content hash AND a vector, which is exactly the
    // cross-collection duplicate case the partition key has to handle.
    async embed(texts: string[]): Promise<Result<Float32Array[], Error>> {
      return ok(texts.map(() => vec(1)));
    },
  };

  let writeVault: string;

  beforeEach(() => {
    writeVault = mkdtempSync(join(tmpdir(), "daftari-acl-"));
    mkdirSync(join(writeVault, "pricing"), { recursive: true });
    mkdirSync(join(writeVault, "secret"), { recursive: true });
    const body = (title: string) =>
      `---\ntitle: ${title}\ndomain: accumulation\nstatus: canonical\n` +
      `confidence: high\nprovenance: direct\ncreated: 2026-01-01\nupdated: 2026-05-01\n---\n\n` +
      "identical shared body text\n";
    writeFileSync(join(writeVault, "pricing", "a.md"), body("A"));
    // Byte-identical body in a DIFFERENT collection: one embeddings-cache row
    // (content-addressed), but it owes the vec table two rows.
    writeFileSync(join(writeVault, "secret", "b.md"), body("B"));
    setProviderForTests(stub);
  });

  afterEach(() => {
    resetProviderForTests();
    rmSync(writeVault, { recursive: true, force: true });
  });

  it("mirrors duplicate content into both collections", async () => {
    const result = await reindexVault(writeVault);
    expect(result.ok).toBe(true);

    const opened = openIndexDb(writeVault, DIM);
    if (!opened.ok) throw opened.error;
    try {
      const rows = opened.value
        .prepare("SELECT collection, COUNT(*) AS n FROM embeddings_vec GROUP BY collection")
        .all() as { collection: string; n: number }[];
      const byCollection = new Map(rows.map((r) => [r.collection, r.n]));
      // The cache deduped the embedding; the vec table did not dedupe the ACL.
      expect(byCollection.get("pricing") ?? 0).toBeGreaterThan(0);
      expect(byCollection.get("secret") ?? 0).toBeGreaterThan(0);
    } finally {
      opened.value.close();
    }
  });
});

// Regression for the review finding on #303: a document that changes
// collection keeps its chunk hashes, so nothing else notices. deleteDocument
// clears documents/chunks but not the vec mirror, and gcOrphanedEmbeddings
// asks only whether a hash is referenced by ANY chunk — which it still is,
// from the new collection. Without an explicit prune the old row survives
// every incremental edit until a full reindex, eating the KNN budget this
// change exists to protect.
describe("recategorizing a document does not leave a stale vec row", () => {
  it("drops the old collection's row and adds the new one", () => {
    const model = getProvider().id;
    const hash = "h-movable";
    insertDocument(db, doc("secret/movable.md", "secret"));
    insertChunkRow(db, {
      path: "secret/movable.md",
      chunkIndex: 0,
      text: "movable body",
      contentHash: hash,
    });
    insertEmbedding(db, hash, model, vec(1), "2026-05-01", DIM);
    insertEmbeddingVec(db, hash, model, "secret", vec(1));

    const collectionsFor = (h: string): string[] =>
      (
        db
          .prepare("SELECT collection FROM embeddings_vec WHERE content_hash = ? AND model = ?")
          .all(h, model) as { collection: string }[]
      )
        .map((r) => r.collection)
        .sort();

    expect(collectionsFor(hash)).toEqual(["secret"]);

    // The move, as the incremental path performs it: the document row is
    // replaced with one carrying the new collection, chunks are rewritten with
    // the SAME hash, then the vec mirror is reconciled.
    deleteDocument(db, "secret/movable.md");
    insertDocument(db, doc("secret/movable.md", "public"));
    insertChunkRow(db, {
      path: "secret/movable.md",
      chunkIndex: 0,
      text: "movable body",
      contentHash: hash,
    });
    pruneStaleVecRows(db, hash, model);
    if (!hasEmbeddingVec(db, hash, model, "public")) {
      insertEmbeddingVec(db, hash, model, "public", vec(1));
    }

    // The old row is gone, not merely shadowed.
    expect(collectionsFor(hash)).toEqual(["public"]);
  });

  it("keeps a collection's row when another document still justifies it", () => {
    const model = getProvider().id;
    const hash = "h-shared-move";
    // Two documents in different collections share the hash; only one moves.
    for (const collection of ["secret", "pricing"]) {
      insertDocument(db, doc(`${collection}/shared.md`, collection));
      insertChunkRow(db, {
        path: `${collection}/shared.md`,
        chunkIndex: 0,
        text: "shared body",
        contentHash: hash,
      });
      insertEmbeddingVec(db, hash, model, collection, vec(1));
    }
    insertEmbedding(db, hash, model, vec(1), "2026-05-01", DIM);

    // Move only the pricing one to public; `secret` is still justified by its
    // own document and must survive.
    deleteDocument(db, "pricing/shared.md");
    insertDocument(db, doc("pricing/shared.md", "public"));
    insertChunkRow(db, {
      path: "pricing/shared.md",
      chunkIndex: 0,
      text: "shared body",
      contentHash: hash,
    });
    pruneStaleVecRows(db, hash, model);
    if (!hasEmbeddingVec(db, hash, model, "public")) {
      insertEmbeddingVec(db, hash, model, "public", vec(1));
    }

    const collections = (
      db
        .prepare("SELECT collection FROM embeddings_vec WHERE content_hash = ? AND model = ?")
        .all(hash, model) as { collection: string }[]
    )
      .map((r) => r.collection)
      .sort();
    expect(collections).toEqual(["public", "secret"]);
  });
});

describe("cross-collection duplicate content gets one vec row per collection", () => {
  // Identical chunk text in two collections is one embeddings-cache row (it is
  // content-addressed) but must be two vec rows — a single row cannot carry
  // two ACL labels. If it were one row, whichever collection lost the race
  // would be invisible to its own readers.
  it("both collections' readers can reach their own copy", () => {
    const model = getProvider().id;
    const shared = "h-shared";
    insertDocument(db, doc("pricing/source.md", "pricing"));
    insertChunkRow(db, {
      path: "pricing/source.md",
      chunkIndex: 0,
      text: "shared",
      contentHash: "h-source",
    });
    insertEmbedding(db, "h-source", model, vec(1), "2026-05-01", DIM);
    insertEmbeddingVec(db, "h-source", model, "pricing", vec(1));

    for (const collection of ["pricing", "secret"]) {
      insertDocument(db, doc(`${collection}/dup.md`, collection));
      insertChunkRow(db, {
        path: `${collection}/dup.md`,
        chunkIndex: 0,
        text: "identical text",
        contentHash: shared,
      });
      insertEmbeddingVec(db, shared, model, collection, vec(1));
    }
    insertEmbedding(db, shared, model, vec(1), "2026-05-01", DIM);

    const pricing = relatedSearch(db, "pricing/source.md", {
      overFetch: true,
      readableCollections: ["pricing"],
    });
    expect(pricing.ok).toBe(true);
    if (!pricing.ok) return;
    expect(pricing.value.hits.map((h) => h.path)).toContain("pricing/dup.md");

    const secret = relatedSearch(db, "pricing/source.md", {
      overFetch: true,
      readableCollections: ["secret"],
    });
    expect(secret.ok).toBe(true);
    if (!secret.ok) return;
    expect(secret.value.hits.map((h) => h.path)).toContain("secret/dup.md");
  });
});
