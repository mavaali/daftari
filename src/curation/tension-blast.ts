// Tension blast radius — Phase 3 of the tension graph plan (2026-05-31).
//
// "Blast" is the transitive closure of downstream documents that cite or
// depend on a contested node. Given either a single document or a tension
// cluster, this surface walks the dependency graph and reports the docs
// exposed to that contested state.
//
// Two edge types (spec, Gap 5):
//   - frontmatter `sources` array → "source" edges (primary, high-confidence).
//   - in-vault markdown links     → "link" edges  (advisory).
//
// `superseded_by` is NOT a blast edge. A doc that supersedes a contested doc
// is the *replacement*, not an inheritor — walking the blast through that
// relationship would falsely contaminate the resolution path. The existing
// `deprecated-still-linked` lint check covers the related-but-different
// question of deprecated docs still being cited.
//
// Two confidence channels (spec, Gap 6):
//   - `primary_blast`: count of downstream docs that have at least one
//     incoming source edge from a visited node (a contested member or a doc
//     already in the downstream set).
//   - `advisory_blast`: count of downstream docs reached only via link edges.
//
// A doc reachable via both edge types counts as primary — higher-confidence
// wins. The per-immediate-edge rule matches the spec's "reached via both edge
// types" wording: from the downstream doc's perspective, does any visited
// predecessor cite it via the `sources` frontmatter array?
//
// Two input modes (spec, Gap 7):
//   - document mode: blast for a single doc. Response also identifies the
//     containing cluster (if any) so the agent sees the broader region.
//   - cluster mode: blast for the union of all cluster members. Seeds are
//     never reported as downstream of themselves.
//
// Computation is on-demand — we build the reverse-source and reverse-link
// maps at tool-call time from the loaded docs. There is no maintained graph.
// Cycle protection is implicit: BFS marks nodes visited; a node is never
// re-queued, so a sources b sources a terminates after one round trip.

import { err, ok, type Result } from "../frontmatter/types.js";
import { loadTensionClusters } from "./tension-clusters.js";
import {
  buildPathIndexes,
  extractLinks,
  type LoadedDoc,
  loadDocuments,
  resolveLink,
} from "./vault-docs.js";

export type BlastDependencyType = "source" | "link";

export interface BlastDownstreamEntry {
  path: string;
  dependency_type: BlastDependencyType;
  distance: number;
}

// `cluster_id` and `cluster_documents` document-mode convention: when the
// contested doc is not in any cluster we report `cluster_id: null` and
// `cluster_documents: []` so the response shape is identical across modes —
// the field is always present and the consumer never has to branch on
// undefined-vs-null. In cluster mode `cluster_id` is the input id and
// `cluster_documents` is its membership.
export interface TensionBlastResult {
  contested_document: string | null;
  cluster_id: string | null;
  cluster_documents: string[];
  downstream: BlastDownstreamEntry[];
  primary_blast: number;
  advisory_blast: number;
  max_depth: number;
}

export interface TensionBlastInput {
  document?: string;
  cluster_id?: string;
}

// Reverse-source map: target doc → docs whose frontmatter `sources` cites
// the target. Source paths are resolved through the same path-resolution
// rules as in-vault links (exact match, .md suffix, relative-to-from,
// basename), so author-written shorthand paths like `pricing/foo` line up
// with the canonical `pricing/foo.md`. Unresolved sources (typos, links to
// non-vault material) and self-citations are dropped.
export function buildReverseSourceMap(docs: LoadedDoc[]): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();
  const { byPath, byBasename } = buildPathIndexes(docs);
  for (const d of docs) {
    for (const raw of d.frontmatter.sources ?? []) {
      const target = resolveLink(raw, d.path, byPath, byBasename);
      if (!target || target === d.path) continue;
      if (!reverse.has(target)) reverse.set(target, new Set());
      (reverse.get(target) as Set<string>).add(d.path);
    }
  }
  return reverse;
}

// Reverse-link map: target doc → docs whose body contains an in-vault
// markdown or wikilink to the target. Mirrors lint's inbound-link map but
// exposed as its own helper so blast and lint can't drift.
export function buildReverseLinkMap(docs: LoadedDoc[]): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();
  const { byPath, byBasename } = buildPathIndexes(docs);
  for (const d of docs) {
    for (const raw of extractLinks(d.content)) {
      const target = resolveLink(raw, d.path, byPath, byBasename);
      if (!target || target === d.path) continue;
      if (!reverse.has(target)) reverse.set(target, new Set());
      (reverse.get(target) as Set<string>).add(d.path);
    }
  }
  return reverse;
}

export interface ComputeBlastArgs {
  seeds: string[];
  reverseSource: Map<string, Set<string>>;
  reverseLink: Map<string, Set<string>>;
}

export interface ComputeBlastOutput {
  downstream: BlastDownstreamEntry[];
  primary_blast: number;
  advisory_blast: number;
  max_depth: number;
}

