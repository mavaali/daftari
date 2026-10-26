// #5 (spec 2026-07-20 Decision 4): mode-aware lock precedence. A LIVE holder
// is a fresh same-host lease naming a live pid (an inert node process) for
// the refusal matrix — a refusal never needs proof of life — and a real
// heartbeating holder (test/helpers/lease-holder.ts) for the takeover rows,
// since a takeover signals the holder only once its heartbeat is seen to
// advance (istf).

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, hostId, type LockData, readLockfile } from "../../src/lifecycle/lock.js";

function lockDataFor(vault: string, pid: number, mode?: "stdio" | "serve"): LockData {
  return {
    daftari: true,
    pid,
    vaultRoot: vault,
    startedAt: "2026-07-20T00:00:00Z",
    version: "test",
    host: hostId(),
    nonce: `n-${pid}`,
    heartbeatAt: new Date().toISOString(),
    heartbeatMs: 1_000,
    leaseMs: 60_000,
    ...(mode ? { mode } : {}),
    ...(mode === "serve" ? { bind: "127.0.0.1:8787" } : {}),
  };
}

// A real heartbeating holder; resolves once it holds the lock.
async function spawnLeaseHolder(vault: string, mode: "stdio" | "serve"): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve("test/helpers/lease-holder.ts"), mode, "100", "2000"],
    { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LEASE_VAULT: vault } },
  );
  let out = "";
  child.stdout?.on("data", (c: Buffer) => {
    out += c.toString();
  });
  const deadline = Date.now() + 15_000;
  while (!out.includes("ok") && Date.now() < deadline) await sleep(20);
  if (!out.includes("ok")) throw new Error(`lease holder did not acquire: ${out}`);
  return child;
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

  // A live process to name in a fresh same-host lease.
  async function spawnHolder(): Promise<number> {
    holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const pid = holder.pid;
    if (pid === undefined) throw new Error("spawn failed");
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
    holder = await spawnLeaseHolder(vault, "stdio");
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
  }, 20_000);

  it("stdio finding a live stdio holder keeps today's takeover semantics", async () => {
    holder = await spawnLeaseHolder(vault, "stdio");
    const exited = new Promise((r) => holder?.once("exit", r));
    const r = await acquireLock(vault, "test", { mode: "stdio" });
    expect(r.ok).toBe(true);
    await exited; // SIGTERMed, not merely out-waited
    const now = readLockfile(vault);
    expect(now.ok && now.value?.pid).toBe(process.pid);
  }, 20_000);

  it("a lease with NO mode field reads as stdio (pre-#5 lockfile shape)", async () => {
    const pid = await spawnHolder();
    writeHolderLock(pid, undefined);
    const r = await acquireLock(vault, "test", { mode: "serve" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("mode=stdio");
  });

  it("stale serve locks are overwritten silently in every mode", async () => {
    // A dead PID: nothing to refuse against, whatever the recorded mode.
    writeHolderLock(2 ** 30, "serve");
    const r = await acquireLock(vault, "test", { mode: "stdio" });
    expect(r.ok).toBe(true);
    const now = readLockfile(vault);
    expect(now.ok && now.value?.pid).toBe(process.pid);
  });
});
