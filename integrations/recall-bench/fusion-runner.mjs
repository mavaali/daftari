// Fusion overhaul A/B bench (spec 2026-07-26 fusion overhaul, Decisions 1/2/4
// as revised by the resolved final plan). Cloned from chunkbm25-runner.mjs's
// pattern: top-of-file constants, dist/ dynamic imports, --smoke, JSON
// outputs. Four arms:
//
//   A: hybridSearch(db, q, { limit: 50 })                         — weighted fusion, default weights
//   B: A + fusion: "rrf"                                          — RRF fusion, same weights
//   C: B + weights: routeWeights(classifyQuery(q).class)          — RRF + router
//   D: C's config on a restricted (RBAC) split vault, post- vs pushed-down
//      collection filtering — measures the ACL-pushdown fix (a2ec361) under
//      the new fusion.
//
// Question sets, three categories:
//   - paraphrase: the machine-local ea-180d-partial-2026-06-21 fixture
//     (same convention as chunkbm25-runner.mjs — third-party corpus,
//     provenance hash-recorded rather than committed).
//   - phrase: synthetic, seeded PRNG, from doc bodies — a corpus-unique
//     contiguous 2-3 token run, quoted. Bench mass for the extreme-lexical
//     route.
//   - identifier: synthetic, seeded PRNG, from doc bodies — a token whose
//     stem-aware df === 1. Bench mass for the rare-term signal.
//
// Do NOT run the full (non-smoke) bench without the machine-local QFILE and
// a prepped /tmp/fusion-recall/vault (via `prep-vault.mjs --out
// /tmp/fusion-recall/vault`) — see docs/superpowers/specs/2026-07-26-
// retrieval-fusion-overhaul-design.md and the resolved final plan.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const QFILE = `${ROOT}/integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl`;
const DAY_VAULT = "/tmp/fusion-recall/vault";
const SPLIT_VAULT = "/tmp/fusion-recall/split-vault";
const OUT = "/tmp/fusion-recall";
const SMOKE = process.argv.includes("--smoke");
const SMOKE_CAP = 25;
const KS = [10, 20, 50];
const LIMIT = 50;
const CATEGORIES = ["paraphrase", "phrase", "identifier"];

// Seeded PRNG (committed, deterministic) for the synthetic phrase/identifier
// question sets — same seed always produces the same question set from the
// same day vault.
const PHRASE_SEED = 20260726;
const IDENTIFIER_SEED = 20260727;
const SAMPLE_SIZE = 100;

// Arm D's restricted-role fixture (spec 2026-07-26 fusion, Decision 3 —
// the ACL-pushdown starvation-bug fix this arm measures under the new
// fusion). 8 collections, ~22-23 docs each; READABLE is the minority-read
// configuration where the starvation bug lived.
const NUM_COLLECTIONS = 8;
const READABLE = ["col-0", "col-1"];
const ALL_COLLECTIONS = Array.from({ length: NUM_COLLECTIONS }, (_, i) => `col-${i}`);

// Same K the vector KNN asks sqlite-vec for (src/search/hybrid.ts
// VEC_KNN_K) — used only to LABEL the no-leak comparison's boundary-tie
// heuristic in output; not read from source, so keep in sync by hand.
const VEC_KNN_K = 64;

const { hybridSearch } = await import(`${ROOT}/dist/search/hybrid.js`);
const { openIndexForActiveProvider } = await import(`${ROOT}/dist/tools/search.js`);
const { getAllDocuments, documentCount } = await import(`${ROOT}/dist/storage/index-db.js`);
const { tokenize } = await import(`${ROOT}/dist/search/bm25.js`);
const { classifyQuery, routeWeights, makeDfLookup } = await import(`${ROOT}/dist/search/router.js`);
const { reindexVault } = await import(`${ROOT}/dist/search/reindex.js`);

function openVault(path) {
  const r = openIndexForActiveProvider(path);
  if (!r.ok) {
    console.error(`open ${path} failed:`, r.error.message);
    process.exit(1);
  }
  return r.value;
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) + deterministic shuffle-sample
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Shared helpers (chunkbm25-runner.mjs convention)
// ---------------------------------------------------------------------------

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

// Split-vault collection assignment: day N -> col-{(N-1) % NUM_COLLECTIONS}.
// Shared by the split-vault builder AND the D-arm's readable-day filter so
// the two never disagree about which collection a day landed in.
const collectionOf = (day) => `col-${(day - 1) % NUM_COLLECTIONS}`;

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function retrieve(db, q, opts) {
  const res = await hybridSearch(db, q, opts);
  if (!res.ok) throw new Error(`hybridSearch failed for "${q}": ${res.error.message}`);
  return res.value;
}

