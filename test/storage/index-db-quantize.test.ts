// int8 vec-index quantization coverage (spec 2026-07-26-embedding-refresh-
// quantization, Phase 3a). Separate file from index-db.test.ts (that file's
// shared beforeEach opens at "float32" — these tests need their own
// kind-varying opens).

import { afterEach, describe, expect, it } from "vitest";
import {
  getMeta,
  type IndexDb,
  insertEmbedding,
  insertEmbeddingVec,
  openIndexDb,
  quantizeInt8,
} from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const MODEL = "test-model-v1";
const COLLECTION = "notes";

describe("quantizeInt8", () => {
  it("rounds unit-range components to the nearest int8, clamped to [-127, 127]", () => {
    const buf = quantizeInt8(new Float32Array([1, -1, 0, 0.5, -0.5]));
    const view = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    // Math.round rounds .5 toward +Infinity (JS semantics), so 0.5*127=63.5
    // rounds to 64 but -0.5*127=-63.5 rounds to -63, not -64.
    expect([...view]).toEqual([127, -127, 0, 64, -63]);
  });

  it("clamps a value whose scaled magnitude would exceed the int8 range", () => {
    // L2-normalized vectors never exceed [-1, 1] per-component, but the
    // function itself is defense-in-depth clamped regardless of input.
    const buf = quantizeInt8(new Float32Array([2, -2]));
    const view = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    expect([...view]).toEqual([127, -127]);
  });

  it("produces a buffer of exactly vec.length bytes", () => {
    const buf = quantizeInt8(new Float32Array(512));
    expect(buf.byteLength).toBe(512);
  });
});

describe("openIndexDb — kind coherence", () => {
  let vault: string;
  let db: IndexDb | null = null;

  afterEach(() => {
    db?.close();
    db = null;
    if (vault) cleanupVault(vault);
  });

  it("createVecTable at kind='int8' persists VEC_KIND_META_KEY and accepts int8-width inserts", () => {
    vault = makeTempVault();
    const opened = openIndexDb(vault, 4, "int8");
    if (!opened.ok) throw opened.error;
    db = opened.value;
    expect(getMeta(db, "embeddings_vec_kind")).toBe("int8");

    const vec = new Float32Array([1, 0, 0, 0]);
    insertEmbeddingVec(db, "h1", MODEL, COLLECTION, vec, "int8");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM embeddings_vec").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("a kind flip (float32 -> int8) on an unchanged dim drops and recreates the vec table", () => {
    vault = makeTempVault();
    let opened = openIndexDb(vault, 4, "float32");
    if (!opened.ok) throw opened.error;
    db = opened.value;
    expect(getMeta(db, "embeddings_vec_kind")).toBe("float32");
    insertEmbeddingVec(db, "h1", MODEL, COLLECTION, new Float32Array([1, 0, 0, 0]), "float32");
    expect((db.prepare("SELECT COUNT(*) AS n FROM embeddings_vec").get() as { n: number }).n).toBe(
      1,
    );

    db.close();
    opened = openIndexDb(vault, 4, "int8");
    if (!opened.ok) throw opened.error;
    db = opened.value;
    expect(getMeta(db, "embeddings_vec_kind")).toBe("int8");
    // The vec mirror is dropped and recreated — its rows are gone.
    expect((db.prepare("SELECT COUNT(*) AS n FROM embeddings_vec").get() as { n: number }).n).toBe(
      0,
    );

    // A new insert at the now-active int8 kind round-trips correctly.
    insertEmbeddingVec(db, "h2", MODEL, COLLECTION, new Float32Array([1, 0, 0, 0]), "int8");
    expect((db.prepare("SELECT COUNT(*) AS n FROM embeddings_vec").get() as { n: number }).n).toBe(
      1,
    );
  });

  it("the durable `embeddings` cache survives a kind flip (only the vec mirror is dropped)", () => {
    vault = makeTempVault();
    let opened = openIndexDb(vault, 4, "float32");
    if (!opened.ok) throw opened.error;
    db = opened.value;
    insertEmbedding(db, "h1", MODEL, new Float32Array([1, 0, 0, 0]), "2026-01-01", 4);

    db.close();
    opened = openIndexDb(vault, 4, "int8");
    if (!opened.ok) throw opened.error;
    db = opened.value;
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM embeddings WHERE content_hash = ?")
      .get("h1") as { n: number };
    expect(row.n).toBe(1); // durable cache untouched by the vec-mirror drop
  });

  it("leaves the vec table alone when both dim and kind persist unchanged", () => {
    vault = makeTempVault();
    let opened = openIndexDb(vault, 4, "int8");
    if (!opened.ok) throw opened.error;
    db = opened.value;
    insertEmbeddingVec(db, "h1", MODEL, COLLECTION, new Float32Array([1, 0, 0, 0]), "int8");

    db.close();
    opened = openIndexDb(vault, 4, "int8"); // same dim, same kind
    if (!opened.ok) throw opened.error;
    db = opened.value;
    expect((db.prepare("SELECT COUNT(*) AS n FROM embeddings_vec").get() as { n: number }).n).toBe(
      1,
    ); // untouched
  });

  it("a dim flip alone (kind unchanged) still drops and recreates, same as before this PR", () => {
    vault = makeTempVault();
    let opened = openIndexDb(vault, 4, "int8");
    if (!opened.ok) throw opened.error;
    db = opened.value;
    insertEmbeddingVec(db, "h1", MODEL, COLLECTION, new Float32Array([1, 0, 0, 0]), "int8");

    db.close();
    opened = openIndexDb(vault, 8, "int8"); // dim changes, kind stays
    if (!opened.ok) throw opened.error;
    db = opened.value;
    expect((db.prepare("SELECT COUNT(*) AS n FROM embeddings_vec").get() as { n: number }).n).toBe(
      0,
    );
  });
});

describe("int8 vec table — KNN ordering matches float32 up to quantization error", () => {
  let vault: string;
  let db: IndexDb;

  afterEach(() => {
    db.close();
    cleanupVault(vault);
  });

  it("ranks int8-quantized vectors by cosine distance consistently with their float32 originals", () => {
    vault = makeTempVault();
    const opened = openIndexDb(vault, 4, "int8");
    if (!opened.ok) throw opened.error;
    db = opened.value;

    const v1 = new Float32Array([1, 0, 0, 0]);
    const v2 = new Float32Array([0, 1, 0, 0]);
    const v3 = new Float32Array([0.9, Math.sqrt(1 - 0.81), 0, 0]); // unit, near v1

    insertEmbeddingVec(db, "h1", MODEL, COLLECTION, v1, "int8");
    insertEmbeddingVec(db, "h2", MODEL, COLLECTION, v2, "int8");
    insertEmbeddingVec(db, "h3", MODEL, COLLECTION, v3, "int8");

    const queryBlob = quantizeInt8(v1);
    const rows = db
      .prepare(
        `SELECT content_hash, distance
           FROM embeddings_vec
          WHERE embedding MATCH vec_int8(?) AND model = ? AND k = ?
          ORDER BY distance`,
      )
      .all(queryBlob, MODEL, 3) as { content_hash: string; distance: number }[];
    expect(rows.map((r) => r.content_hash)).toEqual(["h1", "h3", "h2"]);
  });
});
