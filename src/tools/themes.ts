// vault_themes — thematic clustering over chunk embeddings with per-document
// theme distributions (#58).
//
// Cluster CHUNKS, not pooled documents: v1 mean-pooled each document's chunk
// embeddings into one vector, which collapses a genuinely two-region document
// (half pricing, half moonshot) into a single point that lands in neither
// region. v2 clusters the chunk vectors directly and aggregates chunk
// assignments into per-document DISTRIBUTIONS over themes, so that document
// carries weight in both themes instead of a wrong single assignment.
//
// v2 constraints (locked):
//   - Documents have distributions, not single assignments. `documentCount`
//     is COVERAGE (a doc in two themes counts in both); the partition lives
//     in `primaryDocumentCount` (each doc counted once, at its argmax theme).
//   - A theme membership below MEMBERSHIP_MIN_FRACTION of the doc's chunks
//     is dropped (except the argmax) — a one-chunk aside must not create a
//     phantom membership (#58's granularity concern).
//   - Heuristic labels from TF-IDF over titles + tags. No LLM call.
//   - No new storage — the tool is read-only against the existing
//     embeddings / chunks / documents tables.
//   - Default k-sweep over {10, 15, 20, 25}; an explicit `k` argument skips
//     the sweep. Silhouette for the sweep is computed on a deterministic
//     stride sample (chunk-scale inputs make the full O(n²) score ~2B pairs).
//   - Deterministic via a fixed seed for the k-means RNG and stride (never
//     random) sampling.

import { type AccessContext, canRead } from "../access/rbac.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { getProvider } from "../search/vector.js";
import { blobToEmbedding, type IndexDb, type IndexedDocument } from "../storage/index-db.js";
import {
  clusterCoherence,
  kmeans,
  membershipDistributions,
  pickK,
  seededRng,
  strideSample,
} from "../themes/clustering.js";
import type { ToolDefinition } from "./read.js";
import { ensureIndexReady, openIndexForActiveProvider } from "./search.js";

// Fixed seed for the k-means RNG. The whole point of vault_themes is that
// the same vault produces the same themes — a random seed would give the
// user different themes every run and erode trust in the output.
const THEMES_RNG_SEED = 0x7da17f1; // arbitrary; constant is what matters

// Default k-sweep range (from the issue dialogue). Each is clamped to the
// number of clusterable chunks inside pickK.
const DEFAULT_K_CANDIDATES = [10, 15, 20, 25];

// k-means iteration cap. Vectors on the unit sphere converge fast in
// practice; this is a safety bound for pathological inputs.
const KMEANS_MAX_ITER = 50;

// Representative-doc count returned per theme. 5 is enough to be useful in
// the UI without dragging in marginal members.
const REPRESENTATIVE_DOCS_PER_THEME = 5;

// Tag-frequency cutoff per theme. Five most-common tags is enough signal
// without burying the user in noise.
const RELATED_TAGS_PER_THEME = 5;

// A doc is a member of a theme when at least this fraction of its chunks
// landed there (the argmax theme always qualifies). 0.25 keeps the 60/40
// two-region synthesis doc in both themes while dropping a one-chunk aside
// in a ten-chunk doc (0.1) — #58's phantom-theme guard.
const MEMBERSHIP_MIN_FRACTION = 0.25;

// Silhouette sample cap for the k-sweep. The sweep clusters every chunk but
// scores k on a deterministic stride sample: full silhouette is O(n²) and
// chunk-scale inputs (~44k on the motivating vault) would make it ~2B pairs
// per candidate k.
const SILHOUETTE_SAMPLE_CAP = 2000;

// Per-theme coherence sample cap, same O(n²) rationale as the silhouette
// cap but per cluster.
const COHERENCE_SAMPLE_CAP = 200;

// Hard cap on secondaries reported per theme. Same UX rationale as
// REPRESENTATIVE_DOCS_PER_THEME — enough to be useful, bounded enough to
// not bury the user.
const SECONDARY_DOCS_PER_THEME = 5;

