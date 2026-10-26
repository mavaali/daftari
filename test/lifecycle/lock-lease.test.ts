// Lease lock (istf): liveness is a renewed lease, not "is this pid a daftari
// process?". The holder id is host identity + pid + a random nonce; the holder
// refreshes heartbeatAt every heartbeatMs; another process takes over only
// once the lease has lapsed, or — on the SAME host — once the holder's pid is
// provably dead. None of this may depend on `ps` (Windows has none, and a
// vault on a shared mount is held by processes we cannot see).

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  HEARTBEAT_MS,
  hostId,
  LEASE_MS,
  type LockData,
  releaseLock,
} from "../../src/lifecycle/lock.js";

const HELPER = resolve("test/helpers/lease-holder.ts");
const FOREIGN_HOST = "some-other-machine|boot-0000|pidns-0";

function lockFile(vault: string): string {
  return join(vault, ".daftari", "process.lock");
}

function rawLock(vault: string): LockData | null {
  try {
    return JSON.parse(readFileSync(lockFile(vault), "utf-8")) as LockData;
  } catch {
    return null;
  }
}

function writeLease(vault: string, data: Partial<LockData> & { pid: number }): void {
  const full: LockData = {
    daftari: true,
    vaultRoot: vault,
    startedAt: "2026-10-25T00:00:00.000Z",
    version: "test",
    host: FOREIGN_HOST,
    nonce: "n-foreign",
    heartbeatAt: new Date().toISOString(),
    heartbeatMs: 50,
    leaseMs: 500,
    ...data,
  };
  writeFileSync(lockFile(vault), JSON.stringify(full));
}

async function waitUntil(pred: () => boolean, timeoutMs: number, pollMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(pollMs);
  }
  return pred();
}

type Holder = { child: ChildProcess; out: () => string; exited: Promise<number | null> };

function spawnHolder(
  vault: string,
  mode: "stdio" | "serve",
  heartbeatMs: number,
  leaseMs: number,
  takeover = false,
): Holder {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      HELPER,
      mode,
      String(heartbeatMs),
      String(leaseMs),
      ...(takeover ? ["takeover"] : []),
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LEASE_VAULT: vault } },
  );
  let out = "";
  child.stdout?.on("data", (c: Buffer) => {
    out += c.toString();
  });
  child.stderr?.on("data", () => undefined);
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  return { child, out: () => out, exited };
}