// Pure BFS over the combined edge set. Returns the sorted downstream list,
// the two channel counts, and the max depth observed.
//
// Layered BFS guarantees `distance` is the minimum hop count from any seed;
// the `visited` set is the cycle guard, so a doc is never re-queued.
//
// Channel assignment is per-immediate-edge: a downstream doc D is "source"
// iff some visited node V (a seed or another downstream doc) has D in its
// reverse-source successor list, i.e. D's frontmatter cites V. Otherwise D
// is "link". This matches the spec's "reached via both edge types counts as
// primary" wording while staying decidable from the dependency graph alone.
export function computeBlast(args: ComputeBlastArgs): ComputeBlastOutput {
  const { seeds, reverseSource, reverseLink } = args;
  const seedSet = new Set(seeds);

  const visited = new Set<string>(seeds);
  const distance = new Map<string, number>();
  let frontier = new Set<string>(seeds);
  let depth = 0;
  while (frontier.size > 0) {
    const next = new Set<string>();
    for (const node of frontier) {
      const successors = new Set<string>();
      for (const s of reverseSource.get(node) ?? []) successors.add(s);
      for (const s of reverseLink.get(node) ?? []) successors.add(s);
      for (const succ of successors) {
        if (visited.has(succ)) continue;
        visited.add(succ);
        distance.set(succ, depth + 1);
        next.add(succ);
      }
    }
    frontier = next;
    depth += 1;
  }

  // primaryDownstream: every doc that has at least one incoming source edge
  // from a visited node. Built by iterating each visited node's
  // reverse-source successors; we exclude seeds because the response only
  // surfaces downstream-of-the-contested-set, never the contested set
  // itself.
  const primaryDownstream = new Set<string>();
  for (const v of visited) {
    for (const child of reverseSource.get(v) ?? []) {
      if (seedSet.has(child)) continue;
      primaryDownstream.add(child);
    }
  }

  const entries: BlastDownstreamEntry[] = [];
  for (const [path, dist] of distance) {
    const dependency_type: BlastDependencyType = primaryDownstream.has(path) ? "source" : "link";
    entries.push({ path, dependency_type, distance: dist });
  }

  entries.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (a.dependency_type !== b.dependency_type) {
      return a.dependency_type === "source" ? -1 : 1;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  let primary_blast = 0;
  let advisory_blast = 0;
  let max_depth = 0;
  for (const e of entries) {
    if (e.dependency_type === "source") primary_blast += 1;
    else advisory_blast += 1;
    if (e.distance > max_depth) max_depth = e.distance;
  }

  return { downstream: entries, primary_blast, advisory_blast, max_depth };
}

// Orchestration: validate the exactly-one-of input, load the docs and
// clusters, resolve seeds, build the reverse maps, run the BFS, and assemble
// the response. Returns a Result — tool handlers never throw.
export async function computeTensionBlast(
  vaultRoot: string,
  input: TensionBlastInput,
): Promise<Result<TensionBlastResult, Error>> {
  const hasDoc = typeof input.document === "string" && input.document.length > 0;
  const hasCluster = typeof input.cluster_id === "string" && input.cluster_id.length > 0;
  if (hasDoc && hasCluster) {
    return err(
      new Error("vault_tension_blast accepts exactly one of 'document' or 'cluster_id', not both"),
    );
  }
  if (!hasDoc && !hasCluster) {
    return err(new Error("vault_tension_blast requires exactly one of 'document' or 'cluster_id'"));
  }

  const docsResult = await loadDocuments(vaultRoot);
  if (!docsResult.ok) return docsResult;
  const docs = docsResult.value;
  const knownPaths = new Set(docs.map((d) => d.path));

  const clustersResult = await loadTensionClusters(vaultRoot);
  if (!clustersResult.ok) return clustersResult;
  const clusters = clustersResult.value.clusters;

  let seeds: string[];
  let contested_document: string | null;
  let cluster_id: string | null = null;
  let cluster_documents: string[] = [];

  if (hasDoc) {
    const doc = input.document as string;
    if (!knownPaths.has(doc)) {
      return err(new Error(`vault_tension_blast: document not found in vault: ${doc}`));
    }
    contested_document = doc;
    const containing = clusters.find((c) => c.documents.includes(doc));
    if (containing) {
      cluster_id = containing.id;
      cluster_documents = [...containing.documents];
    }
    seeds = [doc];
  } else {
    const id = input.cluster_id as string;
    const found = clusters.find((c) => c.id === id);
    if (!found) {
      return err(new Error(`vault_tension_blast: cluster_id not found: ${id}`));
    }
    contested_document = null;
    cluster_id = found.id;
    cluster_documents = [...found.documents];
    seeds = [...found.documents];
  }

  const reverseSource = buildReverseSourceMap(docs);
  const reverseLink = buildReverseLinkMap(docs);

  const { downstream, primary_blast, advisory_blast, max_depth } = computeBlast({
    seeds,
    reverseSource,
    reverseLink,
  });

  return ok({
    contested_document,
    cluster_id,
    cluster_documents,
    downstream,
    primary_blast,
    advisory_blast,
    max_depth,
  });
}
