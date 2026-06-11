// src/audit/checks/describes_refs.ts
// Reference integrity for doc-to-code bindings. Given describes edges and the
// repo snapshots, returns a finding for every edge whose target repo is unknown
// or whose target file is absent from that repo. Pure function. No throws.
//
// Resolution is file-level: the `::symbol` suffix is carried into the finding
// but never affects whether the binding is considered broken (v1 scope). There
// is no `.md`-extension fallback — describes targets are exact code paths.

import type { DescribesEdge, DescribesRefFinding, RepoSnapshot } from "../types.js";

export function checkDescribesRefs(
  snapshots: RepoSnapshot[],
  edges: DescribesEdge[],
): DescribesRefFinding[] {
  const byRepo = new Map<string, RepoSnapshot>();
  for (const snap of snapshots) byRepo.set(snap.config.name, snap);

  const findings: DescribesRefFinding[] = [];
  for (const e of edges) {
    const targetSnap = byRepo.get(e.targetRepo);
    const exists = targetSnap?.docs.has(e.targetPath) ?? false;
    if (!exists) {
      findings.push({
        source: { repo: e.sourceRepo, path: e.sourcePath },
        target: { repo: e.targetRepo, path: e.targetPath, symbol: e.symbol },
        raw: e.raw,
      });
    }
  }
  return findings;
}
