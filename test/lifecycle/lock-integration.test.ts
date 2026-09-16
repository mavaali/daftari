// Spawns two real daftari processes against the same vault. Asserts that the
// first one exits within the SIGTERM grace window and that the second is
// still running. End-to-end check that issue #52 is fixed.
//
// Requires `npm run build` to have run — the test executes dist/index.js.
//
// Synchronization note: takeover is symmetric — whoever writes .daftari/
// process.lock FIRST is the holder, and the SECOND process SIGTERMs it. So the
// test must wait until procA DETERMINISTICALLY holds the lock before spawning
// procB; a fixed sleep is race-prone (under load procA's cold-start can exceed
// it, procB then wins the lock and procA takes over procB — inverting the
// assertion). We poll the lockfile for the holder pid instead of sleeping.

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const FIXTURE = resolve("test/fixtures/sample-vault");

// Read the current lock holder's pid, or null if the lockfile is absent/invalid.
function lockHolderPid(vault: string): number | null {
  try {
    const raw = readFileSync(join(vault, ".daftari", "process.lock"), "utf-8");
    const parsed = JSON.parse(raw) as { daftari?: boolean; pid?: number };
    if (parsed?.daftari === true && typeof parsed.pid === "number") return parsed.pid;
    return null;
  } catch {
    return null;
  }
}

// Poll `pred` until it is true or the timeout elapses. Returns pred's final value.
async function waitUntil(pred: () => boolean, timeoutMs: number, pollMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(pollMs);
  }
  return pred();
}

describe("two daftari processes against one vault", () => {
  let vault: string;

  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-lockint-"));
    cpSync(FIXTURE, vault, {
      recursive: true,
      filter: (src) => !src.includes(".daftari"),
    });
  });

  afterAll(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("second instance takes over from the first", async () => {
    const entry = resolve("dist/index.js");
    expect(existsSync(entry)).toBe(true);

    const procA = spawn("node", [entry, "--vault", vault], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    // Wait until A actually HOLDS the lock before starting B (see note above).
    const aHoldsLock = await waitUntil(() => lockHolderPid(vault) === procA.pid, 15_000);
    expect(aHoldsLock).toBe(true);

    const procB = spawn("node", [entry, "--vault", vault], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    // B, finding A's live lock, SIGTERMs A and takes over. A should exit within
    // the SIGTERM grace (3s) plus generous slack for a loaded machine.
    const aExited = await new Promise<boolean>((resolveExit) => {
      const timer = setTimeout(() => resolveExit(false), 10_000);
      procA.once("exit", () => {
        clearTimeout(timer);
        resolveExit(true);
      });
    });

    expect(aExited).toBe(true);
    expect(procB.killed).toBe(false);
    expect(procB.exitCode).toBeNull();
    // B is now the surviving holder.
    expect(await waitUntil(() => lockHolderPid(vault) === procB.pid, 5_000)).toBe(true);

    procB.kill("SIGTERM");
    await new Promise((r) => procB.once("exit", r));
  }, 40_000);
});

describe("crash-orphaned lock naming the acquirer's own pid", () => {
  let vault: string;

  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-lockself-"));
    cpSync(FIXTURE, vault, {
      recursive: true,
      filter: (src) => !src.includes(".daftari"),
    });
  });

  afterAll(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  // The container scenario: a persistent vault volume outlives the process,
  // and pids in a fresh container are near-deterministic — so a crash-orphaned
  // lock routinely names the REPLACEMENT process's own pid. The child spawned
  // here has the vault path in its argv (so the ps-based liveness check would
  // match) and a lock naming its own pid; it must treat that lock as stale and
  // acquire, not mistake itself for a live holder and SIGTERM itself.
  it("is treated as stale, not as a live holder", async () => {
    const lockModule = resolve("dist/lifecycle/lock.js");
    expect(existsSync(lockModule)).toBe(true);

    const script =
      `import { mkdirSync } from "node:fs";` +
      `import { join } from "node:path";` +
      `const [lockModulePath, vault] = process.argv.slice(1);` +
      `const { acquireLock, writeLockfile } = await import(lockModulePath);` +
      `mkdirSync(join(vault, ".daftari"), { recursive: true });` +
      `writeLockfile(vault, { daftari: true, pid: process.pid, vaultRoot: vault,` +
      ` startedAt: new Date().toISOString(), version: "0.0.0" });` +
      `const r = await acquireLock(vault, "0.0.0");` +
      `process.exit(r.ok ? 0 : 7);`;

    const child = spawn("node", ["--input-type=module", "-e", script, lockModule, vault], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const outcome = await new Promise<{ code: number | null; signal: string | null }>(
      (resolveExit) => {
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      },
    );

    // A self-SIGTERM shows up as signal-terminated; a live-holder refusal as
    // exit 7. Both are the bug.
    expect(outcome.signal, stderr).toBeNull();
    expect(outcome.code, stderr).toBe(0);
    expect(lockHolderPid(vault)).toBe(child.pid);
  }, 30_000);
});
