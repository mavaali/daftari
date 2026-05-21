// Process-level lockfile for a vault. Prevents two daftari processes from
// running against the same vault concurrently and corrupting the shared
// index.db. See docs/superpowers/plans/2026-05-20-process-lockfile.md (#52).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";

export type LockData = {
  daftari: true;
  pid: number;
  vaultRoot: string;
  startedAt: string;
  version: string;
};

function lockPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "process.lock");
}

export function readLockfile(vaultRoot: string): Result<LockData | null, Error> {
  try {
    const raw = readFileSync(lockPath(vaultRoot), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as LockData).daftari === true &&
      typeof (parsed as LockData).pid === "number"
    ) {
      return ok(parsed as LockData);
    }
    return ok(null);
  } catch (e) {
    const errno = e as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return ok(null);
    if (e instanceof SyntaxError) return ok(null);
    return err(errno);
  }
}

export function writeLockfile(vaultRoot: string, data: LockData): Result<void, Error> {
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    writeFileSync(lockPath(vaultRoot), JSON.stringify(data, null, 2), "utf-8");
    return ok(undefined);
  } catch (e) {
    return err(e as Error);
  }
}
