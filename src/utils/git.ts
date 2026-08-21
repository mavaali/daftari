// Git is Daftari's version-control layer: every write operation auto-commits,
// so the markdown files' history *is* the document history. There is no
// separate versioning system.
//
// This module shells out to the `git` CLI via execFile (argument array, no
// shell) rather than taking a dependency. The vault directory is the git work
// tree; `git -C <vaultRoot>` scopes every command to it.

import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { err, ok, type Result } from "../frontmatter/types.js";

const run = promisify(execFile);

// Options for the internal git() helper. Read/plumbing callers (log, blame-
// scale history walks on huge repos) pass none of this and keep today's
// behavior — no timeout, no env override — so this change introduces no new
// failure mode for them. Only the commit path (below) opts in.
interface GitCallOpts {
  // Bounds the subprocess with execFile's own `timeout`, which SIGTERMs the
  // child if it outlives it. Node sets `killed: true` on the rejected error
  // in that case (verified: no `code`, `signal: "SIGTERM"`), which is how we
  // distinguish a timeout from an ordinary nonzero-exit git failure below.
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

function isTimeoutError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "killed" in e &&
    (e as { killed?: unknown }).killed === true
  );
}

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

async function git(
  vaultRoot: string,
  args: string[],
  opts: GitCallOpts = {},
): Promise<Result<string, Error>> {
  try {
    const execOpts: { maxBuffer: number; timeout?: number; env?: NodeJS.ProcessEnv } = {
      maxBuffer: 16 * 1024 * 1024,
    };
    if (opts.timeoutMs !== undefined) execOpts.timeout = opts.timeoutMs;
    if (opts.env !== undefined) execOpts.env = opts.env;
    const { stdout } = await run("git", ["-C", vaultRoot, ...args], execOpts);
    return ok(stdout);
  } catch (e) {
    if (opts.timeoutMs !== undefined && isTimeoutError(e)) {
      return err(
        new Error(
          `git ${args[0]} timed out after ${opts.timeoutMs}ms — likely causes: a hook ` +
            `waiting on input or sleeping, a credential/passphrase prompt (e.g. gpg commit ` +
            `signing), or an external .git/index.lock held by another process`,
        ),
      );
    }
    const reason =
      e instanceof Error && "stderr" in e && typeof e.stderr === "string"
        ? e.stderr.trim() || e.message
        : e instanceof Error
          ? e.message
          : String(e);
    return err(new Error(`git ${args[0]} failed: ${reason}`));
  }
}

export async function isGitRepo(vaultRoot: string, opts: GitCallOpts = {}): Promise<boolean> {
  const result = await git(vaultRoot, ["rev-parse", "--is-inside-work-tree"], opts);
  return result.ok && result.value.trim() === "true";
}

// Blob plumbing for JIT anchor pins (citation-anchors spec, Decision 2). Both
// scope to an arbitrary repo via the shared `git -C <repo>` helper, so the
// `repoRoot` here is a code repo, not the vault. Read-only, no network.

// The current-working-tree blob id of `relPath` (`git hash-object`). Hashes the
// file as it is on disk — dirty/uncommitted content included — which is what
// the pin's `intact` check (step 2) compares against. Fails when the path is
// absent from the tree, which the classifier reads as `missing`.
export async function hashObjectFile(
  repoRoot: string,
  relPath: string,
): Promise<Result<string, Error>> {
  const result = await git(repoRoot, ["hash-object", "--", relPath]);
  if (!result.ok) return result;
  return ok(result.value.trim());
}

// The content of a blob by id (`git cat-file blob <sha>`), used to retrieve the
// pinned lines when the current blob differs (step 3). Returns the bytes
// verbatim (no trim — blob content is exact). Fails when the object is not in
// the odb (e.g. a pin over never-committed or gc'd content), which the
// classifier reads as `moved`.
export async function catFileBlob(repoRoot: string, sha: string): Promise<Result<string, Error>> {
  return git(repoRoot, ["cat-file", "blob", sha]);
}

// Returns true when `sha` is a reachable object in `repoRoot`'s odb
// (`git cat-file -e <sha>`). A failure means the object is absent — the blob
// was hashed from a working-tree file that was never committed (or was gc'd).
// Used by the JIT pin minter as an advisory committed-flag check (U1).
export async function blobExists(repoRoot: string, sha: string): Promise<boolean> {
  const result = await git(repoRoot, ["cat-file", "-e", sha]);
  return result.ok;
}

