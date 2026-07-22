// #5 (spec 2026-07-20 Decision 4): mode-aware lock precedence. A LIVE holder
// is faked by spawning an inert node process whose argv carries the vault
// path — exactly what isDaftariProcess keys on — so the refusal matrix is
// testable without booting real servers.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, type LockData, readLockfile } from "../../src/lifecycle/lock.js";

function lockDataFor(vault: string, pid: number, mode?: "stdio" | "serve"): LockData {
  return {
    daftari: true,
    pid,
    vaultRoot: vault,
    startedAt: "2026-07-20T00:00:00Z",
    version: "test",
    ...(mode ? { mode } : {}),
    ...(mode === "serve" ? { bind: "127.0.0.1:8787" } : {}),
  };
}

describe("mode-aware process lock (#5)", () => {
  let vault: string;
  let holder: ChildProcess | null = null;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-lockmode-"));
    mkdirSync(join(vault, ".daftari"), { recursive: true });
  });

  afterEach(() => {
    if (holder) {
      holder.kill("SIGKILL");
      holder = null;
    }
    rmSync(vault, { recursive: true, force: true });
  });

  // A live process whose ps command line contains the vault path — enough
  // for isDaftariProcess to treat it as a live daftari for this vault.
  async function spawnHolder(): Promise<number> {
    holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", vault], {
      stdio: "ignore",
    });
    const pid = holder.pid;
    if (pid === undefined) throw new Error("spawn failed");
    // Give ps a beat to see it.
    await new Promise((r) => setTimeout(r, 200));
    return pid;
  }

  function writeHolderLock(pid: number, mode?: "stdio" | "serve"): void {
    writeFileSync(
      join(vault, ".daftari", "process.lock"),
      JSON.stringify(lockDataFor(vault, pid, mode)),
    );
  }

  it("stdio REFUSES against a live serve holder, and the holder survives", async () => {
    const pid = await spawnHolder();
    writeHolderLock(pid, "serve");
    const r = await acquireLock(vault, "test", { mode: "stdio" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("daftari serve");
    expect(r.error.message).toContain(`pid=${pid}`);
    expect(r.error.message).toContain("bind=127.0.0.1:8787");
    // The holder was not SIGTERMed and the lockfile still names it.
    expect(holder?.killed).toBe(false);
    const still = readLockfile(vault);
    expect(still.ok && still.value?.pid).toBe(pid);
  });

  it("serve REFUSES against any live holder without --takeover", async () => {
    const pid = await spawnHolder();
    for (const holderMode of ["stdio", "serve"] as const) {
      writeHolderLock(pid, holderMode);
      const r = await acquireLock(vault, "test", { mode: "serve" });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.message).toContain("--takeover");
    }
    expect(holder?.killed).toBe(false);
  });

  it("serve --takeover replaces a live holder of either mode", async () => {
    const pid = await spawnHolder();
    writeHolderLock(pid, "stdio");
    const r = await acquireLock(vault, "test", {
      mode: "serve",
      bind: "127.0.0.1:9999",
      takeover: true,
    });
    expect(r.ok).toBe(true);
    const now = readLockfile(vault);
    expect(now.ok && now.value?.pid).toBe(process.pid);
    expect(now.ok && now.value?.mode).toBe("serve");
    expect(now.ok && now.value?.bind).toBe("127.0.0.1:9999");
  }, 10_000);

  it("stdio finding a live stdio holder keeps today's takeover semantics", async () => {
    const pid = await spawnHolder();
    // A pre-#5 lockfile has NO mode field — it must read as stdio.
    writeHolderLock(pid, undefined);
    const r = await acquireLock(vault, "test", { mode: "stdio" });
    expect(r.ok).toBe(true);
    const now = readLockfile(vault);
    expect(now.ok && now.value?.pid).toBe(process.pid);
  }, 10_000);

  it("stale serve locks are overwritten silently in every mode", async () => {
    // A dead PID: nothing to refuse against, whatever the recorded mode.
    writeHolderLock(2 ** 30, "serve");
    const r = await acquireLock(vault, "test", { mode: "stdio" });
    expect(r.ok).toBe(true);
    const now = readLockfile(vault);
    expect(now.ok && now.value?.pid).toBe(process.pid);
  });
});
