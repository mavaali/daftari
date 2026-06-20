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

// Resolves a vault-relative path to an absolute path, refusing anything that
// escapes the vault root (path traversal) or resolves to the root itself.
export function resolveVaultPath(vaultRoot: string, relativePath: string): Result<string, Error> {
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
  const realRoot = realpathConfined(root);
  const realTarget = realpathConfined(target);
  if (realRoot === null || realTarget === null) {
    return err(new Error(`path escapes vault root: ${relativePath}`));
  }
  const realRel = relative(realRoot, realTarget);
  if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) {
    return err(new Error(`path escapes vault root: ${relativePath}`));
  }
  return ok(target);
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
