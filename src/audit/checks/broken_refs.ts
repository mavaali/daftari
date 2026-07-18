// src/audit/checks/broken_refs.ts
// Pure function: given snapshots and classified edges, return every broken
// reference as a BrokenRefFinding. No throws. No classes. Disk access enters
// ONLY through the injected `existsOnDisk` oracle — the orchestrator passes
// fs.existsSync; tests pass a fake; omitting it reproduces the index-only
// behavior.
//
// Resolution logic:
//   1. Look up target repo by name; if not found → missing_file.
//   2. Look up targetPath in that repo's docs Map.
//   3. If not found and targetPath lacks a ".md" extension, try targetPath +
//      ".md" (spec §7 bare-path fallback).
//   4. Still not found, edge escaped every configured repo (outOfScope):
//      existing on disk → out_of_scope_target (the audit can't vouch for it,
//      but the link is not broken — #133); absent → missing_file.
//   5. Still not found, in-scope: existing on disk → NOT a finding — the doc
//      index only holds glob-matched markdown, and references to real assets
//      (.png, .pdf, .dagitty, …) are legitimate (#132). Anchors into such
//      files are unverifiable and deliberately not flagged.
//   6. Otherwise → missing_file.
//   7. If found and targetAnchor is set: check DocSnapshot.headings. If absent
//      → missing_anchor.

import { resolve as nodeResolve } from "node:path";
import type { BrokenRefFinding, LinkEdge, RepoSnapshot } from "../types.js";

export function checkBrokenRefs(
  snapshots: RepoSnapshot[],
  edges: LinkEdge[],
  existsOnDisk?: (absPath: string) => boolean,
): BrokenRefFinding[] {
  // Index snapshots by repo name for O(1) lookup.
  const byRepo = new Map<string, RepoSnapshot>();
  for (const snap of snapshots) {
    byRepo.set(snap.config.name, snap);
  }

  const findings: BrokenRefFinding[] = [];

  for (const edge of edges) {
    const finding = (kind: BrokenRefFinding["kind"], path: string): BrokenRefFinding => ({
      kind,
      source: { repo: edge.sourceRepo, path: edge.sourcePath },
      target: { repo: edge.targetRepo, path, anchor: edge.targetAnchor },
      rawHref: edge.rawHref,
    });

    const targetSnap = byRepo.get(edge.targetRepo);
    if (!targetSnap) {
      // Target repo itself is unknown — treat as missing file.
      findings.push(finding("missing_file", edge.targetPath));
      continue;
    }

    // Resolve the target doc: exact match, then .md fallback.
    let resolvedPath: string | null = null;
    if (targetSnap.docs.has(edge.targetPath)) {
      resolvedPath = edge.targetPath;
    } else if (!edge.targetPath.endsWith(".md")) {
      const withMd = `${edge.targetPath}.md`;
      if (targetSnap.docs.has(withMd)) {
        resolvedPath = withMd;
      }
    }

    if (resolvedPath === null) {
      if (edge.outOfScope) {
        // The href escaped every audited repo (#133). A file that exists out
        // there is not a broken link — but it stays VISIBLE with its own
        // kind, never silently passed: the audit cannot vouch for a target
        // it does not scan.
        findings.push(
          finding(
            edge.resolvedAbs && existsOnDisk?.(edge.resolvedAbs)
              ? "out_of_scope_target"
              : "missing_file",
            edge.targetPath,
          ),
        );
        continue;
      }
      // In-scope miss: the docs map only holds glob-matched markdown, but a
      // reference to a real on-disk asset is legitimate (#132) — one
      // existence probe, no finding. Anchors into assets are unverifiable.
      const abs = nodeResolve(targetSnap.config.path, edge.targetPath);
      if (existsOnDisk?.(abs)) continue;
      findings.push(finding("missing_file", edge.targetPath));
      continue;
    }

    // File found. Check anchor if present.
    if (edge.targetAnchor !== null) {
      const doc = targetSnap.docs.get(resolvedPath);
      if (doc && !doc.headings.has(edge.targetAnchor)) {
        findings.push(finding("missing_anchor", resolvedPath));
      }
    }
  }

  return findings;
}