// Initializes a git repo for the vault if one does not already exist. When
// `gitDir` is given, the repo data lives there (git init --separate-git-dir),
// leaving only a static `.git` FILE in the vault — so a cloud-synced vault never
// holds churning git internals. Idempotent.
export async function ensureGitRepo(
  vaultRoot: string,
  gitDir?: string,
  opts: GitCallOpts = {},
): Promise<Result<void, Error>> {
  if (await isGitRepo(vaultRoot, opts)) return ok(undefined);

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
    const init = await git(vaultRoot, ["init", "--quiet", `--separate-git-dir=${gitDir}`], opts);
    if (!init.ok) return init;
    return ok(undefined);
  }

  const init = await git(vaultRoot, ["init", "--quiet"], opts);
  if (!init.ok) return init;
  return ok(undefined);
}

// In-process commit serialization. The per-file write lease does NOT cover
// git: two serve requests writing DIFFERENT files hold different leases, so
// their add/commit sequences interleaved freely — one pathless `git commit`
// swallowed the other's staged file under the wrong author, and the other
// then failed "nothing to commit" (or died racing .git/index.lock). Keyed by
// vaultRoot as given (one vault per process in practice; tests run many temp
// vaults per worker). The stored chain link always settles resolved, so a
// failed commit never wedges the queue; entries self-remove once idle.
const commitChains = new Map<string, Promise<unknown>>();

function withCommitLock<T>(vaultRoot: string, fn: () => Promise<T>): Promise<T> {
  // Chain key is the RESOLVED path — trailing slashes or relative spellings
  // of one vault must serialize on one chain (#127/#128 rule, applied to
  // the vault root itself).
  const key = resolve(vaultRoot);
  // `prev` is always a stored `link`, which settles resolved by construction
  // (the catch below) — so a failed commit never wedges the queue and a
  // plain .then is enough to run after it.
  const prev = commitChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const link = run.catch(() => undefined);
  commitChains.set(key, link);
  void link.then(() => {
    if (commitChains.get(key) === link) commitChains.delete(key);
  });
  return run;
}

// Vault paths are literal file names, never glob pathspecs: a doc named
// `q3-*.md` must not sweep `q3-forecast.md` into its add or commit, and a
// bracket-named doc must not silently match nothing.
function literalPathspecs(paths: string[]): string[] {
  return paths.map((p) => `:(literal)${p}`);
}

// A hung git subprocess on the commit path — a pre-commit hook that never
// returns, a gpg passphrase prompt, an external .git/index.lock held by a
// stuck process — wedges every commit queued behind it in withCommitLock's
// in-process chain, not just the request that triggered it. Bound it: longer
// than any sane commit, short enough that a wedged queue drains on its own.
const DEFAULT_COMMIT_TIMEOUT_MS = 60_000;

// A headless server has nobody to answer a credential/passphrase prompt, so
// let git fail fast instead of hanging on one. GIT_TERMINAL_PROMPT=0 refuses
// terminal prompts outright; GIT_ASKPASS points at a program that exits 0
// with no output, so an askpass invocation (e.g. for a credential helper)
// reads as an empty answer rather than opening a prompt.
function noPromptEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
  };
}

// Stages the given vault-relative paths and creates a commit authored by
// `identity`. The commit's committer is also set to `identity` (via `-c`
// overrides) so commits land even in a repo with no configured user. The
// commit is pathspec-scoped to `paths` — belt and suspenders under the
// serialization above, so it can never sweep up a file some other flow left
// staged. Returns the new commit's short hash.
export async function commit(
  vaultRoot: string,
  paths: string[],
  message: string,
  identity: string,
  opts: { gitDir?: string; timeoutMs?: number } = {},
): Promise<Result<{ hash: string }, Error>> {
  if (paths.length === 0) {
    return err(new Error("commit requires at least one path"));
  }

  const commitGitOpts: GitCallOpts = {
    timeoutMs: opts.timeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS,
    env: noPromptEnv(),
  };

  return withCommitLock(vaultRoot, async () => {
    const ready = await ensureGitRepo(vaultRoot, opts.gitDir, commitGitOpts);
    if (!ready.ok) return ready;

    const staged = await git(vaultRoot, ["add", "--", ...literalPathspecs(paths)], commitGitOpts);
    if (!staged.ok) return staged;

    const id = gitIdentity(identity);
    const committed = await git(
      vaultRoot,
      [
        "-c",
        `user.name=${id.name}`,
        "-c",
        `user.email=${id.email}`,
        "commit",
        `--author=${id.name} <${id.email}>`,
        "-m",
        message,
        "--",
        ...literalPathspecs(paths),
      ],
      commitGitOpts,
    );
    if (!committed.ok) return committed;

    const hash = await git(vaultRoot, ["rev-parse", "--short", "HEAD"], commitGitOpts);
    if (!hash.ok) return hash;
    return ok({ hash: hash.value.trim() });
  });
}

