// Shared recursive file walk for the storage layer. Explicit per-directory
// readdir rather than readdir({recursive}) + Dirent.parentPath — parentPath
// only exists from Node 20.12, and engines declares >=20. Symlinks are
// reported, not followed. Lives in its own leaf module so backends and the
// sync engine can both use it without a backend depending on its consumer.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function walkFiles(dir: string): Promise<{ files: string[]; symlinks: number }> {
  const files: string[] = [];
  let symlinks = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      symlinks++;
    } else if (entry.isDirectory()) {
      const sub = await walkFiles(abs);
      files.push(...sub.files);
      symlinks += sub.symlinks;
    } else if (entry.isFile()) {
      files.push(abs);
    }
  }
  return { files, symlinks };
}
