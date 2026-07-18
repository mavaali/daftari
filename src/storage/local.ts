// Local filesystem storage backend.
//
// Phase 1 is read-only: list markdown files under a vault root and read their
// contents. A pluggable backend interface (storage/interface.ts) and the
// SQLite index (storage/index-db.ts) are deferred to later phases.

import { realpathSync } from "node:fs";
import { readFile as fsReadFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { glob } from "glob";
import { err, ok, type Result } from "../frontmatter/types.js";

// realpath of `p`, resolving symlinks, for symlink-confinement checks. When `p`
// does not exist (a write to a not-yet-created file), resolve the longest
// existing ancestor and re-attach the missing tail lexically — so a new file
// beneath a symlinked directory is still confined against where that directory
// really points.
//
// Fails CLOSED. Only ENOENT (the path or an ancestor doesn't exist yet) is
// expected and triggers the walk-up; any other error — EACCES, ELOOP, ENOTDIR —
// means we cannot prove where the path really resolves, so we return null and
// the caller rejects rather than trusting an unverified lexical path.
function realpathConfined(p: string): string | null {
  let current = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? resolve(real, ...tail) : real;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const parent = dirname(current);
      if (parent === current) return null; // reached the fs root; nothing resolved
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

// Memoized real (symlink-resolved) vault roots, keyed by the lexically resolved
// vaultRoot. The vault root does not change during a process, so realpath'ing it
// once and reusing the result is safe — and it removes N redundant realpath
// syscalls from the per-file loops in vaultIndex/vaultStatus (E4). ONLY the root
// is cached; every untrusted caller-supplied TARGET is still fully realpath'd on
// each call so the #142 symlink-escape protection is unchanged.
const realRootCache = new Map<string, string>();

// Resolves and memoizes the real (symlink-resolved) vault root for a lexically
// resolved root path. Returns null if the root cannot be resolved (same
// fail-closed contract as realpathConfined).
function resolveRealRoot(root: string): string | null {
  const cached = realRootCache.get(root);
  if (cached !== undefined) return cached;
  const realRoot = realpathConfined(root);
  if (realRoot === null) return null;
  realRootCache.set(root, realRoot);
  return realRoot;
}

// Clears the memoized real-root cache. Exported for tests that create and tear
// down temporary vault roots at the same absolute path within one process.
export function __clearRealRootCache(): void {
  realRootCache.clear();
}

// A resolved, vault-confined path.
//
// `absPath` is the lexical absolute target — what readFile/writeFile operate
// on (following any symlink, as before). `relPath` is the CANONICAL
// vault-relative form, `relative(realRoot, realTarget)`: every spelling of the
// same physical file (`a/b.md`, `./a/b.md`, `a//b.md`, `a/./b.md`, a symlink
// alias, or — on a case-insensitive fs — `A/B.md` for an existing `a/b.md`)
// collapses to one string. It is the ONLY safe key for the write lock, the
// optimistic-concurrency check, provenance, and the commit path: keying any of
// those on the raw caller string lets two spellings acquire distinct locks and
// silently clobber each other (#127/#128).
export interface ResolvedVaultPath {
  absPath: string;
  relPath: string;
}

// Resolves a vault-relative path, refusing anything that escapes the vault root
// (path traversal) or resolves to the root itself. Returns both the absolute
// target and the canonical vault-relative form (see ResolvedVaultPath).
export function resolveVaultPath(
  vaultRoot: string,
  relativePath: string,
): Result<ResolvedVaultPath, Error> {
  const root = resolve(vaultRoot);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return err(new Error(`path escapes vault root: ${relativePath}`));
  }
  // Lexical confinement above cannot see through symlinks: a link inside the
  // vault can point outside it, and readFile/writeFile would follow it. Resolve
  // real paths for both the root and the target and re-check confinement. The
  // root is realpath'd too because the vault may itself sit under a symlinked
  // prefix (e.g. macOS /var → /private/var).
  const realRoot = resolveRealRoot(root);
  const realTarget = realpathConfined(target);
  if (realRoot === null || realTarget === null) {
    return err(new Error(`path escapes vault root: ${relativePath}`));
  }
  const realRel = relative(realRoot, realTarget);
  if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) {
    return err(new Error(`path escapes vault root: ${relativePath}`));
  }
  return ok({ absPath: target, relPath: realRel });
}

// The realpath-canonical vault-relative form of a caller-supplied path
// (trimmed), i.e. resolveVaultPath's relPath — the ONLY safe key for
// looking up provenance, consumes, and read-log entries. Tools that anchor
// a query on a caller string use this one helper; recomputing the relative
// lexically diverges from the stored keys under a symlinked vault root
// (#127/#128).
export function canonicalVaultRelPath(
  vaultRoot: string,
  relativePath: string,
): Result<string, Error> {
  const resolved = resolveVaultPath(vaultRoot, relativePath.trim());
  if (!resolved.ok) return resolved;
  return ok(resolved.value.relPath);
}

export async function directoryExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function readFile(absolutePath: string): Promise<Result<string, Error>> {
  try {
    const content = await fsReadFile(absolutePath, "utf-8");
    return ok(content);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read file: ${reason}`));
  }
}

// Lists files under vaultRoot matching a glob pattern. Returns vault-relative
// POSIX-style paths, sorted. The .daftari control directory is always excluded.
export async function listFiles(
  vaultRoot: string,
  pattern = "**/*.md",
): Promise<Result<string[], Error>> {
  try {
    const matches = await glob(pattern, {
      cwd: resolve(vaultRoot),
      nodir: true,
      posix: true,
      // glob's default `dot: false` already skips dotfiles, but the Obsidian
      // adoption path (`daftari import obsidian`) depends on `.obsidian/` and
      // `.trash/` never entering a backfill plan, so the exclusion is made
      // explicit here rather than riding an implicit default across glob
      // versions. .daftari (control dir) and node_modules are excluded too.
      ignore: ["**/.daftari/**", "**/node_modules/**", "**/.obsidian/**", "**/.trash/**"],
    });
    return ok([...matches].sort());
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot list files: ${reason}`));
  }
}
