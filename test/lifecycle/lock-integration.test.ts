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
