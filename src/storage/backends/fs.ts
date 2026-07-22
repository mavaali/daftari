// The fs storage backend (#6): a local or mounted directory as the sync
// target. The reference implementation of the backend contract — and the
// test double every sync test drives, so its semantics (null on missing get,
// idempotent delete, atomic put) define the contract for the cloud backends.

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { err, ok, type Result } from "../../frontmatter/types.js";
import type { StorageBackend } from "../backend.js";

// Backend keys are forward-slash relative paths; refuse anything that would
// escape the target root when mapped onto the filesystem.
function keyToPath(root: string, key: string): Result<string, Error> {
  const target = resolve(root, key);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return err(new Error(`storage key escapes backend root: ${key}`));
  }
  return ok(target);
}

export function createFsBackend(path: string): Result<StorageBackend, Error> {
  if (!path || path.trim().length === 0) {
    return err(new Error("storage backend 'fs' requires a non-empty 'path'"));
  }
  const root = resolve(path);

  return ok({
    id: `fs:${root}`,
    async get(key) {
      const p = keyToPath(root, key);
      if (!p.ok) return p;
      try {
        return ok(await readFile(p.value));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return ok(null);
        return err(new Error(`fs get ${key}: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
    async put(key, data) {
      const p = keyToPath(root, key);
      if (!p.ok) return p;
      try {
        await mkdir(dirname(p.value), { recursive: true });
        // Write-then-rename so a crashed sync never leaves a torn object —
        // the same atomicity a real object store gives per put.
        const tmp = `${p.value}.daftari-tmp`;
        await writeFile(tmp, data);
        await rename(tmp, p.value);
        return ok(undefined);
      } catch (e) {
        return err(new Error(`fs put ${key}: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
    async list(prefix) {
      try {
        const entries = await readdir(root, { recursive: true, withFileTypes: true });
        const keys: string[] = [];
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const abs = join(entry.parentPath, entry.name);
          const key = relative(root, abs).split(sep).join("/");
          if (key.startsWith(prefix)) keys.push(key);
        }
        return ok(keys);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
        return err(new Error(`fs list ${prefix}: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
    async delete(key) {
      const p = keyToPath(root, key);
      if (!p.ok) return p;
      try {
        await rm(p.value, { force: true });
        return ok(undefined);
      } catch (e) {
        return err(new Error(`fs delete ${key}: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  });
}