export interface VaultTheme {
  // Stable identifier referenced by docMemberships. Cluster index from the
  // k-means run — NOT the position in the (documentCount-sorted) themes
  // array.
  id: number;
  label: string;
  // COVERAGE count: how many scoped documents hold a membership in this
  // theme (primary or not). A two-theme document counts in both, so the sum
  // across themes exceeds totalDocuments when cross-cutting docs exist.
  documentCount: number;
  // PARTITION count: documents whose argmax theme is this one. Each doc is
  // counted exactly once across all themes; these sum to totalDocuments.
  primaryDocumentCount: number;
  // coherence is the mean pairwise cosine similarity among the theme's
  // chunk vectors (stride-sampled above COHERENCE_SAMPLE_CAP). For a
  // single-chunk theme there are no pairs to average, so the field is null
  // rather than 1.0 — reporting 1.0 would imply tightness that does not
  // exist.
  coherence: number | null;
  // PRIMARY members ranked by membership weight (fraction of the doc's
  // chunks in this theme) — the theme's residents. Always disjoint from
  // secondaryDocs, the same invariant v1 held; empty for a theme whose
  // members are all visitors (every member's argmax lies elsewhere).
  representativeDocs: string[];
  // Member documents whose PRIMARY theme is elsewhere — the cross-cutting
  // docs, now derived from real chunk distributions rather than v1's
  // centroid-distance heuristic.
  secondaryDocs: string[];
  relatedTags: string[];
}

export interface VaultThemesResult {
  themes: VaultTheme[];
  // Per-document theme distributions for CROSS-CUTTING docs only: paths
  // whose chunks give them membership in two or more themes. `theme` is a
  // VaultTheme.id; weights are fractions of the doc's chunks and sum to ≤ 1
  // (sub-threshold memberships are dropped). Single-theme docs are omitted
  // — their distribution is the trivial one and listing every path would
  // bloat the payload.
  docMemberships: Record<string, { theme: number; weight: number }[]>;
  totalDocuments: number;
  // Chunk count actually clustered. k clamps to THIS (clustering is
  // chunk-level), not to totalDocuments.
  totalChunks: number;
  skippedDocuments: number;
  selectedK: number;
  // Clusters that received chunks but ended up with NO retained doc
  // membership — every contributing doc had a larger share of its chunks
  // elsewhere and this cluster's slice fell below MEMBERSHIP_MIN_FRACTION.
  // That is the phantom-theme guard operating at theme level (a grab-bag of
  // per-doc asides — boilerplate, footers — is not a theme anyone lives in),
  // but it means themes.length can be less than selectedK for a reason other
  // than the k-clamp; this count makes the omission visible instead of
  // silent.
  droppedClusters: number;
  clusteredAt: string;
}

interface ScopedDoc {
  path: string;
  title: string;
  collection: string;
  tags: string[];
  chunks: Float32Array[];
}

// Tokenisation for TF-IDF labels: lowercase, split on non-alphanumeric,
// drop stopwords. This is deliberately a smaller list than bm25's — the
// label step doesn't need FTS5 alignment, and we keep "tag-like" tokens.
const LABEL_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "them",
  "they",
  "this",
  "to",
  "was",
  "were",
  "will",
  "with",
  "you",
  "your",
]);

function labelTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !LABEL_STOPWORDS.has(t));
}

// Loads every (path, content_hash, embedding) row for the active model, in
// path-then-chunk-index order, and groups embeddings by document path.
//
// When `collection` is given the chunk scan is joined to `documents` and
// filtered to that collection IN SQL, so out-of-scope embeddings are never
// read out of the database or copied into memory (E3). The collection column
// is authoritative for scope — the same predicate `buildScopedDocs` applies —
// so pushing it down here changes nothing about the clustered result, only
// which rows are loaded.
function loadEmbeddingsByPath(
  db: IndexDb,
  model: string,
  collection?: string,
): Map<string, Float32Array[]> {
  interface Row {
    path: string;
    embedding: Buffer | null;
    dim: number | null;
  }
  const sql = collection
    ? `SELECT c.path AS path, e.embedding AS embedding, e.dim AS dim
         FROM chunks c
         JOIN documents d ON d.path = c.path
         LEFT JOIN embeddings e
           ON e.content_hash = c.content_hash AND e.model = ?
        WHERE d.collection = ?
        ORDER BY c.path, c.chunk_index`
    : `SELECT c.path AS path, e.embedding AS embedding, e.dim AS dim
         FROM chunks c
         LEFT JOIN embeddings e
           ON e.content_hash = c.content_hash AND e.model = ?
        ORDER BY c.path, c.chunk_index`;
  const rows = (
    collection ? db.prepare(sql).all(model, collection) : db.prepare(sql).all(model)
  ) as Row[];
  const provider = getProvider();
  const expectedDim = provider.dim;
  const out = new Map<string, Float32Array[]>();
  for (const row of rows) {
    if (!row.embedding) continue;
    // Defense-in-depth: skip rows whose stored dim disagrees with the
    // provider's expected dim — same guard `getAllChunks` applies.
    const blobOk = row.embedding.length === expectedDim * 4;
    const dimOk = row.dim === expectedDim;
    if (!blobOk || !dimOk) continue;
    const vec = blobToEmbedding(row.embedding);
    const list = out.get(row.path);
    if (list) list.push(vec);
    else out.set(row.path, [vec]);
  }
  return out;
}

