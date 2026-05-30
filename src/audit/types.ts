// src/audit/types.ts
// Shared types for the coherence audit. Pure data shapes; no logic.

export type AuditConfig = {
  repos: RepoConfig[];
  output: { markdown?: string; json?: string };
  staleness: { thresholdDays: number };
  failOn: { brokenRefs: number; transitiveStaleness: number };
};

export type RepoConfig = {
  name: string;
  path: string; // absolute, real path
  docsGlob: string; // glob relative to path; default "**/*.md"
  urls: string[]; // empty if none configured
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

// Sentinel errors. runAudit catches these and maps to exit codes 2 / 3.
export class AuditConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditConfigError";
  }
}

export class AuditRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditRuntimeError";
  }
}
