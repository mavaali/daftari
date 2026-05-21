// Process-level lockfile for a vault. Prevents two daftari processes from
// running against the same vault concurrently and corrupting the shared
// index.db. See docs/superpowers/plans/2026-05-20-process-lockfile.md (#52).

import { execFileSync } from "node:child_process";
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

// `kill(pid, 0)` is the POSIX way to test process liveness without delivering
// a signal. ESRCH = no such process; EPERM = exists but not ours (still alive
// for our purposes — someone else owns it but it exists).
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const errno = e as NodeJS.ErrnoException;
    return errno.code === "EPERM";
  }
}

// Best-effort check that PID belongs to a daftari/node process running this
// vault. Protects against PID recycling — if the original daftari died and the
// OS reassigned its PID to e.g. vim, we must NOT SIGTERM the unrelated process.
//
// Uses `ps -p PID -o command=` which is POSIX-portable. If ps fails or the
// command line doesn't look like daftari, returns false (treat as stale).
export function isDaftariProcess(pid: number, vaultRoot: string): boolean {
  if (!isProcessAlive(pid)) return false;
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out.length === 0) return false;
    if (out.includes(vaultRoot)) return true;
    return /node|tsx/.test(out) && /daftari/.test(out);
  } catch {
    return false;
  }
}