interface ThemesFilters {
  collection?: string;
  tags?: string[];
}

// A cached, per-doc CHUNK vector set for one (vault, model, collection-scope)
// keyed by a content signature. `docs` carries everything clustering needs
// downstream — the L2-normalised chunk vectors plus the doc metadata used
// for labels/RBAC — so a cache hit avoids both the embeddings load and the
// per-chunk normalisation. RBAC and the tags filter are applied per-caller
// against this set (they are cheap and caller-dependent, so they are NOT
// baked into the cache).
interface ChunkSet {
  signature: string;
  docs: ChunkDoc[];
  // Docs that had no embedded chunk (or only zero vectors). Kept so the
  // per-caller skipped count can be recomputed after RBAC/tags filtering.
  unembeddedPaths: Set<string>;
}

interface ChunkDoc {
  path: string;
  title: string;
  collection: string;
  tags: string[];
  chunks: Float32Array[];
}

// Process-level memo of the chunk vector set. Keyed by
// `${vaultRoot} ${model} ${collection ?? "*"}`; the entry's
// `signature` is checked against the live index signature on every call and a
// mismatch (any reindex/content change) discards the stale entry. Bounded to
// one entry per scope key — the working set for a single vault is the same
// vectors clustering must hold in memory anyway, and the cache is dropped
// wholesale on signature change.
const chunkSetCache = new Map<string, ChunkSet>();

// Test-only hook: reset the process-level cache between cases.
export function __resetThemesCache(): void {
  chunkSetCache.clear();
}