// --- attestation plumbing (#298) -------------------------------------------

// `git status --porcelain` lines, for the attest clean-tree gate. Read-only.
export async function statusPorcelain(vaultRoot: string): Promise<Result<string[], Error>> {
  const out = await git(vaultRoot, ["status", "--porcelain"]);
  if (!out.ok) return out;
  return ok(
    out.value
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0),
  );
}

// The FULL head sha (commit() returns the short form; an attestation anchors
// the unabbreviated one).
export async function headFullSha(vaultRoot: string): Promise<Result<string, Error>> {
  const out = await git(vaultRoot, ["rev-parse", "HEAD"]);
  if (!out.ok) return out;
  return ok(out.value.trim());
}

// Returns the newest commit whose resulting tree actually contained relPath.
// A plain path log reports the later deletion commit, which cannot recover the
// file through `daftari asof`. Walk path-touching commits newest-first and
// return the first tree that still has the blob. This also handles renames: a
// rename commit may touch both names, but only the new path exists in its tree.
// `--all` includes any locally available ref; no matching tree is a successful
// null, distinct from Git being unusable.
export async function lastCommitContainingPath(
  vaultRoot: string,
  relPath: string,
): Promise<Result<string | null, Error>> {
  const out = await git(vaultRoot, ["log", "--all", "--format=%H", "--", relPath]);
  if (!out.ok) return out;
  const commits = out.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const hash of commits) {
    const present = await git(vaultRoot, ["cat-file", "-e", `${hash}:${relPath}`]);
    if (present.ok) return ok(hash);
  }
  return ok(null);
}

export interface PathHistory {
  firstCommitDate: string;
  lastCommit: string;
  lastAuthor: string;
  lastDate: string;
  commitCount: number;
}

// Per-path history from ONE full-history walk (fileGitMeta is two
// subprocesses per file — unacceptable at attestation scale). Oldest-first,
// so the first sighting of a path sets firstCommitDate and each later
// sighting overwrites the last-commit fields.
export async function historyByPath(
  vaultRoot: string,
): Promise<Result<Map<string, PathHistory>, Error>> {
  const out = await git(vaultRoot, [
    "log",
    "--reverse",
    "--name-only",
    "--pretty=format:%x1e%H%x1f%aN%x1f%cs",
  ]);
  if (!out.ok) return out;
  const byPath = new Map<string, PathHistory>();
  let commit: { hash: string; author: string; date: string } | null = null;
  for (const raw of out.value.split("\n")) {
    const line = raw.trimEnd();
    // \x1e (record separator) opens each commit header. A tracked FILE
    // whose name starts with a control byte is shown quoted by git
    // (core.quotePath), so a raw \x1e line can only be our header.
    if (line.startsWith("\u001e")) {
      const [hash, author, date] = line.slice(1).split("\u001f");
      commit = { hash: hash ?? "", author: author ?? "", date: date ?? "" };
      continue;
    }
    if (line.length === 0 || commit === null) continue;
    const existing = byPath.get(line);
    if (existing) {
      existing.lastCommit = commit.hash;
      existing.lastAuthor = commit.author;
      existing.lastDate = commit.date;
      existing.commitCount += 1;
    } else {
      byPath.set(line, {
        firstCommitDate: commit.date,
        lastCommit: commit.hash,
        lastAuthor: commit.author,
        lastDate: commit.date,
        commitCount: 1,
      });
    }
  }
  return ok(byPath);
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
  const since = sinceCommit.trim();
  if (since.startsWith("-")) {
    return err(new Error("changedSince: commit ref must not start with '-'"));
  }
  const result = await git(vaultRoot, ["diff", "--name-only", `${since}..HEAD`]);
  if (!result.ok) return result;
  const paths = result.value
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.endsWith(".md"));
  return ok(paths);
}
