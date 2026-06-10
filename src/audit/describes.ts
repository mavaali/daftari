// src/audit/describes.ts
// Doc-to-code binding edges. Reads `describes` frontmatter entries off docs-repo
// documents, parses the `repo:path::symbol` form, and emits cross-repo edges
// that the reference-integrity check (checks/describes_refs.ts) verifies against
// the resolved target repo.

import type { DescribesEdge, RepoSnapshot } from "./types.js";

export interface ParsedDescribes {
  repo: string; // resolved repo name — sourceRepo for a bare (prefix-less) entry
  path: string; // repo-relative code path
  symbol: string | null; // `::symbol` suffix, retained but unresolved in v1
}

// Grammar (file-level in v1):
//   <entry>  := [<repo> ":"] <path> ["::" <symbol>]
// The `::` symbol delimiter is split off first so a single ":" inside the
// remainder unambiguously marks the repo prefix. A prefix-less entry resolves
// against `sourceRepo` (the repo the declaring doc lives in).
export function parseDescribesEntry(entry: string, sourceRepo: string): ParsedDescribes {
  const symbolIdx = entry.indexOf("::");
  const symbol = symbolIdx === -1 ? null : entry.slice(symbolIdx + 2).trim() || null;
  const head = symbolIdx === -1 ? entry : entry.slice(0, symbolIdx);

  const colonIdx = head.indexOf(":");
  if (colonIdx === -1) {
    return { repo: sourceRepo, path: head.trim(), symbol };
  }
  return {
    repo: head.slice(0, colonIdx).trim(),
    path: head.slice(colonIdx + 1).trim(),
    symbol,
  };
}

// One edge per describes entry on every docs-repo document. Code repos are
// reference targets only and never act as edge sources.
export function classifyDescribesEdges(snapshots: RepoSnapshot[]): DescribesEdge[] {
  const edges: DescribesEdge[] = [];
  for (const snap of snapshots) {
    if (snap.config.type === "code") continue;
    const sourceRepo = snap.config.name;
    for (const doc of snap.docs.values()) {
      for (const raw of doc.describes ?? []) {
        const parsed = parseDescribesEntry(raw, sourceRepo);
        edges.push({
          sourceRepo,
          sourcePath: doc.relPath,
          targetRepo: parsed.repo,
          targetPath: parsed.path,
          symbol: parsed.symbol,
          raw,
        });
      }
    }
  }
  return edges;
}
