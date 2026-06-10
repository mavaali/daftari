// src/audit/types.ts
// Shared types for the coherence audit. Pure data shapes; no logic.

export type AuditConfig = {
  repos: RepoConfig[];
  output: { markdown?: string; json?: string };
  staleness: { thresholdDays: number };
  failOn: { brokenRefs: number; transitiveStaleness: number };
};

// `docs` repos carry Daftari frontmatter and are scanned for links / staleness.
// `code` repos are raw reference targets — indexed by path only, never parsed
// for frontmatter — so doc-to-code `describes` bindings can resolve against them.
export const REPO_TYPES = ["docs", "code"] as const;
export type RepoType = (typeof REPO_TYPES)[number];

export type RepoConfig = {
  name: string;
  path: string; // absolute, real path
  docsGlob: string; // glob relative to path; default "**/*.md"
  urls: string[]; // empty if none configured
  type: RepoType; // "docs" (default) | "code"
};

export type DocSnapshot = {
  relPath: string; // POSIX, repo-relative
  absPath: string;
  mtime: string; // ISO 8601
  mtimeSource: "git" | "fs";
  headings: Set<string>; // slugified, for anchor lookup
  links: LinkRef[];
};

export type LinkRef = {
  rawHref: string; // exactly as it appears in the body
  href: string; // rawHref with anchor split off
  anchor: string | null; // null if no #fragment
  isUrl: boolean; // /^https?:/i
  isRelative: boolean; // !isUrl && doesn't start with "/" or "#" or "mailto:"
};

export type RepoSnapshot = {
  config: RepoConfig;
  docs: Map<string, DocSnapshot>; // keyed by relPath
};

export type LinkEdge = {
  sourceRepo: string;
  sourcePath: string;
  targetRepo: string; // same as source if in-repo edge
  targetPath: string; // resolved relPath in target repo
  targetAnchor: string | null;
  rawHref: string;
};

export type BrokenRefFinding = {
  kind: "missing_file" | "missing_anchor";
  source: { repo: string; path: string };
  target: { repo: string; path: string; anchor: string | null };
  rawHref: string;
};

export type StalenessFinding = {
  kind: "direct" | "transitive";
  repo: string;
  path: string;
  mtime: string;
  staleChain?: Array<{ repo: string; path: string; mtime: string }>;
};

export type AuditReport = {
  generatedAt: string;
  config: AuditConfig;
  totals: {
    reposScanned: number;
    docsScanned: number;
    brokenRefs: number;
    directlyStale: number;
    transitivelyStale: number;
  };
  brokenRefs: BrokenRefFinding[];
  staleness: StalenessFinding[];
};

// Tagged error union. runAudit branches on .kind to translate to exit codes
// (config → 2, runtime → 3). No throws at the API boundary, no classes
// (project rule from CLAUDE.md). Inner helpers may throw these tagged objects
// for control flow; the public entry points catch and convert to Result.
export type AuditError = { kind: "config"; message: string } | { kind: "runtime"; message: string };

export const configError = (message: string): AuditError => ({
  kind: "config",
  message,
});

export const runtimeError = (message: string): AuditError => ({
  kind: "runtime",
  message,
});
