// vault_themes — thematic clustering over document-pooled embeddings.
//
// Cluster DOCUMENTS, not chunks: for each document we mean-pool its chunk
// embeddings into one vector, L2-normalise it, and cluster the resulting
// ~N-doc set. ~3.5k document vectors instead of ~44k chunk vectors makes
// every algorithm cheap (silhouette becomes tractable on the full set; no
// sampling needed at this scale).
//
// v1 constraints (locked):
//   - One-doc-one-theme. Each document lives in exactly one cluster.
//   - Heuristic labels from TF-IDF over titles + tags. No LLM call.
//   - No new storage — the tool is read-only against the existing
//     embeddings / chunks / documents tables.
//   - Default k-sweep over {10, 15, 20, 25}; an explicit `k` argument
//     skips the sweep.
//   - Deterministic via a fixed seed for the k-means RNG.

import { type AccessContext, canRead } from "../access/rbac.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { getProvider } from "../search/vector.js";
import { blobToEmbedding, type IndexDb, type IndexedDocument } from "../storage/index-db.js";
import {
  clusterCoherence,
  kmeans,
  meanPoolL2,
  pickK,
  seededRng,
  selectSecondaryMemberships,
} from "../themes/clustering.js";
import type { ToolDefinition } from "./read.js";
import { ensureIndexReady, openIndexForActiveProvider } from "./search.js";

// Fixed seed for the k-means RNG. The whole point of vault_themes is that
// the same vault produces the same themes — a random seed would give the
// user different themes every run and erode trust in the output.
const THEMES_RNG_SEED = 0x7da17f1; // arbitrary; constant is what matters

// Default k-sweep range (from the issue dialogue). Each is clamped to the
// number of clusterable documents inside pickK.
const DEFAULT_K_CANDIDATES = [10, 15, 20, 25];

// k-means iteration cap. Documents on the unit sphere converge fast in
// practice; this is a safety bound for pathological inputs.
const KMEANS_MAX_ITER = 50;

// Representative-doc count returned per theme. 5 is enough to be useful in
// the UI without dragging in marginal members.
const REPRESENTATIVE_DOCS_PER_THEME = 5;

// Tag-frequency cutoff per theme. Five most-common tags is enough signal
// without burying the user in noise.
const RELATED_TAGS_PER_THEME = 5;

// Secondary-membership tuning. A doc qualifies as a secondary member of a
// non-primary cluster when its centroid similarity is BOTH within DELTA of
// the primary AND above MIN_ABS_SIMILARITY. The cap prevents a centroid-
// of-mass doc from showing up in every cluster. Defaults are deliberately
// conservative — secondaries should surface cross-cutting docs, not bury
// the primary signal.
const SECONDARY_DELTA = 0.1;
const SECONDARY_MIN_SIMILARITY = 0.5;
const SECONDARY_MAX_PER_DOC = 2;

// Hard cap on secondaries reported per theme. Same UX rationale as
// REPRESENTATIVE_DOCS_PER_THEME — enough to be useful, bounded enough to
// not bury the user.
const SECONDARY_DOCS_PER_THEME = 5;

export interface VaultTheme {
  label: string;
  documentCount: number;
  // coherence is the mean pairwise cosine similarity inside the cluster.
  // For a single-doc cluster there are no pairs to average, so the field
  // is null rather than 1.0 — reporting 1.0 would imply tightness that
  // does not exist (a singleton has no internal structure to measure).
  coherence: number | null;
  representativeDocs: string[];
  // Documents whose PRIMARY cluster is elsewhere but whose pooled vector
  // is close enough to this theme's centroid to plausibly also belong.
  // Surfaces the cross-cutting docs the hard one-doc-one-theme partition
  // hides. Always disjoint from representativeDocs (a doc cannot be a
  // secondary of its own primary cluster).
  secondaryDocs: string[];
  relatedTags: string[];
}

export interface VaultThemesResult {
  themes: VaultTheme[];
  totalDocuments: number;
  skippedDocuments: number;
  selectedK: number;
  clusteredAt: string;
}

