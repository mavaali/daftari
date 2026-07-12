// Tension clusters — Phase 2 of the tension graph plan (2026-05-31).
//
// A "cluster" is a connected component of the tension graph: a maximal set of
// documents joined transitively by in-scope tensions. Clusters surface the
// regions of the vault where contradiction is composing rather than just
// pairwise.
//
// In-scope = "live contested." A tension contributes an edge iff:
//   - `resolved: false`, AND
//   - `resolution.kind !== "accepted"`
//
// The two conditions reduce to `!resolved` in the current data model
// (resolveTension always sets resolved: true), but the spec phrases them
// separately for forward-compatibility. We keep both for the same reason.
//
// Cluster IDs are content-addressed (spec, Gap 3):
//   "cluster:" + first 8 hex chars of sha256(canonical-sorted member paths
//   joined by "\n").
// Same membership → identical ID across runs. Membership change → different
// ID. A merged cluster's ID matches neither predecessor's, which is the
// correct semantic: a different membership is genuinely a different cluster.

import { createHash } from "node:crypto";
import { err, ok, type Result } from "../frontmatter/types.js";
import { ageInDays } from "./staleness.js";
import { listTensions, TENSION_KINDS, type TensionEntry, type TensionKind } from "./tension.js";

export interface TensionCluster {
  id: string;
  size: number;
  documents: string[];
  tension_count: number;
  kinds: Record<TensionKind, number>;
  oldest_tension_age_days: number;
  newest_tension_age_days: number;
}

export interface TensionClustersResult {
  cluster_count: number;
  clusters: TensionCluster[];
}

// Returns true iff the tension participates in cluster formation. Spec:
// "Cluster scope" — only unresolved, non-accepted tensions form edges.
function inScope(entry: TensionEntry): boolean {
  if (entry.resolved) return false;
  if (entry.resolution?.kind === "accepted") return false;
  // Self-loops contribute nothing to clustering and would inflate
  // tension_count for no reason; defensive filter.
  if (entry.sourceA === entry.sourceB) return false;
  // Either endpoint missing means a malformed entry; skip rather than crash.
  if (!entry.sourceA || !entry.sourceB) return false;
  return true;
}

// Union-find with path compression. No rank tracking — at the tension-log
// scale this is unnecessary and a class would violate the project style rule.
function ufFind(parent: Map<string, string>, x: string): string {
  if (!parent.has(x)) {
    parent.set(x, x);
    return x;
  }
  let root = x;
  while (parent.get(root) !== root) {
    root = parent.get(root) as string;
  }
  // Path compression on the second pass.
  let cur = x;
  while (parent.get(cur) !== root) {
    const next = parent.get(cur) as string;
    parent.set(cur, root);
    cur = next;
  }
  return root;
}

function ufUnion(parent: Map<string, string>, a: string, b: string): void {
  const ra = ufFind(parent, a);
  const rb = ufFind(parent, b);
  if (ra !== rb) parent.set(ra, rb);
}

// Content-addressed cluster id. The hash input is the canonical-sorted
// member list joined by newlines — the same canonicalization used to render
// the `documents` field, so the ID and the visible member list cannot drift
// out of sync.
function clusterIdFor(sortedMembers: string[]): string {
  const canonical = sortedMembers.join("\n");
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `cluster:${digest.slice(0, 8)}`;
}

// Pure computation over a tension list. Synthetic-entry tests and the vault
// loader both go through this function so the algorithm is exercised
// identically in either path.
export function computeTensionClusters(
  tensions: TensionEntry[],
  now: Date = new Date(),
): TensionClustersResult {
  const scoped = tensions.filter(inScope);
  if (scoped.length === 0) return { cluster_count: 0, clusters: [] };

  const parent = new Map<string, string>();
  for (const t of scoped) {
    ufUnion(parent, t.sourceA, t.sourceB);
  }

  // Group every document by its component root. The root key itself is not
  // user-visible — it's a UF artifact — so we re-key by the content-addressed
  // cluster id once members are known.
  const docsByRoot = new Map<string, Set<string>>();
  for (const doc of parent.keys()) {
    const root = ufFind(parent, doc);
    if (!docsByRoot.has(root)) docsByRoot.set(root, new Set());
    (docsByRoot.get(root) as Set<string>).add(doc);
  }

  // For each component, collect every tension whose endpoints both fall in
  // the component. (By construction every in-scope tension's endpoints share
  // a root — but we re-check rather than assume, so the count is provably
  // correct.)
  const tensionsByRoot = new Map<string, TensionEntry[]>();
  for (const t of scoped) {
    const root = ufFind(parent, t.sourceA);
    const otherRoot = ufFind(parent, t.sourceB);
    if (root !== otherRoot) continue;
    if (!tensionsByRoot.has(root)) tensionsByRoot.set(root, []);
    (tensionsByRoot.get(root) as TensionEntry[]).push(t);
  }

  const clusters: TensionCluster[] = [];
  for (const [root, docSet] of docsByRoot) {
    const members = [...docSet].sort();
    const id = clusterIdFor(members);
    const clusterTensions = tensionsByRoot.get(root) ?? [];

    const kinds = Object.fromEntries(TENSION_KINDS.map((k) => [k, 0])) as Record<
      TensionKind,
      number
    >;
    let oldest = 0;
    let newest = Number.POSITIVE_INFINITY;
    for (const t of clusterTensions) {
      kinds[t.kind] += 1;
      const age = ageInDays(t.date, now);
      if (age > oldest) oldest = age;
      if (age < newest) newest = age;
    }
    if (!Number.isFinite(newest)) newest = 0;

    clusters.push({
      id,
      size: members.length,
      documents: members,
      tension_count: clusterTensions.length,
      kinds,
      oldest_tension_age_days: oldest,
      newest_tension_age_days: newest,
    });
  }

  // Largest cluster first; ties broken by id ASCII ascending so the order is
  // deterministic across runs even when sizes collide.
  clusters.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return { cluster_count: clusters.length, clusters };
}

// Async wrapper that reads the vault's tension log and runs the computation.
// Mirrors the listTensions / addTension / resolveTension Result contract.
export async function loadTensionClusters(
  vaultRoot: string,
  now: Date = new Date(),
  // Visibility policy injected by the tool layer (#212) so this module never
  // imports RBAC. Identity when omitted — non-tool callers see everything.
  entryFilter: (entries: TensionEntry[]) => TensionEntry[] = (e) => e,
): Promise<Result<TensionClustersResult, Error>> {
  const tensions = await listTensions(vaultRoot);
  if (!tensions.ok) return err(tensions.error);
  return ok(computeTensionClusters(entryFilter(tensions.value), now));
}