// Cheap content signature for the (collection-scoped) chunk+embedding set of
// the active model. It changes whenever a chunk is added/removed/re-hashed or
// an embedding is (re)written, which is exactly when the chunk vectors would
// differ — so a matching signature guarantees the cached set is still valid.
// `documents.rowid` participation via count keeps a bare collection rename
// honest. This scans indexes, not the embedding blobs.
function indexSignature(db: IndexDb, model: string, collection?: string): string {
  interface SigRow {
    n: number | null;
    hashes: string | null;
    embn: number | null;
  }
  const sql = collection
    ? `SELECT COUNT(*) AS n,
              group_concat(c.content_hash, '') AS hashes,
              SUM(CASE WHEN e.content_hash IS NULL THEN 0 ELSE 1 END) AS embn
         FROM chunks c
         JOIN documents d ON d.path = c.path
         LEFT JOIN embeddings e
           ON e.content_hash = c.content_hash AND e.model = ?
        WHERE d.collection = ?`
    : `SELECT COUNT(*) AS n,
              group_concat(c.content_hash, '') AS hashes,
              SUM(CASE WHEN e.content_hash IS NULL THEN 0 ELSE 1 END) AS embn
         FROM chunks c
         LEFT JOIN embeddings e
           ON e.content_hash = c.content_hash AND e.model = ?`;
  const row = (
    collection ? db.prepare(sql).get(model, collection) : db.prepare(sql).get(model)
  ) as SigRow;
  // A tiny FNV-1a over the concatenated hashes keeps the key bounded regardless
  // of vault size while still varying on any content change.
  const hashes = row.hashes ?? "";
  let h = 0x811c9dc5;
  for (let i = 0; i < hashes.length; i++) {
    h ^= hashes.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hashDigest = (h >>> 0).toString(16);
  return `${model}:${collection ?? "*"}:${row.n ?? 0}:${row.embn ?? 0}:${hashDigest}`;
}

// Returns the per-doc chunk vector set for the given scope, using the cache
// when the live signature matches and rebuilding (load + normalise)
// otherwise. This is the load-avoidance core of the E3 fix: a second call
// against an unchanged index re-uses the vectors instead of re-reading every
// embedding blob.
function getChunkSet(
  db: IndexDb,
  vaultRoot: string,
  model: string,
  documentsByPath: Map<string, IndexedDocument>,
  collection: string | undefined,
): ChunkSet {
  const cacheKey = `${vaultRoot} ${model} ${collection ?? "*"}`;
  const signature = indexSignature(db, model, collection);
  const cached = chunkSetCache.get(cacheKey);
  if (cached && cached.signature === signature) return cached;

  const embeddingsByPath = loadEmbeddingsByPath(db, model, collection);
  const docs: ChunkDoc[] = [];
  const unembeddedPaths = new Set<string>();
  for (const [path, doc] of documentsByPath) {
    if (collection && doc.collection !== collection) continue;
    const raw = embeddingsByPath.get(path) ?? [];
    // Normalise each chunk onto the unit sphere (cosine semantics for the
    // clustering); drop zero vectors — they carry no direction to cluster.
    const chunks: Float32Array[] = [];
    for (const vec of raw) {
      // Single pass per chunk: this runs at chunk scale (~44k on the
      // motivating vault), so the norm is computed once and reused for the
      // scaling rather than recomputed inside a normalize helper.
      let norm = 0;
      for (let i = 0; i < vec.length; i++) {
        const x = vec[i] as number;
        norm += x * x;
      }
      if (norm === 0) continue;
      const inv = 1 / Math.sqrt(norm);
      const out = new Float32Array(vec.length);
      for (let i = 0; i < vec.length; i++) out[i] = (vec[i] as number) * inv;
      chunks.push(out);
    }
    if (chunks.length === 0) {
      unembeddedPaths.add(path);
      continue;
    }
    docs.push({
      path: doc.path,
      title: doc.title,
      collection: doc.collection,
      tags: doc.tags,
      chunks,
    });
  }
  const set: ChunkSet = { signature, docs, unembeddedPaths };
  chunkSetCache.set(cacheKey, set);
  return set;
}

// Applies the per-caller scope (tags, RBAC) and the doc-has-an-embedded-chunk
// requirement over a pre-loaded set. The collection filter is already applied
// upstream in `getChunkSet` (and pushed into SQL), so it is not re-checked
// here beyond honouring it for the skipped count. Returns the clusterable doc
// set and the count of docs the embedding requirement skipped.
//
// `skipped` must match the pre-cache contract exactly: a doc counts as skipped
// only if it passes collection + tags + RBAC and yet has no chunk vector.
function finalizeScope(
  chunkSet: ChunkSet,
  documentsByPath: Map<string, IndexedDocument>,
  filters: ThemesFilters,
  access: AccessContext | undefined,
): { scoped: ScopedDoc[]; skipped: number } {
  const passesTagsAndRbac = (collection: string, tags: string[]): boolean => {
    if (filters.tags && filters.tags.length > 0) {
      const hasAll = filters.tags.every((t) => tags.includes(t));
      if (!hasAll) return false;
    }
    if (access && !canRead(access.role, collection)) return false;
    return true;
  };

  const scoped: ScopedDoc[] = [];
  for (const doc of chunkSet.docs) {
    if (!passesTagsAndRbac(doc.collection, doc.tags)) continue;
    scoped.push({
      path: doc.path,
      title: doc.title,
      collection: doc.collection,
      tags: doc.tags,
      chunks: doc.chunks,
    });
  }

  let skipped = 0;
  for (const path of chunkSet.unembeddedPaths) {
    const doc = documentsByPath.get(path);
    if (!doc) continue;
    if (filters.collection && doc.collection !== filters.collection) continue;
    if (!passesTagsAndRbac(doc.collection, doc.tags)) continue;
    skipped += 1;
  }
  return { scoped, skipped };
}

// TF-IDF over the cluster: term frequency among the cluster's titles +
// tags, divided by the document-frequency across ALL clusters (so a term
// that names every theme — e.g. "doc" — doesn't dominate any one of them).
// Falls back to the most common tags if TF-IDF yields nothing useful, and
// finally to a generic "theme N" placeholder.
function buildLabel(
  clusterDocs: ScopedDoc[],
  globalDocCount: number,
  globalDf: Map<string, number>,
  themeIndex: number,
): string {
  const tf = new Map<string, number>();
  for (const doc of clusterDocs) {
    const seen = new Set<string>();
    for (const tok of labelTokens(doc.title)) seen.add(tok);
    for (const tag of doc.tags) {
      for (const tok of labelTokens(tag)) seen.add(tok);
    }
    for (const tok of seen) tf.set(tok, (tf.get(tok) ?? 0) + 1);
  }
  const scored: { term: string; score: number }[] = [];
  for (const [term, freq] of tf) {
    const df = globalDf.get(term) ?? 1;
    // Standard smoothed IDF.
    const idf = Math.log((globalDocCount + 1) / (df + 1)) + 1;
    if (idf <= 0) continue;
    scored.push({ term, score: freq * idf });
  }
  scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  const top = scored.slice(0, 3).map((s) => s.term);
  if (top.length > 0) return top.join(" / ");

  // Fallback: most common tags.
  const tagFreq = new Map<string, number>();
  for (const doc of clusterDocs) {
    for (const tag of doc.tags) tagFreq.set(tag, (tagFreq.get(tag) ?? 0) + 1);
  }
  const topTags = [...tagFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);
  if (topTags.length > 0) return topTags.join(" / ");

  return `theme ${themeIndex + 1}`;
}

// Builds the global document-frequency map across the clustered set. Used
// by buildLabel; computed once and shared because every cluster's IDF must
// agree on the document base.
function buildGlobalDf(docs: ScopedDoc[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set<string>();
    for (const tok of labelTokens(doc.title)) seen.add(tok);
    for (const tag of doc.tags) {
      for (const tok of labelTokens(tag)) seen.add(tok);
    }
    for (const tok of seen) df.set(tok, (df.get(tok) ?? 0) + 1);
  }
  return df;
}

function topTagsForCluster(clusterDocs: ScopedDoc[]): string[] {
  const freq = new Map<string, number>();
  for (const doc of clusterDocs) {
    for (const tag of doc.tags) freq.set(tag, (freq.get(tag) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, RELATED_TAGS_PER_THEME)
    .map(([t]) => t);
}

interface ParsedArgs {
  k: number | undefined;
  collection: string | undefined;
  tags: string[] | undefined;
}

function parseArgs(args: Record<string, unknown>): Result<ParsedArgs, Error> {
  let k: number | undefined;
  if (args.k !== undefined) {
    if (typeof args.k !== "number" || !Number.isInteger(args.k) || args.k <= 0) {
      return err(new Error("vault_themes: 'k' must be a positive integer when provided"));
    }
    k = args.k;
  }
  const collection =
    typeof args.collection === "string" && args.collection.length > 0 ? args.collection : undefined;
  let tags: string[] | undefined;
  if (Array.isArray(args.tags)) {
    const filtered = args.tags.filter((t): t is string => typeof t === "string" && t.length > 0);
    if (filtered.length > 0) tags = filtered;
  }
  return ok({ k, collection, tags });
}

export async function vaultThemes(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<VaultThemesResult, Error>> {
  const parsed = parseArgs(args);
  if (!parsed.ok) return parsed;

  const ready = await ensureIndexReady(vaultRoot);
  if (!ready.ok) return ready;

  const dbResult = openIndexForActiveProvider(vaultRoot);
  if (!dbResult.ok) return dbResult;
  const db = dbResult.value;
  try {
    const provider = getProvider();
    interface DocRow {
      path: string;
      title: string;
      collection: string;
      tags: string;
    }
    // Push the collection filter into the documents scan too: a scoped call
    // never materialises out-of-scope document rows, and `JSON.parse(tags)`
    // runs only for in-scope docs (part of the E3 load-avoidance).
    const collection = parsed.value.collection;
    const docRows = (
      collection
        ? db
            .prepare(
              "SELECT path, title, collection, tags FROM documents WHERE collection = ? ORDER BY path",
            )
            .all(collection)
        : db.prepare("SELECT path, title, collection, tags FROM documents ORDER BY path").all()
    ) as DocRow[];
    const documentsByPath = new Map<string, IndexedDocument>();
    for (const r of docRows) {
      documentsByPath.set(r.path, {
        path: r.path,
        title: r.title,
        collection: r.collection,
        domain: "",
        status: "",
        confidence: "",
        updated: "",
        tags: JSON.parse(r.tags) as string[],
        content: "",
        tokens: [],
        ttlDays: null,
        created: "",
        supersededBy: null,
      });
    }

    const chunkSet = getChunkSet(db, vaultRoot, provider.id, documentsByPath, collection);
    const { scoped, skipped } = finalizeScope(chunkSet, documentsByPath, parsed.value, access);

    if (scoped.length === 0) {
      return ok({
        themes: [],
        docMemberships: {},
        totalDocuments: 0,
        totalChunks: 0,
        skippedDocuments: skipped,
        selectedK: 0,
        droppedClusters: 0,
        clusteredAt: new Date().toISOString(),
      });
    }

    // Flatten to chunk-level arrays: the clustering input plus the chunk→doc
    // map the distribution aggregation needs.
    const chunkVectors: Float32Array[] = [];
    const chunkDoc: number[] = [];
    for (let d = 0; d < scoped.length; d++) {
      for (const vec of (scoped[d] as ScopedDoc).chunks) {
        chunkVectors.push(vec);
        chunkDoc.push(d);
      }
    }

    const rng = seededRng(THEMES_RNG_SEED);
    let selectedK: number;
    let assignments: number[];
    if (parsed.value.k !== undefined) {
      const result = kmeans(chunkVectors, parsed.value.k, rng, KMEANS_MAX_ITER);
      selectedK = result.centroids.length;
      assignments = result.assignments;
    } else {
      const result = pickK(
        chunkVectors,
        DEFAULT_K_CANDIDATES,
        rng,
        KMEANS_MAX_ITER,
        SILHOUETTE_SAMPLE_CAP,
      );
      selectedK = result.centroids.length;
      assignments = result.assignments;
    }

    // Aggregate chunk assignments into per-doc theme distributions (#58).
    const distributions = membershipDistributions(
      assignments,
      chunkDoc,
      scoped.length,
      MEMBERSHIP_MIN_FRACTION,
    );

    // Group member/primary docs by cluster from the distributions.
    const membersByCluster = new Map<number, { docIndex: number; weight: number }[]>();
    const primaryByCluster = new Map<number, number[]>();
    for (let d = 0; d < distributions.length; d++) {
      const memberships = distributions[d] ?? [];
      for (let m = 0; m < memberships.length; m++) {
        const { cluster, weight } = memberships[m] as { cluster: number; weight: number };
        const list = membersByCluster.get(cluster);
        if (list) list.push({ docIndex: d, weight });
        else membersByCluster.set(cluster, [{ docIndex: d, weight }]);
        // memberships are weight-desc with deterministic ties: entry 0 IS
        // the argmax/primary.
        if (m === 0) {
          const plist = primaryByCluster.get(cluster);
          if (plist) plist.push(d);
          else primaryByCluster.set(cluster, [d]);
        }
      }
    }

    // Chunk vectors per cluster for the coherence score.
    const chunksByCluster = new Map<number, Float32Array[]>();
    for (let i = 0; i < chunkVectors.length; i++) {
      const c = assignments[i] as number;
      const list = chunksByCluster.get(c);
      if (list) list.push(chunkVectors[i] as Float32Array);
      else chunksByCluster.set(c, [chunkVectors[i] as Float32Array]);
    }

    // A chunk-bearing cluster no doc's retained membership points at is a
    // grab-bag of sub-threshold asides — dropped from `themes` by the
    // phantom-theme guard, but COUNTED so the omission is visible (empty
    // k-means clusters from the k-clamp are not "dropped": they never had
    // chunks).
    let droppedClusters = 0;
    for (const clusterId of chunksByCluster.keys()) {
      if (!membersByCluster.has(clusterId)) droppedClusters += 1;
    }

    const globalDf = buildGlobalDf(scoped);

    const themes: VaultTheme[] = [];
    let themeIndex = 0;
    // Iterate clusters in index order so labels/fallbacks are deterministic.
    const clusterIds = [...membersByCluster.keys()].sort((a, b) => a - b);
    for (const clusterId of clusterIds) {
      const members = membersByCluster.get(clusterId) ?? [];
      if (members.length === 0) continue;
      members.sort(
        (a, b) =>
          b.weight - a.weight ||
          (scoped[a.docIndex] as ScopedDoc).path.localeCompare(
            (scoped[b.docIndex] as ScopedDoc).path,
          ),
      );
      const primaries = new Set(primaryByCluster.get(clusterId) ?? []);
      // Label/tag signal comes from the docs that primarily live here when
      // any do — a theme should be named by its residents, not its visitors.
      const primaryDocs = [...primaries].map((d) => scoped[d] as ScopedDoc);
      const labelDocs =
        primaryDocs.length > 0 ? primaryDocs : members.map((m) => scoped[m.docIndex] as ScopedDoc);

      const clusterChunks = chunksByCluster.get(clusterId) ?? [];
      const coherenceChunks =
        clusterChunks.length > COHERENCE_SAMPLE_CAP
          ? strideSample(clusterChunks.length, COHERENCE_SAMPLE_CAP).map(
              (i) => clusterChunks[i] as Float32Array,
            )
          : clusterChunks;
      // A single-chunk theme has no pairs to average — null rather than the
      // mathematically-trivial 1.0, which would falsely imply tightness.
      const coherence = coherenceChunks.length < 2 ? null : clusterCoherence(coherenceChunks);

      themes.push({
        id: clusterId,
        label: buildLabel(labelDocs, scoped.length, globalDf, themeIndex),
        documentCount: members.length,
        primaryDocumentCount: primaries.size,
        coherence,
        // Residents only: a high-weight visitor ranks in `members` but must
        // not appear as a representative AND a secondary of the same theme —
        // the disjointness invariant v1 held and tests pin.
        representativeDocs: members
          .filter((m) => primaries.has(m.docIndex))
          .slice(0, REPRESENTATIVE_DOCS_PER_THEME)
          .map((m) => (scoped[m.docIndex] as ScopedDoc).path),
        secondaryDocs: members
          .filter((m) => !primaries.has(m.docIndex))
          .slice(0, SECONDARY_DOCS_PER_THEME)
          .map((m) => (scoped[m.docIndex] as ScopedDoc).path),
        relatedTags: topTagsForCluster(labelDocs),
      });
      themeIndex += 1;
    }

    themes.sort((a, b) => b.documentCount - a.documentCount || a.label.localeCompare(b.label));

    // Cross-cutting docs only: a single-theme doc's distribution is trivial,
    // and listing every path would bloat the payload at vault scale.
    const docMemberships: Record<string, { theme: number; weight: number }[]> = {};
    for (let d = 0; d < distributions.length; d++) {
      const memberships = distributions[d] ?? [];
      if (memberships.length < 2) continue;
      docMemberships[(scoped[d] as ScopedDoc).path] = memberships.map((m) => ({
        theme: m.cluster,
        weight: m.weight,
      }));
    }

    return ok({
      themes,
      docMemberships,
      totalDocuments: scoped.length,
      totalChunks: chunkVectors.length,
      skippedDocuments: skipped,
      selectedK,
      droppedClusters,
      clusteredAt: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// MCP tool definition
// ---------------------------------------------------------------------------

export const themesTools: ToolDefinition[] = [
  {
    name: "vault_themes",
    title: "Cluster vault themes",
    annotations: { readOnlyHint: true },
    description:
      "Surface thematic clusters across the vault using k-means over CHUNK " +
      "embeddings, with per-document theme distributions. A document whose " +
      "chunks split across two clusters is a member of both themes " +
      "(docMemberships reports its weights); documentCount is coverage (a " +
      "two-theme doc counts in both) while primaryDocumentCount partitions " +
      "docs by their dominant theme. By default the tool sweeps " +
      "k ∈ {10, 15, 20, 25} and picks the k with the best (sampled) mean " +
      "silhouette; pass `k` to skip the sweep. Each theme reports a " +
      "heuristic label (TF-IDF over titles + tags), a coherence score (mean " +
      "pairwise cosine among its chunks), representative documents ranked " +
      "by membership weight, and the most frequent tags. Output is " +
      "deterministic for the same vault.",
    inputSchema: {
      type: "object",
      properties: {
        k: {
          type: "integer",
          description:
            "Optional explicit cluster count. When omitted, the tool sweeps " +
            "k ∈ {10, 15, 20, 25} and picks the k with the best silhouette.",
          minimum: 1,
        },
        collection: {
          type: "string",
          description: "Restrict clustering to documents in this collection.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Restrict to documents that have all of these tags.",
        },
      },
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultThemes(vaultRoot, args, access),
  },
];
