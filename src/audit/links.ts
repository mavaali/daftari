// src/audit/links.ts
// Link extraction + classification. Regex-only (no markdown parser dep — v1
// scope per plan resolution #1). Edges are classified by URL pattern match
// (with prefix-boundary check, resolution #6) or relative-path escape into
// another configured repo.

import { relative as nodeRelative, resolve as nodeResolve, posix } from "node:path";
import type { LinkEdge, LinkRef, RepoSnapshot } from "./types.js";

const MD_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

function splitAnchor(rawHref: string): { href: string; anchor: string | null } {
  const hashIdx = rawHref.indexOf("#");
  if (hashIdx === -1) return { href: rawHref, anchor: null };
  return {
    href: rawHref.slice(0, hashIdx),
    anchor: rawHref.slice(hashIdx + 1) || null,
  };
}

export function extractLinksFromBody(body: string): LinkRef[] {
  const out: LinkRef[] = [];
  for (const m of body.matchAll(MD_LINK_RE)) {
    const rawHref = (m[2] as string).trim();
    if (!rawHref) continue;
    const { href, anchor } = splitAnchor(rawHref);
    const isUrl = /^https?:\/\//i.test(rawHref);
    const isRelative =
      !isUrl &&
      !rawHref.startsWith("#") &&
      !rawHref.startsWith("/") &&
      !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawHref); // any scheme like mailto:
    out.push({ rawHref, href, anchor, isUrl, isRelative });
  }
  return out;
}

// A URL pattern matches a URL iff the URL's host+path starts with the pattern
// AND the next char in the URL is /, #, ?, or end-of-string. This rejects
// substring matches like `github.com/org/service-a-tools` against pattern
// `github.com/org/service-a`.
function urlMatchesPattern(url: string, pattern: string): boolean {
  const stripped = url.replace(/^https?:\/\//i, "");
  if (!stripped.startsWith(pattern)) return false;
  const next = stripped.charAt(pattern.length);
  return next === "" || next === "/" || next === "#" || next === "?";
}

// Pulls the path-after-pattern out of a known-matching URL: strips scheme,
// pattern, and the GitHub blob/tree/... prefix when present. Returns relPath
// + optional anchor.
function extractTargetPathFromUrl(
  url: string,
  pattern: string,
): { relPath: string; anchor: string | null } | null {
  const stripped = url.replace(/^https?:\/\//i, "");
  const rest = stripped.slice(pattern.length); // starts with "/" or ""
  if (rest === "") return null; // pattern alone, no file
  // strip leading "/"
  let tail = rest.startsWith("/") ? rest.slice(1) : rest;
  // Split anchor / query
  const queryIdx = tail.indexOf("?");
  if (queryIdx !== -1) tail = tail.slice(0, queryIdx);
  const hashIdx = tail.indexOf("#");
  const anchor = hashIdx !== -1 ? tail.slice(hashIdx + 1) || null : null;
  if (hashIdx !== -1) tail = tail.slice(0, hashIdx);
  if (!tail) return null;
  // GitHub URLs: /blob/<branch>/<path> or /tree/<branch>/<path>.
  // Strip if present; otherwise treat `tail` as the relPath directly.
  const ghMatch = tail.match(/^(blob|tree|raw)\/[^/]+\/(.+)$/);
  const relPath = ghMatch ? (ghMatch[2] as string) : tail;
  return { relPath: posix.normalize(relPath), anchor };
}

// Note: repo.config.path values are always real (symlink-resolved) paths —
// config.ts#validateRepoPath calls realpathSync() before storing them. The
// containment check below (`rel.startsWith("..")`) is therefore symlink-safe
// for the source side. The resolved href target itself is not realpathSync'd
// because it may not exist on disk (that's what broken_refs.ts catches).
// Reference-style links `[text][ref]` are intentionally NOT extracted in v1
// (audit operates on arbitrary markdown repos without needing full AST parsing;
// mention here per plan resolution #1).
function resolveRelative(
  fromRepoPath: string,
  fromRelPath: string,
  href: string,
  repos: RepoSnapshot[],
): { repo: string; relPath: string } | null {
  const fromAbs = nodeResolve(fromRepoPath, fromRelPath);
  const fromDir = nodeResolve(fromAbs, "..");
  const resolvedAbs = nodeResolve(fromDir, href);
  for (const repo of repos) {
    const rel = nodeRelative(repo.config.path, resolvedAbs);
    if (!rel.startsWith("..") && !nodeResolve(repo.config.path, rel).startsWith("..")) {
      // posix-normalize for cross-platform sanity
      const posixRel = rel.split(/[\\/]/).join("/");
      return { repo: repo.config.name, relPath: posixRel };
    }
  }
  return null;
}

export function classifyEdges(snapshots: RepoSnapshot[]): LinkEdge[] {
  const edges: LinkEdge[] = [];
  for (const snap of snapshots) {
    const sourceRepo = snap.config.name;
    for (const doc of snap.docs.values()) {
      for (const link of doc.links) {
        if (link.isUrl) {
          // Try each repo's url patterns. First match wins.
          let matched = false;
          for (const targetSnap of snapshots) {
            for (const pattern of targetSnap.config.urls) {
              if (!urlMatchesPattern(link.href, pattern)) continue;
              const target = extractTargetPathFromUrl(link.href, pattern);
              if (!target) continue;
              edges.push({
                sourceRepo,
                sourcePath: doc.relPath,
                targetRepo: targetSnap.config.name,
                targetPath: target.relPath,
                targetAnchor: target.anchor ?? link.anchor,
                rawHref: link.rawHref,
              });
              matched = true;
              break;
            }
            if (matched) break;
          }
          // Unmatched URLs are external (no configured repo owns them); drop.
          // Per plan resolution #3: anonymous repos get no urls[], and URLs
          // targeting unconfigured repos go silently unflagged in v1.
          continue;
        }
        if (!link.isRelative) continue; // anchors-only, mailto:, etc.

        const resolved = resolveRelative(snap.config.path, doc.relPath, link.href, snapshots);
        if (!resolved) {
          // Escaped to an unconfigured location; record as edge into sourceRepo
          // with an unresolvable path so broken_refs flags it.
          edges.push({
            sourceRepo,
            sourcePath: doc.relPath,
            targetRepo: sourceRepo,
            targetPath: link.href, // unresolved sentinel
            targetAnchor: link.anchor,
            rawHref: link.rawHref,
          });
          continue;
        }
        edges.push({
          sourceRepo,
          sourcePath: doc.relPath,
          targetRepo: resolved.repo,
          targetPath: resolved.relPath,
          targetAnchor: link.anchor,
          rawHref: link.rawHref,
        });
      }
    }
  }
  return edges;
}
