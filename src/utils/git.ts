// Git is Daftari's version-control layer: every write operation auto-commits,
// so the markdown files' history *is* the document history. There is no
// separate versioning system.
//
// This module shells out to the `git` CLI via execFile (argument array, no
// shell) rather than taking a dependency. The vault directory is the git work
// tree; `git -C <vaultRoot>` scopes every command to it.

import { execFile } from "node:child_process";
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

async function git(
  vaultRoot: string,
  args: string[],
): Promise<Result<string, Error>> {
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
  const result = await git(vaultRoot, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  return result.ok && result.value.trim() === "true";
}

// Initializes a git repo at the vault root if one does not already exist.
// Idempotent — safe to call on every write.
export async function ensureGitRepo(
  vaultRoot: string,
): Promise<Result<void, Error>> {
  if (await isGitRepo(vaultRoot)) return ok(undefined);
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
): Promise<Result<{ hash: string }, Error>> {
  const ready = await ensureGitRepo(vaultRoot);
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
