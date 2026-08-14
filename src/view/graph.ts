// Pure knowledge-graph builder for `daftari view`. Takes already-loaded inputs
// (docs + the reverse maps, derives_from edges, contested pairs, and the decayed
// set) and returns a {nodes, edges} graph — no IO, so it is unit-testable
// without a vault. The server route wires the IO (loadDocuments, vaultEdges,
// listTensions, computeDecay) and calls this. This is the JSON the /api/graph
// endpoint serves and the graph client renders (the B-seam: one contract, two
// consumers).

export type GraphEdgeKind = "source" | "link" | "derives_from" | "contested";

export interface GraphNode {
  path: string;
  title: string;
  collection: string;
  tier: string | null;
  status: string;
  decayed: boolean;
  contested: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
}

export interface VaultGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  total: number; // node count before any cap
  shown: number; // nodes actually returned
  truncated: boolean; // true when a cap dropped nodes (R8)
}

export interface GraphDoc {
  path: string;
  title: string;
  collection: string;
  tier: string | null;
  status: string;
}

export interface GraphInput {
  docs: GraphDoc[];
  // target -> docs referencing it. Iterable so both the real Set-valued reverse
  // maps and array-valued test fixtures satisfy it.
  reverseSource: Map<string, Iterable<string>>; // via sources
  reverseLink: Map<string, Iterable<string>>; // via body links
  derivesEdges: { from: string; to: string }[]; // live derives_from edges
  contestedPairs: { a: string; b: string }[]; // unresolved tensions (both paths)
  decayed: Set<string>; // paths whose decay report is non-null
}

export interface GraphOptions {
  scope: "all" | "ego";
  root?: string;
  depth?: number;
  cap?: number; // max nodes returned; default DEFAULT_NODE_CAP
}

export const DEFAULT_NODE_CAP = 600;

// Forward edges from a reverse map: reverse maps are target -> [referrers], so a
// forward edge runs referrer -> target. Only edges whose BOTH endpoints are
// known documents are kept (a dangling reference is not a graph edge).
function edgesFromReverse(
  reverse: Map<string, Iterable<string>>,
  kind: GraphEdgeKind,
  known: Set<string>,
): GraphEdge[] {
  const out: GraphEdge[] = [];
  for (const [target, referrers] of reverse) {
    if (!known.has(target)) continue;
    for (const from of referrers) {
      if (from === target || !known.has(from)) continue;
      out.push({ from, to: target, kind });
    }
  }
  return out;
}

// Undirected adjacency for ego BFS and (optionally) degree-ranked capping.
function adjacency(edges: GraphEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const s = adj.get(a) ?? new Set<string>();
    s.add(b);
    adj.set(a, s);
  };
  for (const e of edges) {
    link(e.from, e.to);
    link(e.to, e.from);
  }
  return adj;
}

export function buildGraph(input: GraphInput, opts: GraphOptions): VaultGraph {
  const known = new Set(input.docs.map((d) => d.path));

  // All edges, deduped (a pair may be both source and link — keep both kinds
  // but never the same kind twice), endpoints restricted to known docs.
  const rawEdges: GraphEdge[] = [
    ...edgesFromReverse(input.reverseSource, "source", known),
    ...edgesFromReverse(input.reverseLink, "link", known),
    ...input.derivesEdges
      .filter((e) => e.from !== e.to && known.has(e.from) && known.has(e.to))
      .map((e) => ({ from: e.from, to: e.to, kind: "derives_from" as const })),
    ...input.contestedPairs
      .filter((p) => p.a !== p.b && known.has(p.a) && known.has(p.b))
      // canonical order so the undirected contested edge dedupes stably
      .map((p) => {
        const [from, to] = p.a < p.b ? [p.a, p.b] : [p.b, p.a];
        return { from, to, kind: "contested" as const };
      }),
  ];
  const seen = new Set<string>();
  let allEdges: GraphEdge[] = [];
  for (const e of rawEdges) {
    const key = `${e.kind}|${e.from}|${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    allEdges.push(e);
  }

  const contestedNodes = new Set<string>();
  for (const e of allEdges) {
    if (e.kind === "contested") {
      contestedNodes.add(e.from);
      contestedNodes.add(e.to);
    }
  }

  // Node universe, optionally narrowed to an ego neighborhood via undirected BFS.
  let nodePaths = new Set(known);
  if (opts.scope === "ego") {
    const root = opts.root ?? "";
    nodePaths = new Set<string>();
    if (known.has(root)) {
      const depth = Math.max(0, opts.depth ?? 1);
      const adj = adjacency(allEdges);
      let frontier = new Set<string>([root]);
      nodePaths.add(root);
      for (let d = 0; d < depth; d++) {
        const next = new Set<string>();
        for (const n of frontier) {
          for (const m of adj.get(n) ?? []) {
            if (!nodePaths.has(m)) {
              next.add(m);
              nodePaths.add(m);
            }
          }
        }
        if (next.size === 0) break;
        frontier = next;
      }
    }
  }

  const total = nodePaths.size;

  // Cap (R8): if over the cap, keep the highest-degree nodes (most connected =
  // most informative), deterministic tiebreak by path. The root, if any, is
  // always retained.
  const cap = opts.cap ?? DEFAULT_NODE_CAP;
  let truncated = false;
  if (nodePaths.size > cap) {
    truncated = true;
    const adj = adjacency(allEdges.filter((e) => nodePaths.has(e.from) && nodePaths.has(e.to)));
    const ranked = [...nodePaths].sort((a, b) => {
      const da = adj.get(a)?.size ?? 0;
      const db = adj.get(b)?.size ?? 0;
      return db - da || a.localeCompare(b);
    });
    const keep = new Set(ranked.slice(0, cap));
    if (opts.scope === "ego" && opts.root && known.has(opts.root)) keep.add(opts.root);
    nodePaths = keep;
  }

  const nodes: GraphNode[] = input.docs
    .filter((d) => nodePaths.has(d.path))
    .map((d) => ({
      path: d.path,
      title: d.title,
      collection: d.collection,
      tier: d.tier,
      status: d.status,
      decayed: input.decayed.has(d.path),
      contested: contestedNodes.has(d.path),
    }))
    .sort((a, b) => (a.title || a.path).localeCompare(b.title || b.path));

  allEdges = allEdges.filter((e) => nodePaths.has(e.from) && nodePaths.has(e.to));

  return { nodes, edges: allEdges, total, shown: nodes.length, truncated };
}