describe("lease lock", () => {
  let vault: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-lease-"));
    mkdirSync(join(vault, ".daftari"), { recursive: true });
  });

  afterEach(() => {
    releaseLock(vault);
    for (const c of children) {
      if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    }
    children.length = 0;
    rmSync(vault, { recursive: true, force: true });
  });

  it("defaults: the lease is a whole multiple (>= 5x) of the heartbeat", () => {
    expect(LEASE_MS % HEARTBEAT_MS).toBe(0);
    expect(LEASE_MS / HEARTBEAT_MS).toBeGreaterThanOrEqual(5);
  });

  it("host identity is stable within a process and names the machine", () => {
    expect(hostId()).toBe(hostId());
    expect(hostId().length).toBeGreaterThan(0);
  });

  it("records holder identity (host + pid + nonce) and lease timing", async () => {
    const r = await acquireLock(vault, "1.0.0");
    expect(r.ok).toBe(true);
    const l = rawLock(vault);
    expect(l?.pid).toBe(process.pid);
    expect(l?.host).toBe(hostId());
    expect(typeof l?.nonce).toBe("string");
    expect((l?.nonce ?? "").length).toBeGreaterThanOrEqual(16);
    expect(typeof l?.heartbeatAt).toBe("string");
    expect(l?.heartbeatMs).toBe(HEARTBEAT_MS);
    expect(l?.leaseMs).toBe(LEASE_MS);
  });

  it("a heartbeat keeps refreshing heartbeatAt, and stops on release", async () => {
    const r = await acquireLock(vault, "1.0.0", { heartbeatMs: 30, leaseMs: 300 });
    expect(r.ok).toBe(true);
    const first = rawLock(vault)?.heartbeatAt;
    expect(await waitUntil(() => rawLock(vault)?.heartbeatAt !== first, 2_000)).toBe(true);
    const nonce = rawLock(vault)?.nonce;
    expect(nonce).toBeDefined();
    releaseLock(vault);
    expect(existsSync(lockFile(vault))).toBe(false);
    await sleep(150);
    // A stopped heartbeat never resurrects the released lock.
    expect(existsSync(lockFile(vault))).toBe(false);
  });

  it("a holder whose lock was taken over reports the lost lease and stops writing", async () => {
    let lost = 0;
    const r = await acquireLock(vault, "1.0.0", {
      heartbeatMs: 30,
      leaseMs: 300,
      onLeaseLost: () => {
        lost++;
      },
    });
    expect(r.ok).toBe(true);
    writeLease(vault, { pid: 2 ** 30, nonce: "n-new-owner" });
    expect(await waitUntil(() => lost === 1, 2_000)).toBe(true);
    await sleep(150);
    expect(rawLock(vault)?.nonce).toBe("n-new-owner");
    expect(lost).toBe(1);
  });

  it("a lock deleted out from under a live holder is reclaimed, not reported lost", async () => {
    let lost = 0;
    const r = await acquireLock(vault, "1.0.0", {
      heartbeatMs: 30,
      leaseMs: 300,
      onLeaseLost: () => {
        lost++;
      },
    });
    expect(r.ok).toBe(true);
    const nonce = rawLock(vault)?.nonce;
    rmSync(lockFile(vault));
    expect(await waitUntil(() => rawLock(vault)?.nonce === nonce, 2_000)).toBe(true);
    expect(lost).toBe(0);
  });

  it("a heartbeating holder keeps the lease alive well past one lease period", async () => {
    const h = spawnHolder(vault, "stdio", 40, 300);
    children.push(h.child);
    expect(await waitUntil(() => h.out().includes("ok"), 15_000)).toBe(true);
    await sleep(1_200); // four lease periods
    const r = await acquireLock(vault, "1.0.0", { mode: "serve" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("--takeover");
    expect(rawLock(vault)?.pid).toBe(h.child.pid);
  }, 30_000);

  it("a live holder whose command line does not name the vault is NOT judged stale", async () => {
    // The ps-based check called this holder stale (no vault path on its argv)
    // and let a second writer in. The lease says it is alive.
    const h = spawnHolder(vault, "serve", 40, 2_000);
    children.push(h.child);
    expect(await waitUntil(() => h.out().includes("ok"), 15_000)).toBe(true);
    const r = await acquireLock(vault, "1.0.0", { mode: "stdio" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("daftari serve");
    expect(rawLock(vault)?.pid).toBe(h.child.pid);
  }, 30_000);

  it("same host, holder crashed (pid dead): fast takeover without waiting out the lease", async () => {
    const h = spawnHolder(vault, "stdio", 40, 60_000);
    children.push(h.child);
    expect(await waitUntil(() => h.out().includes("ok"), 15_000)).toBe(true);
    h.child.kill("SIGKILL");
    await h.exited;
    const started = Date.now();
    const r = await acquireLock(vault, "1.0.0", { mode: "serve" });
    expect(r.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(rawLock(vault)?.pid).toBe(process.pid);
  }, 30_000);

  it("a foreign-host holder with a fresh lease is NOT judged dead by its pid", async () => {
    writeLease(vault, { pid: 2 ** 30, leaseMs: 60_000, heartbeatMs: 5_000 });
    for (const mode of ["stdio", "serve"] as const) {
      const r = await acquireLock(vault, "1.0.0", { mode, takeover: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain("another machine");
    }
    expect(rawLock(vault)?.nonce).toBe("n-foreign");
  });

  it("pid reuse: a foreign lock naming OUR pid is a live holder, not our own leftover", async () => {
    // Cowork VMs: tiny per-sandbox pid spaces make the remote holder's pid
    // routinely equal to ours.
    writeLease(vault, { pid: process.pid, leaseMs: 60_000, heartbeatMs: 5_000 });
    const r = await acquireLock(vault, "1.0.0");
    expect(r.ok).toBe(false);
    expect(rawLock(vault)?.nonce).toBe("n-foreign");
  });

  it("same host, pid reused by an unrelated process: never signalled; taken once the lease lapses", async () => {
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(bystander);
    const pid = bystander.pid as number;
    // A crashed holder's lock, still inside its lease, whose pid now belongs
    // to the bystander. It never heartbeats.
    writeLease(vault, { pid, host: hostId(), heartbeatMs: 50, leaseMs: 600 });
    const r = await acquireLock(vault, "1.0.0", { mode: "stdio" });
    expect(r.ok).toBe(true);
    expect(rawLock(vault)?.pid).toBe(process.pid);
    expect(bystander.exitCode).toBeNull();
    expect(bystander.signalCode).toBeNull();
  }, 15_000);

  it("a lapsed foreign lease is taken over", async () => {
    writeLease(vault, {
      pid: 2 ** 30,
      heartbeatAt: new Date(Date.now() - 10_000).toISOString(),
      heartbeatMs: 50,
      leaseMs: 500,
    });
    const r = await acquireLock(vault, "1.0.0");
    expect(r.ok).toBe(true);
    expect(rawLock(vault)?.pid).toBe(process.pid);
  });

  it("clock skew: a lease that LOOKS lapsed but is still being renewed is live", async () => {
    // The holder's clock runs far behind ours: every heartbeat it writes is
    // "old" by our clock, but it keeps changing. Wall-clock expiry alone
    // would hand the vault to a second writer.
    let n = 0;
    const renew = () =>
      writeLease(vault, {
        pid: 2 ** 30,
        heartbeatAt: new Date(Date.now() - 3_600_000 + n++).toISOString(),
        heartbeatMs: 50,
        leaseMs: 500,
      });
    renew();
    const timer = setInterval(renew, 25);
    try {
      const r = await acquireLock(vault, "1.0.0");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain("another machine");
    } finally {
      clearInterval(timer);
    }
  });

  it("clock skew: a crashed holder whose clock runs AHEAD frees the vault within one lease", async () => {
    writeLease(vault, {
      pid: 2 ** 30,
      heartbeatAt: new Date(Date.now() + 3_600_000).toISOString(),
      heartbeatMs: 50,
      leaseMs: 500,
    });
    const started = Date.now();
    const r = await acquireLock(vault, "1.0.0");
    expect(r.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("clock skew: a renewing holder whose clock runs AHEAD stays live", async () => {
    let n = 0;
    const renew = () =>
      writeLease(vault, {
        pid: 2 ** 30,
        heartbeatAt: new Date(Date.now() + 3_600_000 + n++).toISOString(),
        heartbeatMs: 50,
        leaseMs: 500,
      });
    renew();
    const timer = setInterval(renew, 25);
    try {
      const r = await acquireLock(vault, "1.0.0");
      expect(r.ok).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });

  it("renewal takes the break mutex: a holder never renews while a breaker is mid-break", async () => {
    const r = await acquireLock(vault, "1.0.0", { heartbeatMs: 30, leaseMs: 300 });
    expect(r.ok).toBe(true);
    const mutex = join(vault, ".daftari", "process.lock.break");
    writeFileSync(
      mutex,
      JSON.stringify({
        nonce: "n-breaker",
        host: FOREIGN_HOST,
        pid: 1,
        at: new Date().toISOString(),
      }),
    );
    await sleep(60);
    const frozen = rawLock(vault)?.heartbeatAt;
    await sleep(200);
    expect(rawLock(vault)?.heartbeatAt).toBe(frozen);
    rmSync(mutex);
    expect(await waitUntil(() => rawLock(vault)?.heartbeatAt !== frozen, 2_000)).toBe(true);
  });

  it("a pre-lease lockfile with a live pid is refused, never signalled", async () => {
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(bystander);
    writeFileSync(
      lockFile(vault),
      JSON.stringify({
        daftari: true,
        pid: bystander.pid,
        vaultRoot: vault,
        startedAt: "2026-01-01T00:00:00.000Z",
        version: "3.17.0",
      }),
    );
    const r = await acquireLock(vault, "1.0.0", { mode: "stdio" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("older daftari");
    await sleep(100);
    expect(bystander.exitCode).toBeNull();
    expect(bystander.signalCode).toBeNull();
  });

  it("a breaker holding the takeover mutex is not raced; a stale mutex is cleared", async () => {
    const stale = {
      pid: 2 ** 30,
      heartbeatAt: new Date(Date.now() - 10_000).toISOString(),
    };
    writeLease(vault, stale);
    const mutex = join(vault, ".daftari", "process.lock.break");
    writeFileSync(
      mutex,
      JSON.stringify({
        nonce: "n-breaker",
        host: FOREIGN_HOST,
        pid: 1,
        at: new Date().toISOString(),
      }),
    );
    const blocked = await acquireLock(vault, "1.0.0");
    expect(blocked.ok).toBe(false);
    expect(rawLock(vault)?.nonce).toBe("n-foreign");

    writeFileSync(
      mutex,
      JSON.stringify({
        nonce: "n-breaker",
        host: FOREIGN_HOST,
        pid: 1,
        at: new Date(Date.now() - 600_000).toISOString(),
      }),
    );
    const r = await acquireLock(vault, "1.0.0");
    expect(r.ok).toBe(true);
    expect(rawLock(vault)?.pid).toBe(process.pid);
    expect(existsSync(mutex)).toBe(false);
  });

  it("contended takeover: racing contenders for one lapsed lease produce exactly one holder", async () => {
    for (let round = 0; round < 3; round++) {
      writeLease(vault, {
        pid: 2 ** 30,
        heartbeatAt: new Date(Date.now() - 10_000).toISOString(),
        heartbeatMs: 50,
        leaseMs: 500,
      });
      const hs = Array.from({ length: 4 }, () => spawnHolder(vault, "serve", 40, 2_000));
      for (const h of hs) children.push(h.child);
      expect(await waitUntil(() => hs.every((h) => /ok|refused/.test(h.out())), 25_000)).toBe(true);
      const winners = hs.filter((h) => h.out().startsWith("ok"));
      expect(winners.length).toBe(1);
      const winner = winners[0] as Holder;
      expect(rawLock(vault)?.pid).toBe(winner.child.pid);
      // The winner keeps it: no loser silently overwrote the lease afterwards.
      await sleep(200);
      expect(rawLock(vault)?.pid).toBe(winner.child.pid);
      expect(winner.out()).not.toContain("lost");
      for (const h of hs) h.child.kill("SIGKILL");
      await Promise.all(hs.map((h) => h.exited));
      rmSync(lockFile(vault), { force: true });
    }
  }, 90_000);
});