interface ScopedDoc {
  path: string;
  title: string;
  collection: string;
  tags: string[];
  vector: Float32Array;
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
function loadEmbeddingsByPath(db: IndexDb, model: string): Map<string, Float32Array[]> {
  interface Row {
    path: string;
    embedding: Buffer | null;
    dim: number | null;
  }
  const rows = db
    .prepare(
      `SELECT c.path AS path, e.embedding AS embedding, e.dim AS dim
         FROM chunks c
         LEFT JOIN embeddings e
           ON e.content_hash = c.content_hash AND e.model = ?
        ORDER BY c.path, c.chunk_index`,
    )
    .all(model) as Row[];
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

// Applies the scope filter (collection, tags), RBAC, and the doc-has-an-
// embedded-chunk requirement; returns the clusterable doc set and the count
// of docs the embedding requirement skipped.
function buildScopedDocs(
  documents: IndexedDocument[],
  embeddingsByPath: Map<string, Float32Array[]>,
  filters: ThemesFilters,
  access: AccessContext | undefined,
): { scoped: ScopedDoc[]; skipped: number } {
  const scoped: ScopedDoc[] = [];
  let skipped = 0;
  for (const doc of documents) {
    if (filters.collection && doc.collection !== filters.collection) continue;
    if (filters.tags && filters.tags.length > 0) {
      const hasAll = filters.tags.every((t) => doc.tags.includes(t));
      if (!hasAll) continue;
    }
    if (access && !canRead(access.role, doc.collection)) continue;

    const chunkVecs = embeddingsByPath.get(doc.path) ?? [];
    const pooled = meanPoolL2(chunkVecs);
    if (!pooled) {
      // No embedded chunks (or an all-zero pool): count as skipped per
      // the v1 contract.
      skipped += 1;
      continue;
    }
    scoped.push({
      path: doc.path,
      title: doc.title,
      collection: doc.collection,
      tags: doc.tags,
      vector: pooled,
    });
  }
  return { scoped, skipped };
}

// Cosine similarity for L2-normalised vectors == dot product. Used for
// representative-doc ranking against a cluster centroid.
function dotNormalized(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] as number) * (b[i] as number);
  return s;
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
  scored.sort((a, b) => b.score - a.score);
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

function representativesForCluster(clusterDocs: ScopedDoc[], centroid: Float32Array): string[] {
  return [...clusterDocs]
    .map((d) => ({ path: d.path, sim: dotNormalized(d.vector, centroid) }))
    .sort((a, b) => b.sim - a.sim || a.path.localeCompare(b.path))
    .slice(0, REPRESENTATIVE_DOCS_PER_THEME)
    .map((d) => d.path);
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
    const docRows = db
      .prepare("SELECT path, title, collection, tags FROM documents ORDER BY path")
      .all() as DocRow[];
    const documents: IndexedDocument[] = docRows.map((r) => ({
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
    }));

    const embeddingsByPath = loadEmbeddingsByPath(db, provider.id);
    const { scoped, skipped } = buildScopedDocs(documents, embeddingsByPath, parsed.value, access);

    if (scoped.length === 0) {
      return ok({
        themes: [],
        totalDocuments: 0,
        skippedDocuments: skipped,
        selectedK: 0,
        clusteredAt: new Date().toISOString(),
      });
    }

    const vectors = scoped.map((s) => s.vector);
    const rng = seededRng(THEMES_RNG_SEED);
    let selectedK: number;
    let assignments: number[];
    let centroids: Float32Array[];
    if (parsed.value.k !== undefined) {
      const result = kmeans(vectors, parsed.value.k, rng, KMEANS_MAX_ITER);
      selectedK = result.centroids.length;
      assignments = result.assignments;
      centroids = result.centroids;
    } else {
      const result = pickK(vectors, DEFAULT_K_CANDIDATES, rng, KMEANS_MAX_ITER);
      selectedK = result.centroids.length;
      assignments = result.assignments;
      centroids = result.centroids;
    }

    // Group docs by cluster.
    const byCluster = new Map<number, ScopedDoc[]>();
    for (let i = 0; i < scoped.length; i++) {
      const c = assignments[i] as number;
      const doc = scoped[i] as ScopedDoc;
      const list = byCluster.get(c);
      if (list) list.push(doc);
      else byCluster.set(c, [doc]);
    }

    const globalDf = buildGlobalDf(scoped);

    // Secondary memberships: for each doc, find non-primary clusters its
    // pooled vector also aligns with. This is the soft-reporting layer on
    // top of the hard partition — it does NOT change documentCount, which
    // still reflects primary membership only.
    const secondaryByCluster = selectSecondaryMemberships(vectors, assignments, centroids, {
      delta: SECONDARY_DELTA,
      minSimilarity: SECONDARY_MIN_SIMILARITY,
      maxPerDoc: SECONDARY_MAX_PER_DOC,
    });

    const themes: VaultTheme[] = [];
    let themeIndex = 0;
    for (const [clusterIdx, clusterDocs] of byCluster) {
      if (clusterDocs.length === 0) continue;
      const centroid = centroids[clusterIdx];
      if (!centroid) continue;
      // Singleton clusters have no pairs to average — return null rather
      // than the mathematically-trivial 1.0, which would falsely imply
      // tightness.
      const coherence =
        clusterDocs.length < 2 ? null : clusterCoherence(clusterDocs.map((d) => d.vector));
      const secondaries = (secondaryByCluster.get(clusterIdx) ?? [])
        .slice(0, SECONDARY_DOCS_PER_THEME)
        .map((s) => (scoped[s.docIndex] as ScopedDoc).path);
      themes.push({
        label: buildLabel(clusterDocs, scoped.length, globalDf, themeIndex),
        documentCount: clusterDocs.length,
        coherence,
        representativeDocs: representativesForCluster(clusterDocs, centroid),
        secondaryDocs: secondaries,
        relatedTags: topTagsForCluster(clusterDocs),
      });
      themeIndex += 1;
    }

    themes.sort((a, b) => b.documentCount - a.documentCount || a.label.localeCompare(b.label));

    return ok({
      themes,
      totalDocuments: scoped.length,
      skippedDocuments: skipped,
      selectedK,
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
    description:
      "Surface thematic clusters across the vault using k-means over " +
      "document-pooled embeddings. Each document's chunk vectors are " +
      "mean-pooled into one vector, L2-normalised, and clustered. By " +
      "default the tool sweeps k ∈ {10, 15, 20, 25} and picks the k with " +
      "the best mean silhouette; pass `k` to skip the sweep. Each theme " +
      "reports a heuristic label (TF-IDF over titles + tags), a coherence " +
      "score (mean pairwise cosine inside the cluster), representative " +
      "documents nearest the centroid, and the most frequent tags. " +
      "Output is deterministic for the same vault.",
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
