// Process-level lockfile for a vault. Prevents two daftari processes from
// running against the same vault concurrently and corrupting the shared
// index.db. See docs/superpowers/plans/2026-05-20-process-lockfile.md (#52).

import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { err, ok, type Result } from "../frontmatter/types.js";

// #5 (spec 2026-07-20 Decision 4): the lock records HOW the holder serves.
// Absent (pre-#5 lockfiles) means stdio.
export type LockMode = "stdio" | "serve";

export type LockData = {
  daftari: true;
  pid: number;
  vaultRoot: string;
  startedAt: string;
  version: string;
  mode?: LockMode;
  // serve holders record their bind so a refusal message can name the
  // remedy ("connect to http://<bind>:<port>/mcp").
  bind?: string;
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

export interface AcquireLockOptions {
  mode?: LockMode; // default "stdio"
  bind?: string; // recorded for serve holders (refusal-message remedy)
  // Explicit consent to SIGTERM a LIVE holder from `daftari serve`. Without
  // it, serve refuses against any live holder (Decision 4).
  takeover?: boolean;
}

// Acquire the per-vault process lock. Behavior (#52, amended by #5 spec
// 2026-07-20 Decision 4):
//   - No existing lock → atomic O_EXCL create, return ok.
//   - Existing lock with dead PID → stale, overwrite (every mode).
//   - Existing lock with live PID that does not look like a daftari for this
//     vault (PID recycled) → stale, overwrite (every mode).
//   - LIVE daftari holder — precedence favors the durable tenant:
//       stdio finding stdio          → SIGTERM-and-wait takeover (the
//                                      single-user convenience, unchanged).
//       stdio finding serve          → REFUSE, naming the server and the
//                                      remedy. Never SIGTERMs a serve holder.
//       serve finding stdio or serve → REFUSE unless --takeover: a server
//                                      deployment must not silently kill a
//                                      live desktop session, and a
//                                      double-start must not bounce every
//                                      session. With takeover, SIGTERM-and-
//                                      wait against either holder mode.
//
// Logs go to stderr (MCP convention; stdout is reserved for JSON-RPC).
export async function acquireLock(
  vaultRoot: string,
  version: string,
  options: AcquireLockOptions = {},
): Promise<Result<void, Error>> {
  const mode: LockMode = options.mode ?? "stdio";
  const our: LockData = {
    daftari: true,
    pid: process.pid,
    vaultRoot,
    startedAt: new Date().toISOString(),
    version,
    mode,
    ...(options.bind ? { bind: options.bind } : {}),
  };

  const created = tryCreateExclusive(vaultRoot, our);
  if (!created.ok) return created;
  if (created.value) return ok(undefined);

  const existing = readLockfile(vaultRoot);
  if (!existing.ok) return existing;

  if (existing.value !== null) {
    const prior = existing.value;
    if (isDaftariProcess(prior.pid, vaultRoot)) {
      const priorMode: LockMode = prior.mode ?? "stdio";
      const holder =
        `pid=${prior.pid}, mode=${priorMode}, started=${prior.startedAt}` +
        (prior.bind ? `, bind=${prior.bind}` : "");

      if (mode === "stdio" && priorMode === "serve") {
        return err(
          new Error(
            `this vault is held by a live daftari serve (${holder}). ` +
              `Connect to it over HTTP instead, or stop the server ` +
              `deliberately (or replace it with 'daftari serve --takeover').`,
          ),
        );
      }
      if (mode === "serve" && !options.takeover) {
        return err(
          new Error(
            `this vault is held by a live daftari instance (${holder}). ` +
              `A server start never silently replaces a live holder; ` +
              `re-run with --takeover to replace it deliberately.`,
          ),
        );
      }

      process.stderr.write(
        `daftari: another instance is holding this vault (${holder}); ` +
          `sending SIGTERM and taking over\n`,
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

// Idempotent. Removes the lockfile only if it still belongs to us — protects
// against a race where takeover happens during our shutdown and we'd
// otherwise delete the new owner's lock. Stays sync because it runs from
// `process.on("exit")`, which forbids async work.
export function releaseLock(vaultRoot: string): void {
  const existing = readLockfile(vaultRoot);
  if (!existing.ok || existing.value === null) return;
  if (existing.value.pid !== process.pid) return;
  try {
    unlinkSync(lockPath(vaultRoot));
  } catch {
    // Best-effort. If the file is already gone, fine.
  }
}
