// Topic ego-graph — breadth-first neighborhood over the tension + derives_from graph.
//
// A "topic" for a seed document is the set of docs reachable within `depth` hops
// across an undirected union of two edge kinds: tension pairs (sourceA ↔ sourceB)
// and derives_from edges (from ↔ to). Both kinds are treated as undirected —
// "near in the knowledge graph" is what matters, not causal direction.
//
// Inclusion rule for edge status:
//   - Resolved tensions ARE still topic links: the disagreement is topically real
//     regardless of how it was closed.
//   - Revoked derives_from edges are NOT topic links: revocation means the
//     derivation was contested and invalidated, so the topical connection is gone.

import { listEdges } from "../curation/edges.js";
import { listTensions } from "../curation/tension.js";
import type { Result } from "../frontmatter/types.js";

/** Adjacency over the union of tension pairs and derives_from edges (undirected). */
async function buildAdjacency(vaultRoot: string): Promise<Result<Map<string, Set<string>>, Error>> {
  const adj = new Map<string, Set<string>>();

  const link = (a: string, b: string): void => {
    const setA = adj.get(a) ?? new Set<string>();
    setA.add(b);
    adj.set(a, setA);
    const setB = adj.get(b) ?? new Set<string>();
    setB.add(a);
    adj.set(b, setB);
  };

  // All statuses: a resolved tension is still a topic link.
  const tensions = await listTensions(vaultRoot);
  if (!tensions.ok) return tensions;
  for (const t of tensions.value) link(t.sourceA, t.sourceB);

  const edges = await listEdges(vaultRoot, {});
  if (!edges.ok) return edges;
  for (const e of edges.value) {
    // Revoked edges are excluded: revocation means the derivation was invalidated,
    // so it no longer constitutes a topical connection. Resolved tensions are still
    // included above — the disagreement is topically real even after resolution.
    if (e.status === "revoked") continue;
    link(e.fromPath, e.toPath);
  }

  return { ok: true, value: adj };
}

/** Doc paths within `depth` hops of `seed` over tension+derives_from. Includes the seed. */
export async function topicEgoGraph(
  vaultRoot: string,
  seed: string,
  depth = 2,
): Promise<Result<string[], Error>> {
  const adjRes = await buildAdjacency(vaultRoot);
  if (!adjRes.ok) return adjRes;
  const adj = adjRes.value;

  const visited = new Set<string>([seed]);
  let frontier: string[] = [seed];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const nbr of adj.get(node) ?? []) {
        if (!visited.has(nbr)) {
          visited.add(nbr);
          next.push(nbr);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return { ok: true, value: [...visited] };
}