// Per-arm, expectation-shaped vectorUsed assertion (final plan, C1 revision):
// a routed extreme-lexical query legitimately reports vectorUsed: false
// (weights.vector === 0 skips embedding entirely) — that must not abort the
// run. Any OTHER mismatch between the weights actually passed and what came
// back is a real embedding-path failure and aborts immediately.
function assertVectorUsedExpectation(arm, result, effectiveWeights, question) {
  const expected = effectiveWeights.vector > 0;
  if (result.vectorUsed !== expected) {
    throw new Error(
      `[arm ${arm}] vectorUsed=${result.vectorUsed} but weights=${JSON.stringify(effectiveWeights)} ` +
        `implies ${expected} for question: ${JSON.stringify(question)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Question sets
// ---------------------------------------------------------------------------

function loadParaphraseQuestions() {
  if (!existsSync(QFILE)) {
    console.error(
      `QFILE missing: ${QFILE}\n` +
        "(machine-local fixture, same convention as chunkbm25-runner.mjs — " +
        "not committed; third-party corpus.)",
    );
    process.exit(1);
  }
  const recs = readFileSync(QFILE, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  return recs.map((r) => ({
    category: "paraphrase",
    question: r.qa.question,
    relevantDays: r.qa.relevantDays || [],
  }));
}

// Synthetic "phrase" category (final plan, disposition C3): from each
// sampled doc's body, a contiguous run of 2-3 tokenize()-valid tokens,
// verified unique in the corpus (FTS5 phrase MATCH count === 1); the query
// is that run in double quotes. Classifies extreme-lexical by construction
// (quoted-phrase signal) — this is the extreme-lexical route's bench mass.
function buildPhraseQuestions(db, docs) {
  const rng = mulberry32(PHRASE_SEED);
  const order = shuffledIndices(docs.length, rng);
  const sample = order.slice(0, Math.min(SAMPLE_SIZE, docs.length));
  const questions = [];
  let skipped = 0;
  for (const i of sample) {
    const doc = docs[i];
    const day = dayOf(doc.path);
    const tokens = tokenize(doc.content);
    if (day === null || tokens.length < 2) {
      skipped++;
      continue;
    }
    let found = null;
    for (let attempt = 0; attempt < 20 && !found; attempt++) {
      const len = tokens.length >= 3 && rng() < 0.5 ? 3 : 2;
      if (tokens.length < len) continue;
      const start = Math.floor(rng() * (tokens.length - len + 1));
      const run = tokens.slice(start, start + len).join(" ");
      const n = db
        .prepare("SELECT count(*) AS n FROM documents_fts WHERE documents_fts MATCH ?")
        .get(`"${run}"`).n;
      if (n === 1) found = run;
    }
    if (found) {
      questions.push({ category: "phrase", question: `"${found}"`, relevantDays: [day] });
    } else {
      skipped++;
    }
  }
  return { questions, skipped };
}

// Synthetic "identifier" category (final plan, disposition C3/C8): from each
// sampled doc's body, a token whose stem-aware df === 1 (via the same
// MATCH-count lookup the router uses); the query is that token. Classifies
// lexical (rare-term signal) — relevant = own day is exact because df === 1.
function buildIdentifierQuestions(db, docs) {
  const rng = mulberry32(IDENTIFIER_SEED);
  const df = makeDfLookup(db);
  const order = shuffledIndices(docs.length, rng);
  const sample = order.slice(0, Math.min(SAMPLE_SIZE, docs.length));
  const questions = [];
  let skipped = 0;
  for (const i of sample) {
    const doc = docs[i];
    const day = dayOf(doc.path);
    if (day === null) {
      skipped++;
      continue;
    }
    const unique = [...new Set(tokenize(doc.content))];
    const tokenOrder = shuffledIndices(unique.length, rng).map((k) => unique[k]);
    const term = tokenOrder.find((t) => df(t) === 1);
    if (term) {
      questions.push({ category: "identifier", question: term, relevantDays: [day] });
    } else {
      skipped++;
    }
  }
  return { questions, skipped };
}

// ---------------------------------------------------------------------------
// Split-vault builder for arm D (final plan, C2 revision)
// ---------------------------------------------------------------------------
// Copies the day vault's SOURCE FILES (not the index — IndexedDocument.content
// is body-only, frontmatter already stripped) to SPLIT_VAULT, rewriting BOTH
// the path (notes/day-NNNN.md -> col-{N mod 8}/day-NNNN.md) AND the
// frontmatter `collection:` line (notes -> col-{N mod 8}) — frontmatter wins
// collection derivation (reindex.ts:311:
// `fm.collection || relPath.split("/")[0]`), so a path-only rewrite would
// leave every doc in "notes" and D would read nothing.
async function buildSplitVault(dayDocPaths) {
  const { mkdirSync: mk, writeFileSync: wf, readFileSync: rf, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  rmSync(SPLIT_VAULT, { recursive: true, force: true });
  for (const path of dayDocPaths) {
    const day = dayOf(path);
    if (day === null) continue;
    const col = collectionOf(day);
    const dir = join(SPLIT_VAULT, col);
    mk(dir, { recursive: true });
    const raw = rf(join(DAY_VAULT, path), "utf8");
    const rewritten = raw.replace(/^collection: notes$/m, `collection: ${col}`);
    wf(join(dir, `day-${String(day).padStart(4, "0")}.md`), rewritten);
  }
  const reindexed = await reindexVault(SPLIT_VAULT);
  if (!reindexed.ok) throw new Error(`split-vault reindex failed: ${reindexed.error.message}`);
  return reindexed.value;
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

function curvesByCategory(rows, arms) {
  const out = {};
  for (const cat of CATEGORIES) {
    const catRows = rows.filter((r) => r.category === cat);
    out[cat] = Object.fromEntries(arms.map((arm) => [arm, curve(catRows, arm)]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT, { recursive: true });

  const DAY = openVault(DAY_VAULT);
  const dayDocs = getAllDocuments(DAY);
  const dayDf = makeDfLookup(DAY);
  const dayDocCount = documentCount(DAY);
  console.log(`day vault: ${dayDocs.length} docs`);

  const paraphrase = loadParaphraseQuestions();
  const phrase = buildPhraseQuestions(DAY, dayDocs);
  const identifier = buildIdentifierQuestions(DAY, dayDocs);
  console.log(
    `questions: paraphrase=${paraphrase.length} ` +
      `phrase=${phrase.questions.length} (skipped ${phrase.skipped}) ` +
      `identifier=${identifier.questions.length} (skipped ${identifier.skipped})`,
  );

  const cap = (arr) => (SMOKE ? arr.slice(0, SMOKE_CAP) : arr);
  const allQuestions = [...cap(paraphrase), ...cap(phrase.questions), ...cap(identifier.questions)];

  // ---- Arms A / B / C over the day vault ----
  const perQ = [];
  for (const q of allQuestions) {
    const rel = q.relevantDays;
    const row = {
      id: q.question,
      category: q.category,
      relLen: rel.length,
      rel,
      A: {},
      B: {},
      C: {},
    };

    const a = await retrieve(DAY, q.question, { limit: LIMIT, fusion: "weighted" });
    assertVectorUsedExpectation("A", a, { bm25: 0.5, vector: 0.5 }, q.question);

    const b = await retrieve(DAY, q.question, { limit: LIMIT, fusion: "rrf" });
    assertVectorUsedExpectation("B", b, { bm25: 0.5, vector: 0.5 }, q.question);

    const classified = classifyQuery(q.question, { df: dayDf, docCount: dayDocCount });
    const cWeights = routeWeights(classified.class);
    const c = await retrieve(DAY, q.question, { limit: LIMIT, fusion: "rrf", weights: cWeights });
    assertVectorUsedExpectation("C", c, cWeights, q.question);
    row.routedClass = classified.class;
    row.routedSignals = classified.signals;

    for (const K of KS) {
      row.A[K] = recall(daysAtK(a.hits, K), rel);
      row.B[K] = recall(daysAtK(b.hits, K), rel);
      row.C[K] = recall(daysAtK(c.hits, K), rel);
    }
    perQ.push(row);
  }

  const overall = { A: curve(perQ, "A"), B: curve(perQ, "B"), C: curve(perQ, "C") };
  const byCat = curvesByCategory(perQ, ["A", "B", "C"]);
  const byRouteClass = {};
  for (const cls of ["extreme-lexical", "lexical", "balanced"]) {
    const rows = perQ.filter((r) => r.routedClass === cls);
    byRouteClass[cls] = {
      count: rows.length,
      A: curve(rows, "A"),
      B: curve(rows, "B"),
      C: curve(rows, "C"),
    };
  }

  function categoryNoRegression(armFrom, armTo, threshold) {
    for (const cat of CATEGORIES) {
      for (const K of KS) {
        const from = byCat[cat][armFrom][K];
        const to = byCat[cat][armTo][K];
        if (from == null || to == null) continue;
        if (to - from < threshold) return false;
      }
    }
    return true;
  }

  const gates = {};
  gates.rrfFlip =
    (overall.B[10] ?? -1) > (overall.A[10] ?? -1) && categoryNoRegression("A", "B", -0.01);

  const noCategoryDrop = (() => {
    for (const cat of CATEGORIES) {
      for (const K of KS) {
        const b = byCat[cat].B[K];
        const c = byCat[cat].C[K];
        if (b == null || c == null) continue;
        if (b - c > 0.01) return false; // > 1pp absolute drop
      }
    }
    return true;
  })();
  const paraphraseLoss = Math.max(0, (byCat.paraphrase.B[10] ?? 0) - (byCat.paraphrase.C[10] ?? 0));
  const idPhraseGain =
    Math.max(0, (byCat.identifier.C[10] ?? 0) - (byCat.identifier.B[10] ?? 0)) +
    Math.max(0, (byCat.phrase.C[10] ?? 0) - (byCat.phrase.B[10] ?? 0));
  gates.routingFlip =
    (overall.C[10] ?? -1) > (overall.B[10] ?? -1) &&
    noCategoryDrop &&
    paraphraseLoss <= idPhraseGain;

  // ---- Arm D: restricted-role split vault ----
  const splitInfo = await buildSplitVault(dayDocs.map((d) => d.path));
  const SPLIT = openVault(SPLIT_VAULT);
  const splitCollections = new Map();
  for (const doc of getAllDocuments(SPLIT)) {
    splitCollections.set(doc.collection, (splitCollections.get(doc.collection) ?? 0) + 1);
  }
  const distinctCollections = [...splitCollections.keys()];
  if (distinctCollections.length !== NUM_COLLECTIONS) {
    throw new Error(
      `split vault: expected ${NUM_COLLECTIONS} collections, got ${distinctCollections.length}`,
    );
  }
  for (const [col, count] of splitCollections) {
    if (count < 22 || count > 23) {
      throw new Error(`split vault: collection ${col} has ${count} docs, expected 22-23`);
    }
  }
  console.log(
    `split vault: ${splitInfo.documentCount} docs across ${distinctCollections.length} collections`,
  );

  const splitDf = makeDfLookup(SPLIT);
  const splitDocCount = documentCount(SPLIT);

  const dPerQ = [];
  const mismatches = [];
  const boundaryTies = [];
  let firstDPushChecked = false;

  for (const q of allQuestions) {
    const classified = classifyQuery(q.question, { df: splitDf, docCount: splitDocCount });
    const cWeights = routeWeights(classified.class);

    // D-push: pushdown filter INSIDE the KNN scan (the shipped a2ec361 fix).
    const push = await retrieve(SPLIT, q.question, {
      limit: LIMIT,
      fusion: "rrf",
      weights: cWeights,
      readableCollections: READABLE,
    });
    assertVectorUsedExpectation("D-push", push, cWeights, q.question);
    if (!firstDPushChecked) {
      if (!push.vectorUsed && cWeights.vector > 0) {
        throw new Error("first D-push question expected vectorUsed: true");
      }
      firstDPushChecked = true;
    }

    // D-post: NO pushdown — over-fetch every ranked candidate (unrestricted
    // KNN, exactly like the pre-a2ec361 handler), then post-filter to
    // READABLE in the runner, THEN slice — reproducing the starvation bug.
    const postRaw = await retrieve(SPLIT, q.question, {
      limit: LIMIT,
      overFetch: true,
      fusion: "rrf",
      weights: cWeights,
    });
    assertVectorUsedExpectation("D-post", postRaw, cWeights, q.question);
    const postHits = postRaw.hits.filter((h) => READABLE.includes(h.collection)).slice(0, LIMIT);

    // No-leak / rank-identity regression: readableCollections = ALL 8
    // collections vs readableCollections: undefined. Compared, collected,
    // never aborts mid-run (final plan, C4 revision).
    const withAll = await retrieve(SPLIT, q.question, {
      limit: LIMIT,
      fusion: "rrf",
      weights: cWeights,
      readableCollections: ALL_COLLECTIONS,
    });
    const unfiltered = await retrieve(SPLIT, q.question, {
      limit: LIMIT,
      fusion: "rrf",
      weights: cWeights,
    });
    compareRankIdentity(withAll.hits, unfiltered.hits, q.question, mismatches, boundaryTies);

    // Restricted-arm recall excludes unreadable relevant days from the
    // denominator (final plan): a question whose relevant day never landed
    // in a readable collection cannot be scored under restriction at all.
    const readableRel = q.relevantDays.filter((day) => READABLE.includes(collectionOf(day)));
    if (readableRel.length === 0) continue;

    const row = { id: q.question, category: q.category, rel: readableRel, DPost: {}, DPush: {} };
    for (const K of KS) {
      row.DPost[K] = recall(daysAtK(postHits, K), readableRel);
      row.DPush[K] = recall(daysAtK(push.hits, K), readableRel);
    }
    dPerQ.push(row);
  }

  const dOverall = { DPost: curve(dPerQ, "DPost"), DPush: curve(dPerQ, "DPush") };
  const dByCat = curvesByCategory(dPerQ, ["DPost", "DPush"]);
  const dPushMinusPost = Object.fromEntries(
    KS.map((K) => [K, (dOverall.DPush[K] ?? 0) - (dOverall.DPost[K] ?? 0)]),
  );
  gates.noLeak = mismatches.length === 0;

  // ---- Provenance (final plan, C7 revision 2) ----
  const provenance = {
    questionsFileSha256: existsSync(QFILE) ? sha256Hex(readFileSync(QFILE)) : null,
    // "corpus file listing" here is the day vault's own document-path
    // listing (deterministic, sorted) — the runner has no direct view of
    // the external Stevenic/recall corpus prep-vault.mjs consumed, so this
    // is the closest reproducible provenance signal available to it.
    dayVaultListingSha256: sha256Hex(
      dayDocs
        .map((d) => d.path)
        .sort()
        .join("\n"),
    ),
  };

  const summary = {
    smoke: SMOKE,
    counts: {
      total: perQ.length,
      byCategory: Object.fromEntries(
        CATEGORIES.map((c) => [c, perQ.filter((r) => r.category === c).length]),
      ),
    },
    overall,
    byCategory: byCat,
    byRouteClass,
    gates,
    arm_d: {
      splitVault: {
        documentCount: splitInfo.documentCount,
        collections: distinctCollections.length,
      },
      overall: dOverall,
      byCategory: dByCat,
      pushMinusPost: dPushMinusPost,
      noLeak: {
        mismatchCount: mismatches.length,
        boundaryTieCount: boundaryTies.length,
        vecKnnK: VEC_KNN_K,
      },
    },
    provenance,
  };

  writeFileSync(
    `${OUT}/fusion-perq.json`,
    JSON.stringify({ ks: KS, smoke: SMOKE, perQ, dPerQ }, null, 2),
  );
  writeFileSync(
    `${OUT}/fusion-mismatches.json`,
    JSON.stringify({ mismatches, boundaryTies }, null, 2),
  );
  writeFileSync(`${OUT}/fusion-summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));

  DAY.close();
  SPLIT.close();
}

