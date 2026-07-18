// src/audit/checks/broken_refs.ts
// Pure function: given snapshots and classified edges, return every broken
// reference as a BrokenRefFinding. No throws. No classes. Disk access enters
// ONLY through the injected `existsWithin` oracle — the orchestrator passes
// collect.ts's symlink-safe implementation; tests pass a fake; omitting it
// reproduces the index-only behavior. The oracle receives the CONTAINMENT
// ROOT alongside the target because existence and confinement must be
// decided together: a lexical check here plus a bare exists() there would
// let a committed symlink (repo/escape -> /) walk the probe back out.
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

import { isAbsolute, relative as nodeRelative, resolve as nodeResolve } from "node:path";
import type { BrokenRefFinding, LinkEdge, RepoSnapshot } from "../types.js";

// True iff `abs` sits at or under `root` (lexical containment; both sides are
// already-resolved absolute paths).
function within(root: string, abs: string): boolean {
  const rel = nodeRelative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function checkBrokenRefs(
  snapshots: RepoSnapshot[],
  edges: LinkEdge[],
  // Must return true only when targetAbs exists on disk AND its REAL
  // (symlink-resolved) location sits under rootAbs. See
  // collect.ts#symlinkSafeExistsWithin for the production implementation.
  existsWithin?: (rootAbs: string, targetAbs: string) => boolean,
): BrokenRefFinding[] {
  // Index snapshots by repo name for O(1) lookup.
  const byRepo = new Map<string, RepoSnapshot>();
  for (const snap of snapshots) {
    byRepo.set(snap.config.name, snap);
  }

  // The existence oracle is CONFINED (security review on #255): probing an
  // arbitrary resolvedAbs would let anyone who can author a doc turn the
  // audit report into a host-filesystem existence probe
  // ([x](../../../../etc/shadow) → out_of_scope_target vs missing_file).
  // #133's actual case is UNAUDITED SIBLINGS, so out-of-scope probes are
  // allowed only under the parent directories of the configured repo roots;
  // anything further out is reported missing_file without ever touching
  // disk — exactly the pre-oracle behavior. A repo mounted directly under
  // the filesystem root gets NO sibling scope: its "parent" would be the
  // entire filesystem and the confinement would collapse to none, so
  // out-of-scope refs from such a repo stay unprobed.
  const siblingScopes = snapshots.flatMap((s) => {
    const parent = nodeResolve(s.config.path, "..");
    return nodeResolve(parent, "..") === parent ? [] : [parent];
  });

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
        // it does not scan. The probe runs only inside the sibling scopes
        // (see above); a target beyond them is missing_file, unprobed.
        const resolvedAbs = edge.resolvedAbs;
        // Lexical pre-filter picks the candidate scope without touching
        // disk; the oracle then re-verifies containment on REAL paths.
        const scope =
          resolvedAbs !== undefined ? siblingScopes.find((s) => within(s, resolvedAbs)) : undefined;
        findings.push(
          finding(
            resolvedAbs !== undefined && scope !== undefined && existsWithin?.(scope, resolvedAbs)
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
      // The probe is confined to the target repo root: a URL-derived
      // targetPath can carry ../ segments, and escaping paths must not be
      // probed (same oracle concern as above).
      const abs = nodeResolve(targetSnap.config.path, edge.targetPath);
      if (within(targetSnap.config.path, abs) && existsWithin?.(targetSnap.config.path, abs)) {
        continue;
      }
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
