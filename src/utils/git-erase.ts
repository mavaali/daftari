// src/utils/git-erase.ts
//
// The git-history scrub behind vault_erase (R11-R13). Removes a path from every
// commit of the vault's history via `git filter-repo`, expires the reflog, and
// garbage-collects the now-unreachable objects — in the git_dir-aware location
// so a --separate-git-dir vault is handled correctly.
//
// R11 (the load-bearing invariant): `git filter-repo` is a REQUIRED dependency.
// If it is not installed we REFUSE the history op and report it in `incomplete`
// — we never silently do a worktree-only removal, which would leave the content
// in history while looking like a successful erase. The worktree is left
// untouched in that case so the caller is not misled into thinking anything
// was scrubbed.
//
// The `git` CLI is invoked via execFile with an argument array (no shell), the
// same no-injection discipline as src/utils/git.ts. The filter-repo, force-push
// and availability calls are injectable so tests can exercise the orchestration
// (and the refuse-path) without the tool installed or a real remote.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { err, ok, type Result } from "../frontmatter/types.js";

const run = promisify(execFile);

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

export interface EraseResult {
  /** Vault-relative paths targeted by the scrub. */
  paths: string[];
  /**
   * Reasons the scrub is NOT fully complete — each a `<domain>: <detail>`
   * string. Empty ⇒ history fully rewritten locally. A configured remote always
   * contributes an entry (remote-side gc cannot be self-served).
   */
  incomplete: string[];
}

// Injection seams. Defaults shell out to the real git; tests override them to
// run the orchestration without git-filter-repo installed or a live remote.
export interface GitEraseDeps {
  filterRepoAvailable?: () => Promise<boolean>;
  runFilterRepo?: (
    vaultRoot: string,
    gitDir: string,
    paths: string[],
  ) => Promise<Result<void, Error>>;
  runForcePush?: (vaultRoot: string, remote: string) => Promise<Result<void, Error>>;
}

// The absolute git directory, resolving --separate-git-dir. Used so reflog
// expire + gc act on the real object store, not a stale/implicit one.
export async function resolveGitDir(vaultRoot: string): Promise<Result<string, Error>> {
  const r = await git(vaultRoot, ["rev-parse", "--absolute-git-dir"]);
  if (!r.ok) return r;
  return ok(r.value.trim());
}

async function defaultFilterRepoAvailable(): Promise<boolean> {
  try {
    await run("git", ["filter-repo", "--version"], { maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function defaultRunFilterRepo(
  vaultRoot: string,
  _gitDir: string,
  paths: string[],
): Promise<Result<void, Error>> {
  // --invert-paths drops the named paths from every commit; --force is required
  // because the repo is not a fresh clone. filter-repo rewrites the working
  // tree too, so the file is gone from the checkout as well as from history.
  const args = ["filter-repo", "--force", "--invert-paths"];
  for (const p of paths) args.push("--path", p);
  const r = await git(vaultRoot, args);
  return r.ok ? ok(undefined) : err(r.error);
}

async function defaultRunForcePush(
  vaultRoot: string,
  remote: string,
): Promise<Result<void, Error>> {
  const r = await git(vaultRoot, ["push", "--force", "--all", remote]);
  return r.ok ? ok(undefined) : err(r.error);
}

// The first configured remote name, or null when the vault has none.
async function configuredRemote(vaultRoot: string): Promise<string | null> {
  const r = await git(vaultRoot, ["remote"]);
  if (!r.ok) return null;
  const first = r.value.trim().split("\n")[0]?.trim();
  return first ? first : null;
}

/**
 * Erase `paths` from the vault's git history.
 *
 * Order: refuse-if-no-filter-repo → filter-repo rewrite → reflog expire → gc →
 * (configured remote) force-push. Returns `incomplete[]` describing anything the
 * local scrub could not guarantee; a hard failure of the rewrite itself is an
 * `err`.
 */
export async function eraseFromHistory(
  vaultRoot: string,
  paths: string[],
  deps: GitEraseDeps = {},
): Promise<Result<EraseResult, Error>> {
  const incomplete: string[] = [];

  const available = await (deps.filterRepoAvailable ?? defaultFilterRepoAvailable)();
  if (!available) {
    // R11: never a silent worktree-only no-op. Refuse the history op, leave the
    // worktree untouched, and say so loudly.
    incomplete.push("git-history: filter-repo not installed");
    return ok({ paths, incomplete });
  }

  const gitDirRes = await resolveGitDir(vaultRoot);
  if (!gitDirRes.ok) return gitDirRes;
  const gitDir = gitDirRes.value;

  const rewrite = await (deps.runFilterRepo ?? defaultRunFilterRepo)(vaultRoot, gitDir, paths);
  if (!rewrite.ok) return rewrite;

  // Make the pre-rewrite objects unreachable in the resolved git_dir.
  await git(vaultRoot, ["reflog", "expire", "--expire=now", "--all"]);
  await git(vaultRoot, ["gc", "--prune=now", "--quiet"]);

  const remote = await configuredRemote(vaultRoot);
  if (remote) {
    const push = await (deps.runForcePush ?? defaultRunForcePush)(vaultRoot, remote);
    if (!push.ok) {
      incomplete.push(`git-remote: force-push to '${remote}' failed: ${push.error.message}`);
    }
    // Even a successful force-push does not scrub the remote: hosts like GitHub
    // and Azure DevOps keep unreachable objects until an operator-triggered gc.
    incomplete.push(
      `git-remote: '${remote}' has rewritten refs but remote-side gc is not self-serve — ` +
        "request a repository garbage-collect / purge from the host",
    );
  }

  return ok({ paths, incomplete });
}
