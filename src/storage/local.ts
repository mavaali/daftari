// Local filesystem storage backend.
//
// Phase 1 is read-only: list markdown files under a vault root and read their
// contents. A pluggable backend interface (storage/interface.ts) and the
// SQLite index (storage/index-db.ts) are deferred to later phases.

import { readFile as fsReadFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { glob } from "glob";
import { err, ok, type Result } from "../frontmatter/types.js";

// Resolves a vault-relative path to an absolute path, refusing anything that
// escapes the vault root (path traversal) or resolves to the root itself.
export function resolveVaultPath(vaultRoot: string, relativePath: string): Result<string, Error> {
  const root = resolve(vaultRoot);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
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
      ignore: ["**/.daftari/**", "**/node_modules/**"],
    });
    return ok([...matches].sort());
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot list files: ${reason}`));
  }
}
