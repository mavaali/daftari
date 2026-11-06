// off.1/MAV-154 graph-augmented retrieval: a post-pass that injects a bounded,
// affinity-filtered set of one-hop edge neighbors into an already-ranked hit
// list. Mirrors applyCoveragePass (src/tools/search.ts): resolves its own config
// gate, returns `ranked` unchanged when off, flags injected hits (viaEdge) for
// RBAC filtering at the call site. hybrid.ts ranking is not touched.

import { topicEgoGraphFrom } from "../canon/topic.js";
import { listEdges } from "../curation/edges.js";
import { listTensions } from "../curation/tension.js";
import { getChunksForPath, getDocumentsByPaths, type IndexDb } from "../storage/index-db.js";
import { type GraphExpandConfig, SEARCH_TUNING_DEFAULTS } from "../utils/config.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import type { HybridHit } from "./hybrid.js";
import { cosineSimilarity } from "./vector.js";

// Runtime config holder — resolved ONCE at startup (setGraphExpandConfig called
// from src/index.ts and src/serve/index.ts beside setCoverageEnabled/setVecKnnK),
// read by the pass at serve time. Avoids a per-query loadConfig re-parse.
let graphExpandCfg: GraphExpandConfig = { ...SEARCH_TUNING_DEFAULTS.graphExpand };
export function setGraphExpandConfig(cfg: GraphExpandConfig): void {
  graphExpandCfg = cfg;
}
export function graphExpandConfig(): GraphExpandConfig {
  return graphExpandCfg;
}

export interface NeighborCandidate {
  path: string;
  seed: string; // the ranked doc it was reached from
  edgeType: "derives_from" | "tension";
  affinity: number; // max cosine of the neighbor's chunks to the query embedding
}

export interface SelectOptions {
  cap: number; // fixed global add budget
  tau: number; // vector-cosine affinity floor
}

export interface ExpansionHit {
  path: string;
  affinity: number;
  viaEdge: { seed: string; edgeType: "derives_from" | "tension" };
}

// Pure. Floor by tau, dedup against candidates and across seeds (keeping the
// highest-affinity attribution per path), order by descending affinity, cap.
export function selectExpansion(
  candidates: NeighborCandidate[],
  candidateSet: ReadonlySet<string>,
  opts: SelectOptions,
): ExpansionHit[] {
  if (opts.cap <= 0) return [];
  const best = new Map<string, NeighborCandidate>();
  for (const c of candidates) {
    if (c.affinity < opts.tau) continue;
    if (candidateSet.has(c.path)) continue; // already a ranked/seed doc
    const prior = best.get(c.path);
    if (!prior || c.affinity > prior.affinity) best.set(c.path, c);
  }
  return [...best.values()]
    .sort((a, b) => b.affinity - a.affinity || a.path.localeCompare(b.path))
    .slice(0, opts.cap)
    .map((c) => ({
      path: c.path,
      affinity: c.affinity,
      viaEdge: { seed: c.seed, edgeType: c.edgeType },
    }));
}

// Max cosine of any of a document's chunk embeddings to the query embedding.
// Reads the plain `embeddings` rows via getChunksForPath — NOT the KNN virtual
// table; a known neighbor set does not need the global scan. 0 when the path is
// unindexed or has no embeddings (never a false floor pass).
export function maxChunkCosine(
  db: IndexDb,
  path: string,
  queryEmbedding: Float32Array,
  provider: Pick<EmbeddingProvider, "id" | "dim">,
): number {
  let best = 0;
  for (const chunk of getChunksForPath(db, path, provider.id, provider.dim)) {
    if (!chunk.embedding) continue;
    const c = cosineSimilarity(chunk.embedding, queryEmbedding);
    if (c > best) best = c;
  }
  return best;
}

interface Graph {
  tensions: { sourceA: string; sourceB: string }[];
  edges: { fromPath: string; toPath: string; status: string }[];
}

// A minimal materialized doc for an injected hit — enough to populate the
// HybridHit surface and, crucially, `collection` for the call site's RBAC
// filter. Not the full IndexedDocument.
export interface MaterializedDoc {
  path: string;
  title: string;
  collection: string;
  status: string;
}

export interface GraphExpansionDeps {
  config: GraphExpandConfig;
  loadGraph: (vaultRoot: string, subset: GraphExpandConfig["subset"]) => Promise<Graph>;
  embedQuery: (query: string) => Promise<Float32Array | null>;
  affinity: (path: string) => number; // db + query embedding already closed over
  // Injected so the pass is hermetically testable. Populates title/collection/
  // status for injected hits; `collection` is load-bearing (RBAC at the call site).
  materialize: (paths: string[]) => MaterializedDoc[];
}

