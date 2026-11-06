// superseded_by chains at the document level (#639).
//
// superseded_by is a forward pointer, so a topic's lineage is a chain whose
// last entry is meant to be its current document. Two shapes break that: a
// loop, which has no last entry at all, and a chain ending on a document that
// is not canonical. Both leave a topic silently without a current entry.
//
// The doc set is the resolution universe, as in tier0.ts. Both callers pass the
// caller-visible subset, so a pointer into a hidden doc reads as dangling and
// neither surface answers for an edge the caller cannot read.

import type { LintFinding } from "./lint.js";
import { buildPathIndexes, type LoadedDoc, resolveLink } from "./vault-docs.js";

// One document's superseded_by as a write would leave it; null clears it.
export type SupersedeEdit = readonly [path: string, supersededBy: string | null];

type EdgeDoc = Pick<LoadedDoc, "path"> & {
  frontmatter: Pick<LoadedDoc["frontmatter"], "superseded_by">;
};

// Resolved path → successor path. A pointer that does not resolve is no edge:
// brokenSourceRefs owns dangling references.
function supersedeEdges(docs: EdgeDoc[], edits: readonly SupersedeEdit[] = []) {
  // Deduped: buildPathIndexes reads a repeated path as an ambiguous basename.
  const paths = new Set([...docs.map((d) => d.path), ...edits.map(([path]) => path)]);
  const { byPath, byBasename } = buildPathIndexes([...paths].map((path) => ({ path })));
  const edges = new Map<string, string>();
  const put = (path: string, supersededBy: string | null) => {
    const target = supersededBy ? resolveLink(supersededBy, path, byPath, byBasename) : null;
    if (target) edges.set(path, target);
    else edges.delete(path);
  };
  for (const doc of docs) put(doc.path, doc.frontmatter.superseded_by);
  for (const [path, supersededBy] of edits) put(path, supersededBy);
  return edges;
}

// Would applying these edits put an edited document on a loop? An existing
// loop elsewhere does not count, so a write repairing one is never refused.
export function closesSupersedeLoop(docs: EdgeDoc[], edits: readonly SupersedeEdit[]): boolean {
  const edges = supersedeEdges(docs, edits);
  return edits.some(([start]) => {
    const seen = new Set<string>();
    let at = edges.get(start);
    while (at !== undefined && !seen.has(at)) {
      if (at === start) return true;
      seen.add(at);
      at = edges.get(at);
    }
    return false;
  });
}

// One finding per loop, on its lexically first member, and one per
// non-canonical last entry, naming the chains' heads. A doc feeding into a
// loop is not reported apart from it, and a last entry still carrying a
// pointer that did not resolve is no last entry: the chain continues somewhere
// this doc set cannot see.
export function supersedeChainFindings(docs: LoadedDoc[]): LintFinding[] {
  const edges = supersedeEdges(docs);
  const docByPath = new Map(docs.map((d) => [d.path, d]));
  const successors = new Set(edges.values());
  const loops = new Map<string, string[]>();
  const headsByEnd = new Map<string, string[]>();

  for (const start of edges.keys()) {
    const walk: string[] = [];
    let at: string | undefined = start;
    while (at !== undefined && !walk.includes(at)) {
      walk.push(at);
      at = edges.get(at);
    }
    if (at !== undefined) {
      const loop = walk.slice(walk.indexOf(at));
      const first = [...loop].sort()[0] as string;
      const pivot = loop.indexOf(first);
      loops.set(first, [...loop.slice(pivot), ...loop.slice(0, pivot)]);
    } else if (!successors.has(start)) {
      const end = walk.at(-1) as string;
      headsByEnd.set(end, [...(headsByEnd.get(end) ?? []), start]);
    }
  }

  const findings: LintFinding[] = [];
  for (const [path, loop] of loops) {
    findings.push({
      path,
      detail: `superseded_by loop, no current entry: ${[...loop, path].join(" -> ")}`,
    });
  }
  for (const [path, heads] of headsByEnd) {
    const fm = docByPath.get(path)?.frontmatter;
    if (!fm || fm.status === "canonical" || fm.superseded_by) continue;
    findings.push({
      path,
      detail: `last entry of the superseded_by chain from ${heads.sort().join(", ")} is ${fm.status}, not canonical`,
    });
  }
  return findings.sort((a, b) => a.path.localeCompare(b.path));
}
