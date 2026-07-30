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
  for (const e of edges.value) link(e.fromPath, e.toPath);

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