// Default graph loader. The subset gates which edge kinds are traversed:
//   "trigger"  = tensions + trigger-bearing derives_from (the ceiling winner)
//   "all"      = tensions + candidate|trigger-bearing derives_from
//   "tensions" = tensions only, no derives_from edges
// Revoked edges are never included (filtered out explicitly).
export async function loadGraphForSubset(
  vaultRoot: string,
  subset: GraphExpandConfig["subset"],
): Promise<Graph> {
  const tensionsRes = await listTensions(vaultRoot);
  const tensions = tensionsRes.ok
    ? tensionsRes.value.map((t) => ({ sourceA: t.sourceA, sourceB: t.sourceB }))
    : [];
  let edges: Graph["edges"] = [];
  if (subset !== "tensions") {
    const edgesRes = await listEdges(
      vaultRoot,
      subset === "trigger" ? { status: "trigger-bearing" } : {},
    );
    if (edgesRes.ok) {
      edges = edgesRes.value
        .filter((e) => e.status !== "revoked")
        .map((e) => ({ fromPath: e.fromPath, toPath: e.toPath, status: e.status }));
    }
  }
  return { tensions, edges };
}

function adjacency(pairs: readonly (readonly [string, string])[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    let s = m.get(a);
    if (!s) {
      s = new Set();
      m.set(a, s);
    }
    s.add(b);
  };
  for (const [a, b] of pairs) {
    add(a, b);
    add(b, a);
  }
  return m;
}

// The pass. Returns `ranked` UNCHANGED (same reference) when disabled or when no
// neighbor clears the floor, so the call site's identity check is meaningful.
export async function applyGraphExpansion(
  _db: IndexDb,
  vaultRoot: string,
  query: string,
  ranked: HybridHit[],
  deps: GraphExpansionDeps,
): Promise<HybridHit[]> {
  const { config } = deps;
  if (!config.enabled || config.cap <= 0 || ranked.length === 0) return ranked;

  const graph = await deps.loadGraph(vaultRoot, config.subset);
  if (graph.tensions.length === 0 && graph.edges.length === 0) return ranked;

  const qEmb = await deps.embedQuery(query);
  if (!qEmb) return ranked; // no vector signal ⇒ no affinity floor ⇒ do not inject blind

  const seedPaths = ranked.map((h) => h.path);
  const candidateSet = new Set(seedPaths);

  // Which edge kind bridged seed→neighbor? topicEgoGraphFrom is undirected over
  // the union; classify each neighbor by membership in the edge vs tension
  // adjacency (edge wins when both, matching the derives_from default below).
  const tensionNbrs = adjacency(graph.tensions.map((t) => [t.sourceA, t.sourceB] as const));
  const edgeNbrs = adjacency(graph.edges.map((e) => [e.fromPath, e.toPath] as const));

  const candidates: NeighborCandidate[] = [];
  for (const seed of seedPaths) {
    for (const nbr of topicEgoGraphFrom(graph.tensions, graph.edges, seed, 1)) {
      if (nbr === seed || candidateSet.has(nbr)) continue;
      const edgeType: "derives_from" | "tension" = edgeNbrs.get(seed)?.has(nbr)
        ? "derives_from"
        : tensionNbrs.get(seed)?.has(nbr)
          ? "tension"
          : "derives_from";
      candidates.push({ path: nbr, seed, edgeType, affinity: deps.affinity(nbr) });
    }
  }

  const chosen = selectExpansion(candidates, candidateSet, { cap: config.cap, tau: config.tau });
  if (chosen.length === 0) return ranked;

  const docs = new Map(deps.materialize(chosen.map((c) => c.path)).map((d) => [d.path, d]));
  const injected: HybridHit[] = chosen.map((c) => {
    const doc = docs.get(c.path);
    return {
      path: c.path,
      title: doc?.title ?? c.path,
      collection: doc?.collection ?? "",
      status: doc?.status ?? "",
      score: 0,
      bm25Score: 0,
      vectorScore: c.affinity,
      snippet: "",
      decay: null,
      viaEdge: c.viaEdge,
    };
  });
  return [...ranked, ...injected];
}

// Default materialize: read title/collection/status from the index.
export function materializeFromIndex(db: IndexDb, paths: string[]): MaterializedDoc[] {
  return getDocumentsByPaths(db, paths).map((d) => ({
    path: d.path,
    title: d.title,
    collection: d.collection,
    status: d.status,
  }));
}
