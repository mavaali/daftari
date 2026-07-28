// Embedding-refresh A/B/C/D bench (spec 2026-07-26-embedding-refresh-
// quantization-design.md, Phase 5, as revised by the resolved final plan at
// .jugalbandi/embedding-refresh-quantization/final-plan.md). Cloned from
// chunkbm25-runner.mjs / fusion-runner.mjs's pattern: top-of-file constants,
// dist/ dynamic imports, --smoke, JSON outputs.
//
// Arms:
//   A: local-minilm, 384d, float32                          — today's shipped default
//   B: local-embeddinggemma@512, float32, quantize: none     — model gain at comparable scale
//   C: local-embeddinggemma@512, int8 + rescore              — what would actually ship
//   D: local-qwen3-0.6b@512, vector-only metrics, ALWAYS run — Qwen3 user-selectability gate
//
// Gates, in order of severity (final plan Phase 5):
//   - C >= A on recall@10                          — ship gate (kill condition 2 fires here)
//   - |C - B| <= 1pp at every K                     — quantize/rescore bug detector
//   - B vs A reported ungated                       — the headline model-generation number
//   - D not pathologically worse than A             — gates Qwen3's user-selectability
//
// Doc-doc smoke (disposition C6): for a fixed ~50-doc sample, mean-embedding
// nearest neighbors under arms A and B; top-10 neighbor overlap plus this
// script's own overlap number stands in for the "brief qualitative spot-
// check" a human reviews in the results doc — this script cannot write
// prose commentary, only the numbers a human reads before writing it.
//
// One vault, provider-switched per arm (final plan Phase 4's own migration
// story: config change + reindexVault). The durable `embeddings` cache is
// keyed by (content_hash, model), so each arm's reindex populates its own
// row set without disturbing the others — a re-run after the first is all
// cache hits for every arm except a genuinely new model id.
//
// NOT RUN as part of implementing this scaffolding: arms B/C/D require
// downloading real ONNX weights (EmbeddingGemma ~600MB q8, Qwen3 ~1.5GB) and
// a machine-local QFILE fixture this repo does not commit (same convention
// as chunkbm25-runner.mjs / fusion-runner.mjs) — neither is available in the
// environment that wrote this file. Do not treat the presence of this
// script as evidence the spec's Phase 0 spike or Phase 5 measurement have
// happened; they have not. See the governing spec's kill conditions before
// running this for real, and DO NOT flip any default off its output without
// a human reviewing the results doc this script's output feeds.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const QFILE = `${ROOT}/integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl`;
const VAULT = "/tmp/embedrefresh-recall/vault";
const OUT = "/tmp/embedrefresh-recall";
const SMOKE = process.argv.includes("--smoke");
const SMOKE_CAP = 25;
const KS = [10, 20, 50];
const LIMIT = 50;
const DOC_DOC_SAMPLE_SIZE = 50;
const DOC_DOC_TOP_K = 10;
const DOC_DOC_SEED = 20260726;

// Ship / bug-detector / non-pathological gate thresholds. Recorded here so
// a human reviewing a real run's output sees exactly what was checked; the
// spec explicitly permits the flip review to revise these in writing with
// measurements in hand (final plan, C7 disposition, same posture applied
// here to the recall gates).
const GATE_QUANTIZE_BUG_PP = 0.01; // |C - B| <= 1pp at every K
const GATE_D_PATHOLOGICAL_DROP_PP = 0.1; // D vs A drop > 10pp at K=10 is "pathological"

const { hybridSearch } = await import(`${ROOT}/dist/search/hybrid.js`);
const { cosineSimilarity, meanEmbedding, setProvider, getProvider, toIndexDim } = await import(
  `${ROOT}/dist/search/vector.js`
);
const { openIndexForActiveProvider } = await import(`${ROOT}/dist/tools/search.js`);
const { getAllDocuments, getChunksForPath } = await import(`${ROOT}/dist/storage/index-db.js`);
const { reindexVault } = await import(`${ROOT}/dist/search/reindex.js`);

