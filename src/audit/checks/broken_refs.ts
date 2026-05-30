// src/audit/checks/broken_refs.ts
// Pure function: given snapshots and classified edges, return every broken
// reference as a BrokenRefFinding. No throws. No classes.
//
// Resolution logic:
//   1. Look up target repo by name; if not found → missing_file.
//   2. Look up targetPath in that repo's docs Map.
//   3. If not found and targetPath lacks a ".md" extension, try targetPath +
//      ".md" (spec §7 bare-path fallback).
//   4. If still not found → missing_file.
//   5. If found and targetAnchor is set: check DocSnapshot.headings. If absent
//      → missing_anchor.

import type { BrokenRefFinding, LinkEdge, RepoSnapshot } from "../types.js";

export function checkBrokenRefs(snapshots: RepoSnapshot[], edges: LinkEdge[]): BrokenRefFinding[] {
  // Index snapshots by repo name for O(1) lookup.
  const byRepo = new Map<string, RepoSnapshot>();
  for (const snap of snapshots) {
    byRepo.set(snap.config.name, snap);
  }

  const findings: BrokenRefFinding[] = [];

  for (const edge of edges) {
    const targetSnap = byRepo.get(edge.targetRepo);
    if (!targetSnap) {
      // Target repo itself is unknown — treat as missing file.
      findings.push({
        kind: "missing_file",
        source: { repo: edge.sourceRepo, path: edge.sourcePath },
        target: { repo: edge.targetRepo, path: edge.targetPath, anchor: edge.targetAnchor },
        rawHref: edge.rawHref,
      });
      continue;
    }

    // Resolve the target doc: exact match, then .md fallback.
    let resolvedPath: string | null = null;
    if (targetSnap.docs.has(edge.targetPath)) {
      resolvedPath = edge.targetPath;
    } else if (!edge.targetPath.endsWith(".md")) {
      const withMd = edge.targetPath + ".md";
      if (targetSnap.docs.has(withMd)) {
        resolvedPath = withMd;
      }
    }

    if (resolvedPath === null) {
      findings.push({
        kind: "missing_file",
        source: { repo: edge.sourceRepo, path: edge.sourcePath },
        target: { repo: edge.targetRepo, path: edge.targetPath, anchor: edge.targetAnchor },
        rawHref: edge.rawHref,
      });
      continue;
    }

    // File found. Check anchor if present.
    if (edge.targetAnchor !== null) {
      const doc = targetSnap.docs.get(resolvedPath)!;
      if (!doc.headings.has(edge.targetAnchor)) {
        findings.push({
          kind: "missing_anchor",
          source: { repo: edge.sourceRepo, path: edge.sourcePath },
          target: { repo: edge.targetRepo, path: resolvedPath, anchor: edge.targetAnchor },
          rawHref: edge.rawHref,
        });
      }
    }
  }

  return findings;
}
