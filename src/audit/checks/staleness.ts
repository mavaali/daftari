// src/audit/checks/staleness.ts
// Memoized BFS from each fresh doc to the nearest directly-stale leaf. BFS
// (not DFS) so the recorded chain is the shortest path. Cycles handled by
// the BFS visited set; verdicts memoized across roots.

import type { LinkEdge, RepoSnapshot, StalenessFinding } from "../types.js";

type NodeKey = string; // "repo\x20relPath" (space-separated to avoid collisions)
const key = (repo: string, path: string): NodeKey => `${repo} ${path}`;

function isDirectlyStale(mtimeIso: string, now: Date, thresholdDays: number): boolean {
  const ms = now.getTime() - new Date(mtimeIso).getTime();
  return ms > thresholdDays * 86_400_000;
}

type Chain = Array<{ repo: string; path: string; mtime: string }>;

export function checkStaleness(
  snapshots: RepoSnapshot[],
  edges: LinkEdge[],
  thresholdDays: number,
  now: Date,
): StalenessFinding[] {
  // Build node info + adjacency list.
  type NodeInfo = { repo: string; path: string; mtime: string };
  const nodes = new Map<NodeKey, NodeInfo>();
  for (const snap of snapshots) {
    // Code repos are reference targets, not managed documents — they carry no
    // lifecycle and a stub mtime, so they never participate in staleness.
    if (snap.config.type === "code") continue;
    for (const d of snap.docs.values()) {
      nodes.set(key(snap.config.name, d.relPath), {
        repo: snap.config.name,
        path: d.relPath,
        mtime: d.mtime,
      });
    }
  }
  const adj = new Map<NodeKey, NodeKey[]>();
  for (const edge of edges) {
    const src = key(edge.sourceRepo, edge.sourcePath);
    const dst = key(edge.targetRepo, edge.targetPath);
    // Resolve the dst against the .md-extension fallback so transitive edges
    // see the same node identity broken-refs check does.
    let dstKey = dst;
    if (!nodes.has(dstKey)) {
      const alt = key(edge.targetRepo, `${edge.targetPath}.md`);
      if (nodes.has(alt)) dstKey = alt;
    }
    if (!nodes.has(dstKey)) continue; // dangling edge — broken_refs handles it
    if (!nodes.has(src)) continue;
    const list = adj.get(src) ?? [];
    list.push(dstKey);
    adj.set(src, list);
  }

  // Classify directly stale leaves.
  const direct = new Set<NodeKey>();
  for (const [k, info] of nodes) {
    if (isDirectlyStale(info.mtime, now, thresholdDays)) direct.add(k);
  }

  // BFS from each fresh root to find shortest path to a stale node.
  // Memoize the shortest chain per node so a second root reaching it
  // doesn't recompute.
  const shortestChain = new Map<NodeKey, Chain | null>(); // null = no stale path

  function chainFor(root: NodeKey): Chain | null {
    if (direct.has(root)) return null; // direct, not transitive
    if (shortestChain.has(root)) return shortestChain.get(root) ?? null;
    const prev = new Map<NodeKey, NodeKey | null>();
    prev.set(root, null);
    const queue: NodeKey[] = [root];
    let target: NodeKey | null = null;
    while (queue.length > 0) {
      const cur = queue.shift() as NodeKey;
      if (cur !== root && direct.has(cur)) {
        target = cur;
        break;
      }
      for (const next of adj.get(cur) ?? []) {
        if (prev.has(next)) continue;
        prev.set(next, cur);
        queue.push(next);
      }
    }
    if (!target) {
      shortestChain.set(root, null);
      return null;
    }
    const path: NodeKey[] = [];
    let n: NodeKey | null = target;
    while (n) {
      path.unshift(n);
      n = prev.get(n) ?? null;
    }
    const chain: Chain = path.map((k) => {
      const info = nodes.get(k) as NodeInfo;
      return { repo: info.repo, path: info.path, mtime: info.mtime };
    });
    shortestChain.set(root, chain);
    return chain;
  }

  const findings: StalenessFinding[] = [];
  for (const [k, info] of nodes) {
    if (direct.has(k)) {
      findings.push({
        kind: "direct",
        repo: info.repo,
        path: info.path,
        mtime: info.mtime,
      });
      continue;
    }
    const chain = chainFor(k);
    if (chain) {
      findings.push({
        kind: "transitive",
        repo: info.repo,
        path: info.path,
        mtime: info.mtime,
        staleChain: chain,
      });
    }
  }
  return findings;
}
