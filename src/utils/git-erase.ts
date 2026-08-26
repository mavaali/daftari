// src/utils/git-erase.ts
//
// The git-history scrub behind vault_erase (R11-R13). Removes a path from every
// commit of the vault's history via `git filter-repo`, expires the reflog, and
// garbage-collects the now-unreachable objects — in the git_dir-aware location
// so a --separate-git-dir vault is handled correctly.
//
// R11 (the load-bearing invariant): `git filter-repo` is a REQUIRED dependency.
// If it is not installed we REFUSE the history op and report `refused: true`
// with a reason in `incomplete` — we never silently do a worktree-only removal,
// which would leave the content in history while looking like a successful
// erase. The worktree is left untouched in that case.
//
// R12 (incomplete erasure is always loud): every remote is captured BEFORE the
// rewrite (filter-repo drops configured remotes when it finishes, so resolving
// them afterward would silently find none), force-pushed by URL, and named in
// `incomplete[]` regardless — remote-side gc is never self-serve. reflog/gc
// failures also land in `incomplete[]` rather than being swallowed.
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
  /** Vault-relative paths (and their historical names) targeted by the scrub. */
  paths: string[];
  /**
   * Reasons the scrub is NOT fully complete — each a `<domain>: <detail>`
   * string. Empty ⇒ history fully rewritten locally with no remote. A configured
   * remote always contributes an entry (remote-side gc cannot be self-served).
   */
  incomplete: string[];
  /**
   * True when the history op was REFUSED (filter-repo absent) — nothing was
   * erased and the worktree is untouched. Distinct from a partial completion:
   * a refused erase is NOT a success, however the caller reads `incomplete`.
   */
  refused: boolean;
}

// Injection seams. Defaults shell out to the real git; tests override them to
// run the orchestration without git-filter-repo installed or a live remote.
export interface GitEraseDeps {
  filterRepoAvailable?: () => Promise<boolean>;
  /** Last reversible gate, run after history/remotes preflight and before filter-repo. */
  validateBeforeRewrite?: () => Promise<Result<void, Error>>;
  runFilterRepo?: (
    vaultRoot: string,
    gitDir: string,
    paths: string[],
  ) => Promise<Result<void, Error>>;
  // `target` is a remote URL (not a name): filter-repo removes the named remotes
  // during the rewrite, so the push must address the captured URL directly.
  runForcePush?: (vaultRoot: string, target: string) => Promise<Result<void, Error>>;
}

interface Remote {
  name: string;
  url: string;
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
  // tree too, so the files are gone from the checkout as well as from history.
  const args = ["filter-repo", "--force", "--invert-paths"];
  for (const p of paths) args.push("--path", p);
  const r = await git(vaultRoot, args);
  return r.ok ? ok(undefined) : err(r.error);
}

async function defaultRunForcePush(
  vaultRoot: string,
  target: string,
): Promise<Result<void, Error>> {
  // Branches AND tags: a pushed tag still pointing at a pre-rewrite commit keeps
  // the old history reachable on the remote even after a branch force-push.
  const all = await git(vaultRoot, ["push", "--force", "--all", target]);
  if (!all.ok) return err(all.error);
  const tags = await git(vaultRoot, ["push", "--force", "--tags", target]);
  return tags.ok ? ok(undefined) : err(tags.error);
}

// Every configured remote as {name, url}. Captured BEFORE the rewrite because
// filter-repo removes configured remotes on completion.
async function configuredRemotes(vaultRoot: string): Promise<Remote[]> {
  const r = await git(vaultRoot, ["remote"]);
  if (!r.ok) return [];
  const names = r.value
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const remotes: Remote[] = [];
  for (const name of names) {
    const u = await git(vaultRoot, ["remote", "get-url", name]);
    remotes.push({ name, url: u.ok ? u.value.trim() : name });
  }
  return remotes;
}

// Every name a path has carried across history (rename-following). Empty ⇒ the
// path was never in history — a typo or an already-absent target, which the
// caller must treat as a hard error (erasing a never-present path would report
// success over an untouched leak).
async function historicalNames(vaultRoot: string, path: string): Promise<Result<string[], Error>> {
  const r = await git(vaultRoot, ["log", "--follow", "--name-only", "--format=", "--", path]);
  if (!r.ok) return r;
  const names = new Set(
    r.value
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  return ok([...names]);
}

/**
 * Erase `paths` (and every historical name each carried) from the vault's git
 * history.
 *
 * Order: refuse-if-no-filter-repo → resolve git_dir → history-presence precheck
 * (+ rename following) → capture remotes → filter-repo rewrite → reflog expire →
 * gc → force-push every captured remote. A path absent from history is an `err`;
 * a hard failure of the rewrite itself is an `err`; everything else the local
 * scrub could not guarantee is reported in `incomplete[]`.
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
    return ok({ paths, incomplete, refused: true });
  }

  const gitDirRes = await resolveGitDir(vaultRoot);
  if (!gitDirRes.ok) return gitDirRes;
  const gitDir = gitDirRes.value;

  // History-presence precheck + rename following. Every input path must be
  // present somewhere in history; the union of all historical names is what we
  // hand to filter-repo so a file renamed across history is erased under every
  // name it ever had.
  const allNames = new Set<string>();
  for (const p of paths) {
    const names = await historicalNames(vaultRoot, p);
    if (!names.ok) return names;
    if (names.value.length === 0) {
      return err(
        new Error(
          `vault_erase: '${p}' is not present in git history — nothing to erase ` +
            "(check the path for a typo; a never-committed file has no history to scrub)",
        ),
      );
    }
    for (const n of names.value) allNames.add(n);
  }

  // Capture remotes BEFORE the rewrite (filter-repo drops them on completion).
  const remotes = await configuredRemotes(vaultRoot);

  const validated = await (deps.validateBeforeRewrite?.() ?? Promise.resolve(ok(undefined)));
  if (!validated.ok) return validated;

  const rewrite = await (deps.runFilterRepo ?? defaultRunFilterRepo)(vaultRoot, gitDir, [
    ...allNames,
  ]);
  if (!rewrite.ok) return rewrite;

  // Make the pre-rewrite objects unreachable in the resolved git_dir. Surface,
  // never swallow, a failure here — a failed gc leaves the objects reachable.
  const reflog = await git(vaultRoot, ["reflog", "expire", "--expire=now", "--all"]);
  if (!reflog.ok) incomplete.push(`git-local: reflog expire failed: ${reflog.error.message}`);
  const gc = await git(vaultRoot, ["gc", "--prune=now", "--quiet"]);
  if (!gc.ok) incomplete.push(`git-local: gc failed: ${gc.error.message}`);

  // Force-push every captured remote by URL (branches + tags). A successful push
  // still does not scrub the remote: hosts keep unreachable objects until an
  // operator-triggered gc, so every remote is named in incomplete[] regardless.
  for (const remote of remotes) {
    const push = await (deps.runForcePush ?? defaultRunForcePush)(vaultRoot, remote.url);
    if (!push.ok) {
      incomplete.push(
        `git-remote: force-push to '${remote.name}' (${remote.url}) failed: ${push.error.message}`,
      );
    }
    incomplete.push(
      `git-remote: '${remote.name}' has rewritten refs but remote-side gc is not self-serve — ` +
        "request a repository garbage-collect / purge from the host",
    );
  }

  return ok({ paths: [...allNames], incomplete, refused: false });
}