function openVault(path) {
  const r = openIndexForActiveProvider(path);
  if (!r.ok) {
    console.error(`open ${path} failed:`, r.error.message);
    process.exit(1);
  }
  return r.value;
}

function mulberry32(seed) {
  let s = seed | 0;
  return function rng() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledIndices(n, rng) {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

const dayOf = (p) => {
  const m = /day-(\d+)/.exec(p || "");
  return m ? Number(m[1]) : null;
};
const recall = (got, rel) =>
  rel.length ? rel.filter((d) => got.includes(d)).length / rel.length : null;
const daysAtK = (hits, K) => [
  ...new Set(
    hits
      .slice(0, K)
      .map((h) => dayOf(h.path))
      .filter((d) => d !== null),
  ),
];

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function retrieve(db, q, opts) {
  const res = await hybridSearch(db, q, opts);
  if (!res.ok) throw new Error(`hybridSearch failed for "${q}": ${res.error.message}`);
  return res.value;
}

function loadQuestions() {
  if (!existsSync(QFILE)) {
    console.error(
      `QFILE missing: ${QFILE}\n` +
        "(machine-local fixture, same convention as chunkbm25-runner.mjs / " +
        "fusion-runner.mjs — not committed; third-party corpus.)",
    );
    process.exit(1);
  }
  const recs = readFileSync(QFILE, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  return recs.map((r) => ({ question: r.qa.question, relevantDays: r.qa.relevantDays || [] }));
}

// ---------------------------------------------------------------------------
// Per-arm provider configuration. `setup` mutates the active provider (and
// triggers a reindex — the actual migration path Phase 3d makes real) so
// the SAME vault directory carries every arm's row set, keyed by model id.
// ---------------------------------------------------------------------------
const ARMS = {
  A: {
    label: "local-minilm 384d float32 (today's default)",
    async setup() {
      setProvider("local-minilm");
    },
  },
  B: {
    label: "local-embeddinggemma@512 float32 (quantize: none)",
    async setup() {
      setProvider("local-embeddinggemma", { dim: 512, quantize: "none" });
    },
  },
  C: {
    label: "local-embeddinggemma@512 int8 + rescore (proposed default)",
    async setup() {
      setProvider("local-embeddinggemma", { dim: 512, quantize: "int8" });
    },
  },
  D: {
    label: "local-qwen3-0.6b@512, vector-only metrics, always run",
    async setup() {
      setProvider("local-qwen3-0.6b", { dim: 512, quantize: "int8" });
    },
  },
};

async function reindexForArm(armId) {
  await ARMS[armId].setup();
  const result = await reindexVault(VAULT);
  if (!result.ok) throw new Error(`[arm ${armId}] reindex failed: ${result.error.message}`);
  console.log(
    `[arm ${armId}] ${ARMS[armId].label}: ${result.value.documentCount} docs, ` +
      `${result.value.embeddedCount} embedded, ${result.value.cacheHits} cache hits`,
  );
  return result.value;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------
function meanAt(rows, arm, K) {
  const v = rows.map((r) => r[arm]?.[K]).filter((x) => x != null);
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4) : null;
}
function curve(rows, arm) {
  return Object.fromEntries(KS.map((K) => [K, meanAt(rows, arm, K)]));
}

// ---------------------------------------------------------------------------
// Doc-doc smoke (disposition C6): relatedSearch-style mean-embedding nearest
// neighbors, arms A vs B. Uses meanEmbedding + cosineSimilarity directly
// (not relatedSearch itself) so the comparison is symmetric across the two
// otherwise-fusion-free vector-only neighbor sets.
// ---------------------------------------------------------------------------
async function docDocNeighbors(db, provider, sampleDocs) {
  const vectorsByPath = new Map();
  for (const doc of sampleDocs) {
    const chunks = getChunksForPath(db, doc.path, provider.id, provider.nativeDim ?? provider.dim)
      .map((c) => c.embedding)
      .filter((e) => e !== null)
      .map((e) => toIndexDim(e, provider.dim));
    const mean = meanEmbedding(chunks);
    if (mean) vectorsByPath.set(doc.path, mean);
  }
  const paths = [...vectorsByPath.keys()];
  const neighbors = new Map();
  for (const p of paths) {
    const v = vectorsByPath.get(p);
    const scored = paths
      .filter((q) => q !== p)
      .map((q) => ({ path: q, sim: cosineSimilarity(v, vectorsByPath.get(q)) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, DOC_DOC_TOP_K)
      .map((r) => r.path);
    neighbors.set(p, scored);
  }
  return neighbors;
}

function neighborOverlap(a, b) {
  const overlaps = [];
  for (const [path, neighborsA] of a) {
    const neighborsB = b.get(path);
    if (!neighborsB) continue;
    const setB = new Set(neighborsB);
    const shared = neighborsA.filter((n) => setB.has(n)).length;
    overlaps.push(shared / DOC_DOC_TOP_K);
  }
  return overlaps.length
    ? +(overlaps.reduce((s, x) => s + x, 0) / overlaps.length).toFixed(4)
    : null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  mkdirSync(OUT, { recursive: true });
  const questions = loadQuestions();
  const cases = SMOKE ? questions.slice(0, SMOKE_CAP) : questions;
  console.log(`questions: ${cases.length}${SMOKE ? " (smoke)" : ""}`);

  // ---- Arms A / B / C: hybrid + vector-only recall ----
  const perQ = [];
  for (const armId of ["A", "B", "C"]) {
    await reindexForArm(armId);
    const db = openVault(VAULT);
    for (const q of cases) {
      let row = perQ.find((r) => r.question === q.question);
      if (!row) {
        row = { question: q.question, rel: q.relevantDays, hybrid: {}, vectorOnly: {} };
        perQ.push(row);
      }
      const hybrid = await retrieve(db, q.question, {
        limit: LIMIT,
        weights: { bm25: 0.5, vector: 0.5 },
      });
      const vectorOnly = await retrieve(db, q.question, {
        limit: LIMIT,
        weights: { bm25: 0, vector: 1 },
      });
      row.hybrid[armId] = {};
      row.vectorOnly[armId] = {};
      for (const K of KS) {
        row.hybrid[armId][K] = recall(daysAtK(hybrid.hits, K), q.relevantDays);
        row.vectorOnly[armId][K] = recall(daysAtK(vectorOnly.hits, K), q.relevantDays);
      }
    }
    db.close();
  }

  const hybridCurves = Object.fromEntries(
    ["A", "B", "C"].map((arm) => [
      arm,
      curve(
        perQ.map((r) => ({ [arm]: r.hybrid[arm] })),
        arm,
      ),
    ]),
  );
  const vectorOnlyCurves = Object.fromEntries(
    ["A", "B", "C"].map((arm) => [
      arm,
      curve(
        perQ.map((r) => ({ [arm]: r.vectorOnly[arm] })),
        arm,
      ),
    ]),
  );

  // ---- Arm D: vector-only metrics only, always run, never gates the flip ----
  await reindexForArm("D");
  const dbD = openVault(VAULT);
  const dPerQ = [];
  for (const q of cases) {
    const vectorOnly = await retrieve(dbD, q.question, {
      limit: LIMIT,
      weights: { bm25: 0, vector: 1 },
    });
    const row = { question: q.question, D: {} };
    for (const K of KS) row.D[K] = recall(daysAtK(vectorOnly.hits, K), q.relevantDays);
    dPerQ.push(row);
  }
  const dCurve = curve(dPerQ, "D");
  dbD.close();

  // ---- Gates ----
  const gates = {};
  gates.shipRecall10 = {
    description: "C >= A on recall@10 (kill condition 2 — default flip)",
    pass: (hybridCurves.C[10] ?? -1) >= (hybridCurves.A[10] ?? -1),
    a: hybridCurves.A[10],
    c: hybridCurves.C[10],
  };
  gates.quantizeBugDetector = {
    description: `|C - B| <= ${GATE_QUANTIZE_BUG_PP} at every K`,
    pass: KS.every((K) => {
      const b = hybridCurves.B[K];
      const c = hybridCurves.C[K];
      if (b == null || c == null) return true;
      return Math.abs(c - b) <= GATE_QUANTIZE_BUG_PP;
    }),
    deltas: Object.fromEntries(
      KS.map((K) => [
        K,
        hybridCurves.B[K] != null && hybridCurves.C[K] != null
          ? +(hybridCurves.C[K] - hybridCurves.B[K]).toFixed(4)
          : null,
      ]),
    ),
  };
  gates.headlineBvsA = {
    description: "B vs A — ungated, the measured size of the model-generation claim",
    delta10:
      hybridCurves.B[10] != null && hybridCurves.A[10] != null
        ? +(hybridCurves.B[10] - hybridCurves.A[10]).toFixed(4)
        : null,
  };
  gates.qwen3Selectable = {
    description: `D not pathologically worse than A (drop > ${GATE_D_PATHOLOGICAL_DROP_PP} at K=10 is pathological) — gates Qwen3's user-selectability, never the flip`,
    pass: (dCurve[10] ?? 0) >= (vectorOnlyCurves.A[10] ?? 0) - GATE_D_PATHOLOGICAL_DROP_PP,
    a: vectorOnlyCurves.A[10],
    d: dCurve[10],
  };

  // ---- Doc-doc smoke (C6) ----
  const dbSmoke = openVault(VAULT);
  const allDocs = getAllDocuments(dbSmoke);
  const rng = mulberry32(DOC_DOC_SEED);
  const order = shuffledIndices(allDocs.length, rng);
  const sample = order
    .slice(0, Math.min(DOC_DOC_SAMPLE_SIZE, allDocs.length))
    .map((i) => allDocs[i]);

  await reindexForArm("A");
  const neighborsA = await docDocNeighbors(dbSmoke, getProvider(), sample);
  await reindexForArm("B");
  const neighborsB = await docDocNeighbors(dbSmoke, getProvider(), sample);
  const docDocOverlap = neighborOverlap(neighborsA, neighborsB);
  dbSmoke.close();

  const docDoc = {
    sampleSize: sample.length,
    topK: DOC_DOC_TOP_K,
    meanTop10Overlap: docDocOverlap,
    note:
      "This is the tripwire for relatedSearch/vault_themes/edges — all consume the same " +
      "doc-embedded vectors. A low overlap means the model-generation jump changes the " +
      "document-similarity REGIME, not just query recall; the results doc must state this " +
      "residual risk explicitly (final plan, disposition C6) and PR-5's flip review must " +
      "cite it. This script does not judge whether the number is acceptable — a human does.",
  };

  const provenance = {
    questionsFileSha256: existsSync(QFILE) ? sha256Hex(readFileSync(QFILE)) : null,
    vaultListingSha256: sha256Hex(
      getAllDocuments(openVault(VAULT))
        .map((d) => d.path)
        .sort()
        .join("\n"),
    ),
    ran: {
      phase0Spike: false,
      realModelDownloads: false,
    },
  };

  const summary = {
    smoke: SMOKE,
    counts: { total: perQ.length },
    hybridRecall: hybridCurves,
    vectorOnlyRecall: vectorOnlyCurves,
    armD: { vectorOnlyRecall: dCurve },
    gates,
    docDoc,
    provenance,
  };

  writeFileSync(
    `${OUT}/embedrefresh-perq.json`,
    JSON.stringify({ ks: KS, smoke: SMOKE, perQ, dPerQ }, null, 2),
  );
  writeFileSync(`${OUT}/embedrefresh-summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

await main();
