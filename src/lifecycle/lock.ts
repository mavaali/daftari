// Process-level lockfile for a vault. Prevents two daftari processes from
// running against the same vault concurrently and corrupting the shared
// index.db. See docs/superpowers/plans/2026-05-20-process-lockfile.md (#52).

import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

// Best-effort check that PID belongs to a daftari process running THIS vault.
// Protects against PID recycling — if the original daftari died and the OS
// reassigned its PID to e.g. vim, we must NOT SIGTERM the unrelated process.
//
// Uses `ps -p PID -o command=` which is POSIX-portable. Match requires the
// exact vault path to appear in the command line: daftari's CLI requires
// `--vault <path>` as a positional argument, so the path is always in argv.
// We deliberately do NOT match on the substring "daftari" anywhere in the
// output, because the daftari repo's own path contains that string and would
// falsely match any node process whose cwd or argv includes the repo root
// (e.g. vitest workers).
export function isDaftariProcess(pid: number, vaultRoot: string): boolean {
  if (!isProcessAlive(pid)) return false;
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out.length === 0) return false;
    return out.includes(vaultRoot);
  } catch {
    return false;
  }
}

// Wait until pid exits or until timeoutMs elapses. Returns true if pid is
// gone. Polled with setTimeout so we don't peg a CPU core during the grace
// window.
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const POLL_MS = 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(POLL_MS);
  }
  return !isProcessAlive(pid);
}

const SIGTERM_GRACE_MS = 3000;

// Atomic O_EXCL create. Returns ok(true) if we created the lockfile (sole
// owner), ok(false) on EEXIST (caller must read and resolve).
function tryCreateExclusive(vaultRoot: string, data: LockData): Result<boolean, Error> {
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    const fd = openSync(lockPath(vaultRoot), "wx");
    try {
      writeSync(fd, JSON.stringify(data, null, 2));
    } finally {
      closeSync(fd);
    }
    return ok(true);
  } catch (e) {
    const errno = e as NodeJS.ErrnoException;
    if (errno.code === "EEXIST") return ok(false);
    return err(errno);
  }
}

// Acquire the per-vault process lock. Behavior:
//   - No existing lock → atomic O_EXCL create, return ok.
//   - Existing lock with dead PID → stale, overwrite.
//   - Existing lock with live PID that does not look like a daftari for this
//     vault (PID recycled) → stale, overwrite.
//   - Existing lock with live daftari for this vault → SIGTERM it, wait up to
//     3s for exit, then overwrite. If it does not exit, log a warning and
//     overwrite anyway.
//
// Logs go to stderr (MCP convention; stdout is reserved for JSON-RPC).
export async function acquireLock(
  vaultRoot: string,
  version: string,
): Promise<Result<void, Error>> {
  const our: LockData = {
    daftari: true,
    pid: process.pid,
    vaultRoot,
    startedAt: new Date().toISOString(),
    version,
  };

  const created = tryCreateExclusive(vaultRoot, our);
  if (!created.ok) return created;
  if (created.value) return ok(undefined);

  const existing = readLockfile(vaultRoot);
  if (!existing.ok) return existing;

  if (existing.value !== null) {
    const prior = existing.value;
    if (isDaftariProcess(prior.pid, vaultRoot)) {
      process.stderr.write(
        `daftari: another instance is holding this vault (pid=${prior.pid}, ` +
          `started=${prior.startedAt}); sending SIGTERM and taking over\n`,
      );
      try {
        process.kill(prior.pid, "SIGTERM");
      } catch {
        // Died between check and signal — fine.
      }
      const exited = await waitForExit(prior.pid, SIGTERM_GRACE_MS);
      if (!exited) {
        process.stderr.write(
          `daftari: warning: pid ${prior.pid} did not exit within ` +
            `${SIGTERM_GRACE_MS}ms; proceeding anyway\n`,
        );
      }
    } else {
      process.stderr.write(
        `daftari: removing stale lockfile (pid=${prior.pid} not a live daftari instance)\n`,
      );
    }
  }

  return writeLockfile(vaultRoot, our);
}
