// Git is Daftari's version-control layer: every write operation auto-commits,
// so the markdown files' history *is* the document history. There is no
// separate versioning system.
//
// This module shells out to the `git` CLI via execFile (argument array, no
// shell) rather than taking a dependency. The vault directory is the git work
// tree; `git -C <vaultRoot>` scopes every command to it.

import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { err, ok, type Result } from "../frontmatter/types.js";

const run = promisify(execFile);

export interface GitCommitInfo {
  hash: string;
  author: string;
  email: string;
  date: string; // ISO 8601
  subject: string;
}

// An agent identity ("agent:claude-code", "human:mihir") is not a valid git
// author string on its own. Git wants `Name <email>`; we keep the identity
// verbatim as the name and synthesize a stable, non-routable email from it.
export interface GitIdentity {
  name: string;
  email: string;
}

export function gitIdentity(identity: string): GitIdentity {
  const slug = identity.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return {
    name: identity,
    email: `${slug || "unknown"}@daftari.local`,
  };
}

async function git(vaultRoot: string, args: string[]): Promise<Result<string, Error>> {
  try {
    const { stdout } = await run("git", ["-C", vaultRoot, ...args], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return ok(stdout);
  } catch (e) {
    const reason =
      e instanceof Error && "stderr" in e && typeof e.stderr === "string"
        ? e.stderr.trim() || e.message
        : e instanceof Error
          ? e.message
          : String(e);
    return err(new Error(`git ${args[0]} failed: ${reason}`));
  }
}

export async function isGitRepo(vaultRoot: string): Promise<boolean> {
  const result = await git(vaultRoot, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.value.trim() === "true";
}

// Initializes a git repo for the vault if one does not already exist. When
// `gitDir` is given, the repo data lives there (git init --separate-git-dir),
// leaving only a static `.git` FILE in the vault — so a cloud-synced vault never
// holds churning git internals. Idempotent.
export async function ensureGitRepo(
  vaultRoot: string,
  gitDir?: string,
): Promise<Result<void, Error>> {
  if (await isGitRepo(vaultRoot)) return ok(undefined);

  if (gitDir) {
    // A leftover `.git` FILE (e.g. synced from another device, pointing at a
    // path that doesn't exist here) makes `git init` refuse. isGitRepo already
    // returned false, so it isn't a live repo — drop the stale pointer first.
    try {
      const s = await stat(join(vaultRoot, ".git"));
      if (s.isFile()) await rm(join(vaultRoot, ".git"));
    } catch {
      // no .git present — fine
    }
    await mkdir(dirname(gitDir), { recursive: true });
    const init = await git(vaultRoot, ["init", "--quiet", `--separate-git-dir=${gitDir}`]);
    if (!init.ok) return init;
    return ok(undefined);
  }

  const init = await git(vaultRoot, ["init", "--quiet"]);
  if (!init.ok) return init;
  return ok(undefined);
}

// Stages the given vault-relative paths and creates a commit authored by
// `identity`. The commit's committer is also set to `identity` (via `-c`
// overrides) so commits land even in a repo with no configured user. Returns
// the new commit's short hash.
export async function commit(
  vaultRoot: string,
  paths: string[],
  message: string,
  identity: string,
  opts: { gitDir?: string } = {},
): Promise<Result<{ hash: string }, Error>> {
  const ready = await ensureGitRepo(vaultRoot, opts.gitDir);
  if (!ready.ok) return ready;

  if (paths.length === 0) {
    return err(new Error("commit requires at least one path"));
  }

  const staged = await git(vaultRoot, ["add", "--", ...paths]);
  if (!staged.ok) return staged;

  const id = gitIdentity(identity);
  const committed = await git(vaultRoot, [
    "-c",
    `user.name=${id.name}`,
    "-c",
    `user.email=${id.email}`,
    "commit",
    `--author=${id.name} <${id.email}>`,
    "-m",
    message,
  ]);
  if (!committed.ok) return committed;

  const hash = await git(vaultRoot, ["rev-parse", "--short", "HEAD"]);
  if (!hash.ok) return hash;
  return ok({ hash: hash.value.trim() });
}

// Per-file git provenance, used by `daftari backfill` (§11.1) to derive
// frontmatter dates and authorship from history. Each field is null when git
// has nothing to say about the file — no repo, an empty/shallow history, or a
// path that has never been committed — so the caller can fall back to fs mtime.
//
//   created   ← first commit that ADDED the file (--diff-filter=A, oldest)
//   updated   ← most recent commit touching the file
//   author    ← author (%aN) of that most recent commit
//
// Dates are committer dates in YYYY-MM-DD (%cs), matching the frontmatter date
// format. Two git invocations: one for the add-date, one for the last commit's
// date+author together.
export interface FileGitMeta {
  created: string | null;
  updated: string | null;
  author: string | null;
}

export async function fileGitMeta(vaultRoot: string, relPath: string): Promise<FileGitMeta> {
  if (!(await isGitRepo(vaultRoot))) {
    return { created: null, updated: null, author: null };
  }

  // First add-commit's date. --reverse lists oldest-first; the first line is
  // the original creation. A renamed file's pre-rename history is not followed
  // (no --follow): the date reflects when the file appeared at this path.
  let created: string | null = null;
  const addLog = await git(vaultRoot, [
    "log",
    "--diff-filter=A",
    "--format=%cs",
    "--reverse",
    "--",
    relPath,
  ]);
  if (addLog.ok) {
    const first = addLog.value.split("\n").find((l) => l.trim().length > 0);
    created = first ? first.trim() : null;
  }

  // Last commit's date and author in one record (\x1f-separated).
  let updated: string | null = null;
  let author: string | null = null;
  const lastLog = await git(vaultRoot, ["log", "-1", "--format=%cs%x1f%aN", "--", relPath]);
  if (lastLog.ok) {
    const line = lastLog.value.trim();
    if (line.length > 0) {
      const [date, name] = line.split("\x1f");
      updated = date && date.trim().length > 0 ? date.trim() : null;
      author = name && name.trim().length > 0 ? name.trim() : null;
    }
  }

  return { created, updated, author };
}

// Returns the most recent commits, newest first. `path`, when given, scopes
// the log to a single file's history.
export async function log(
  vaultRoot: string,
  opts: { limit?: number; path?: string } = {},
): Promise<Result<GitCommitInfo[], Error>> {
  if (!(await isGitRepo(vaultRoot))) {
    return err(new Error("not a git repository"));
  }
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 20;
  // \x1f (unit separator) splits fields; \x1e (record separator) splits commits.
  const format = "%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e";
  const args = ["log", `--pretty=format:${format}`, `-n`, String(limit)];
  if (opts.path) args.push("--", opts.path);

  const result = await git(vaultRoot, args);
  if (!result.ok) return result;

  const commits: GitCommitInfo[] = [];
  for (const record of result.value.split("\x1e")) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [hash, author, email, date, subject] = trimmed.split("\x1f");
    if (!hash) continue;
    commits.push({
      hash,
      author: author ?? "",
      email: email ?? "",
      date: date ?? "",
      subject: subject ?? "",
    });
  }
  return ok(commits);
}

// --- citation-anchor plumbing (2026-07-26 spec, Decisions 1-2, C1) --------
//
// The read-path latency budget (kill condition: <=50ms p95 even at the pin
// cap) rules out one `execFile` per pin. Batching `hash-object` into ONE
// invocation per repo — regardless of how many pins reference it — is what
// keeps the all-intact (common) case to one subprocess per referenced repo
// per read/lint-run/audit, instead of one per pin. blobAtHead/blobSize/
// catBlob stay per-call: they only run on the drift (cold) path, where the
// spec knowingly exceeds its own "two invocations per pin" budget by one
// `cat-file -s` size gate ahead of the (bounded) blob read.

// Batches `git hash-object` for many working-tree files in ONE invocation,
// mapped back to `relPaths` by position. Callers `fs.stat` (or otherwise
// confirm existence of) every path first — hash-object fails the WHOLE batch
// on a single missing file, so a missing candidate must never reach here.
export async function hashObjects(
  repoRoot: string,
  relPaths: string[],
): Promise<Result<string[], Error>> {
  if (relPaths.length === 0) return ok([]);
  const result = await git(repoRoot, ["hash-object", "--", ...relPaths]);
  if (!result.ok) return result;
  const lines = result.value.split("\n").filter((l) => l.length > 0);
  if (lines.length !== relPaths.length) {
    return err(
      new Error(`git hash-object: expected ${relPaths.length} blob id(s), got ${lines.length}`),
    );
  }
  return ok(lines);
}

// Single-path wrapper over the batch primitive above.
export async function hashObject(
  repoRoot: string,
  relPath: string,
): Promise<Result<string, Error>> {
  const batch = await hashObjects(repoRoot, [relPath]);
  if (!batch.ok) return batch;
  return ok(batch.value[0] as string);
}

// The blob id `relPath` had at HEAD — the committed blob `daftari audit
// --pin` always pins (never the working tree), because a committed blob
// stays retrievable from the object database.
export async function blobAtHead(
  repoRoot: string,
  relPath: string,
): Promise<Result<string, Error>> {
  const result = await git(repoRoot, ["rev-parse", `HEAD:${relPath}`]);
  if (!result.ok) return result;
  return ok(result.value.trim());
}

// Size (bytes) of a blob, checked BEFORE catBlob so a huge pinned blob is
// never pulled into memory — the same stat-before-read guard readtext.ts
// uses for working-tree files.
export async function blobSize(repoRoot: string, sha: string): Promise<Result<number, Error>> {
  const result = await git(repoRoot, ["cat-file", "-s", sha]);
  if (!result.ok) return result;
  const n = Number.parseInt(result.value.trim(), 10);
  if (!Number.isFinite(n)) return err(new Error(`git cat-file -s ${sha}: unparseable size`));
  return ok(n);
}

// Retrieves a blob's raw content. Callers gate on blobSize first (the size
// cap is a caller concern, not enforced here); git()'s 16 MiB maxBuffer is
// the backstop.
export async function catBlob(repoRoot: string, sha: string): Promise<Result<string, Error>> {
  return git(repoRoot, ["cat-file", "blob", sha]);
}

// Vault-relative .md paths changed between `sinceCommit` and HEAD. Used by the
// consolidate event clock (spec §3.1). A bad/unknown commit is an error, not [] —
// the caller treats that as the nil baseline path (skip the event clock), so the
// distinction must not be swallowed.
export async function changedSince(
  vaultRoot: string,
  sinceCommit: string,
): Promise<Result<string[], Error>> {
  if (!(await isGitRepo(vaultRoot))) return err(new Error("not a git repository"));
  if (typeof sinceCommit !== "string" || sinceCommit.trim().length === 0) {
    return err(new Error("changedSince requires a non-empty commit ref"));
  }
  const result = await git(vaultRoot, ["diff", "--name-only", `${sinceCommit}..HEAD`]);
  if (!result.ok) return result;
  const paths = result.value
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.endsWith(".md"));
  return ok(paths);
}
