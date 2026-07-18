// src/audit/collect.ts
// The only IO stage of the audit pipeline. Per repo: glob docs, strip
// frontmatter, extract headings (GitHub-slugged) and links, then batch
// git log to populate mtimes; on any git failure, fall back to fs mtime.

import { type ExecFileSyncOptions, execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative as nodeRelative, resolve as nodeResolve } from "node:path";
import { glob } from "glob";
import matter from "gray-matter";
import { err, ok, type Result } from "../frontmatter/types.js";
import { extractLinksFromBody } from "./links.js";
import type { AuditConfig, AuditError, DocSnapshot, RepoConfig, RepoSnapshot } from "./types.js";
import { runtimeError } from "./types.js";

// The disk oracle for checkBrokenRefs (#132/#133): true iff targetAbs
// exists AND its REAL location sits under rootAbs. realpathSync resolves
// every component, so a symlink committed inside an audited repo
// (escape -> /) cannot route the probe outside the containment root — a
// lexical check plus a bare existsSync would (security review on #255).
// rootAbs is expected to be already-real: repo roots are realpathSync'd at
// config load, and the parent prefix of a real path is itself real.
// A nonexistent target makes realpathSync throw ENOENT → false, which is
// exactly the "missing" answer.
export function symlinkSafeExistsWithin(rootAbs: string, targetAbs: string): boolean {
  let real: string;
  try {
    real = realpathSync(targetAbs);
  } catch {
    return false;
  }
  const rel = nodeRelative(rootAbs, real);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function slugify(heading: string): string {
  // GitHub slug: lowercase, strip non-alphanumeric (keep `-_`), whitespace -> `-`.
  return heading
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractHeadings(body: string): Set<string> {
  const out = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) out.add(slugify(m[1] as string));
  }
  return out;
}

function gitMtimes(repoPath: string, docsGlob: string): Map<string, string> | null {
  const opts: ExecFileSyncOptions = {
    cwd: repoPath,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  };
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], opts);
  } catch {
    return null;
  }
  let out: string;
  try {
    // Use the :(glob) pathspec magic so git's internal glob matcher handles
    // "**/*.md" correctly on all platforms and git configurations, including
    // matching top-level files (bare "**/*.md" without the magic prefix skips
    // files at depth 0 on some git versions).
    const pathspec = docsGlob.startsWith(":(") ? docsGlob : `:(glob)${docsGlob}`;
    out = execFileSync(
      "git",
      ["log", "--all", "--name-only", `--pretty=format:COMMIT %aI`, "--", pathspec],
      opts,
    ).toString();
  } catch {
    return null;
  }
  const mtimes = new Map<string, string>();
  let currentIso: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("COMMIT ")) {
      currentIso = line.slice("COMMIT ".length).trim() || null;
      continue;
    }
    const path = line.trim();
    if (!path || !currentIso) continue;
    // First time we see a path is its newest commit (git log is newest-first).
    if (!mtimes.has(path)) mtimes.set(path, currentIso);
  }
  return mtimes;
}

async function loadDoc(
  repoPath: string,
  relPath: string,
  mtimeFromGit: string | undefined,
): Promise<DocSnapshot> {
  const absPath = nodeResolve(repoPath, relPath);
  const text = await readFile(absPath, "utf-8");
  const parsed = matter(text);
  const body = parsed.content;

  // `describes` frontmatter (doc-to-code bindings). The audit reads it as raw
  // YAML — a string array, dropping any non-string entries — without invoking
  // the full Daftari schema, so it still works on arbitrary markdown repos.
  const rawDescribes = (parsed.data as { describes?: unknown }).describes;
  const describes = Array.isArray(rawDescribes)
    ? rawDescribes.filter((d): d is string => typeof d === "string")
    : [];

  let mtime: string;
  let mtimeSource: "git" | "fs";
  if (mtimeFromGit) {
    mtime = mtimeFromGit;
    mtimeSource = "git";
  } else {
    mtime = statSync(absPath).mtime.toISOString();
    mtimeSource = "fs";
  }

  return {
    relPath: relPath.split(/[\\/]/).join("/"),
    absPath,
    mtime,
    mtimeSource,
    headings: extractHeadings(body),
    links: extractLinksFromBody(body),
    describes,
  };
}

// Code-repo stubs carry no real mtime: a `code` repo never participates in
// staleness (it has no managed-document lifecycle), so its files' modification
// times are never read. This sentinel makes that explicit and avoids a
// per-file statSync — important because a code repo may be a large monorepo
// (thousands of files) and synchronous stat-in-a-loop would block the event
// loop. checkStaleness skips code repos outright; the sentinel never surfaces.
const STUB_MTIME = new Date(0).toISOString();

// A `code` repo is a raw reference target: every file is indexed by path as a
// stub (no content read, no frontmatter / heading / link extraction, no IO at
// all beyond the glob). Only the path is needed — `describes` bindings resolve
// against it and the broken-ref check verifies existence.
//
// Caveat: the glob is matched verbatim. A code repo configured with the default
// "**/*" over a tree containing node_modules / build output will index those
// too; narrow it with `docs_glob` in config for large repos.
async function collectCodeRepo(config: RepoConfig): Promise<RepoSnapshot> {
  const files = await glob(config.docsGlob, {
    cwd: config.path,
    nodir: true,
    posix: true,
    dot: false,
  });
  const docs = new Map<string, DocSnapshot>();
  for (const rel of files) {
    const posixRel = rel.split(/[\\/]/).join("/");
    docs.set(posixRel, {
      relPath: posixRel,
      absPath: nodeResolve(config.path, posixRel),
      mtime: STUB_MTIME,
      mtimeSource: "fs",
      headings: new Set(),
      links: [],
      describes: [],
    });
  }
  return { config, docs };
}

async function collectOne(config: RepoConfig): Promise<RepoSnapshot> {
  if (config.type === "code") return collectCodeRepo(config);
  const files = await glob(config.docsGlob, {
    cwd: config.path,
    nodir: true,
    posix: true,
    dot: false,
  });
  const onlyMd = files.filter((f) => /\.(md|markdown)$/i.test(f));
  const mtimes = gitMtimes(config.path, config.docsGlob);
  const docs = new Map<string, DocSnapshot>();
  for (const rel of onlyMd) {
    const posixRel = rel.split(/[\\/]/).join("/");
    try {
      const snap = await loadDoc(config.path, posixRel, mtimes?.get(posixRel));
      docs.set(posixRel, snap);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`daftari audit: warning: unreadable doc ${posixRel}: ${msg}\n`);
    }
  }
  return { config, docs };
}

export async function collectRepos(
  config: AuditConfig,
): Promise<Result<RepoSnapshot[], AuditError>> {
  // Sequential per-repo; concurrency would help but is out of scope until the
  // 30s budget gets squeezed (see plan §perf).
  const out: RepoSnapshot[] = [];
  for (const r of config.repos) {
    try {
      out.push(await collectOne(r));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(runtimeError(`collect failed for repo ${r.name}: ${reason}`));
    }
  }
  return ok(out);
}