// Compares two ordered hit lists path-for-path. Identical (within a 1e-9
// score epsilon) -> no-op. Otherwise: sqlite-vec gives no ordering guarantee
// among equal-distance neighbours under the KNN `IN (…)` partition
// constraint, so a doc whose vectorScore sits at the tail (minimum) of
// EITHER list's KNN window can legitimately swap in/out between two
// collection-filter shapes even though the fusion math is identical. If
// every differing doc's vectorScore sits at that boundary minimum, this is
// recorded as a "boundary tie" for review, not a gate-failing mismatch.
function compareRankIdentity(a, b, question, mismatches, boundaryTies, epsilon = 1e-9) {
  const len = Math.max(a.length, b.length);
  let identical = true;
  for (let i = 0; i < len; i++) {
    const ha = a[i];
    const hb = b[i];
    if (!ha || !hb || ha.path !== hb.path || Math.abs(ha.score - hb.score) > epsilon) {
      identical = false;
      break;
    }
  }
  if (identical) return;

  const aPaths = new Set(a.map((h) => h.path));
  const bPaths = new Set(b.map((h) => h.path));
  const onlyInA = a.filter((h) => !bPaths.has(h.path));
  const onlyInB = b.filter((h) => !aPaths.has(h.path));
  const reordered = a.filter(
    (h, i) => bPaths.has(h.path) && aPaths.has(h.path) && b[i]?.path !== h.path,
  );
  const differing = [...onlyInA, ...onlyInB, ...reordered];

  const allScores = [...a, ...b].map((h) => h.vectorScore);
  const boundary = allScores.length ? Math.min(...allScores) : 0;
  const allAtBoundary =
    differing.length > 0 && differing.every((h) => Math.abs(h.vectorScore - boundary) <= epsilon);

  const record = {
    question,
    withAllPaths: a.map((h) => h.path),
    unfilteredPaths: b.map((h) => h.path),
  };
  if (allAtBoundary) boundaryTies.push(record);
  else mismatches.push(record);
}

await main();
