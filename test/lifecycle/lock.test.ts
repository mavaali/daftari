import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  isDaftariProcess,
  isProcessAlive,
  type LockData,
  readLockfile,
  releaseLock,
  writeLockfile,
} from "../../src/lifecycle/lock.js";

describe("lockfile I/O", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-lock-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("round-trips lock data", () => {
    const data: LockData = {
      daftari: true,
      pid: 12345,
      vaultRoot: vault,
      startedAt: "2026-05-20T18:00:00.000Z",
      version: "1.10.0",
    };
    const w = writeLockfile(vault, data);
    expect(w.ok).toBe(true);
    const r = readLockfile(vault);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(data);
  });

  it("returns null for missing lockfile", () => {
    const r = readLockfile(vault);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it("returns null for malformed JSON (does not throw)", () => {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(join(vault, ".daftari", "process.lock"), "not json", "utf-8");
    const r = readLockfile(vault);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it("returns null for JSON missing the daftari sentinel", () => {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(join(vault, ".daftari", "process.lock"), JSON.stringify({ pid: 42 }), "utf-8");
    const r = readLockfile(vault);
    if (r.ok) expect(r.value).toBeNull();
  });
});

describe("isProcessAlive", () => {
  it("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for an unused PID (very high number)", () => {
    expect(isProcessAlive(2 ** 30)).toBe(false);
  });
});

describe("isDaftariProcess", () => {
  it("returns a boolean for the current process", () => {
    const result = isDaftariProcess(process.pid, "/some/vault");
    expect(typeof result).toBe("boolean");
  });

  it("returns false for an unused PID", () => {
    expect(isDaftariProcess(2 ** 30, "/some/vault")).toBe(false);
  });
});

describe("acquireLock", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-acquire-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("writes a fresh lock when none exists", async () => {
    const r = await acquireLock(vault, "1.10.0");
    expect(r.ok).toBe(true);
    const read = readLockfile(vault);
    expect(read.ok).toBe(true);
    if (read.ok && read.value) {
      expect(read.value.pid).toBe(process.pid);
      expect(read.value.vaultRoot).toBe(vault);
    }
  });

  it("overwrites a stale lock (dead PID)", async () => {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeLockfile(vault, {
      daftari: true,
      pid: 2 ** 30,
      vaultRoot: vault,
      startedAt: "2026-01-01T00:00:00.000Z",
      version: "1.9.1",
    });
    const r = await acquireLock(vault, "1.10.0");
    expect(r.ok).toBe(true);
    const read = readLockfile(vault);
    if (read.ok && read.value) expect(read.value.pid).toBe(process.pid);
  });

  it("overwrites a lock whose vaultRoot points elsewhere (PID recycled to unrelated process)", async () => {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeLockfile(vault, {
      daftari: true,
      pid: process.pid,
      vaultRoot: "/some/other/vault",
      startedAt: "2026-01-01T00:00:00.000Z",
      version: "1.9.1",
    });
    const r = await acquireLock(vault, "1.10.0");
    expect(r.ok).toBe(true);
  });
});

describe("releaseLock", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-release-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("removes the lockfile when we own it", async () => {
    await acquireLock(vault, "1.10.0");
    expect(existsSync(join(vault, ".daftari", "process.lock"))).toBe(true);
    releaseLock(vault);
    expect(existsSync(join(vault, ".daftari", "process.lock"))).toBe(false);
  });

  it("is a no-op if the lockfile is missing", () => {
    expect(() => releaseLock(vault)).not.toThrow();
  });

  it("does NOT remove a lockfile owned by a different PID", () => {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeLockfile(vault, {
      daftari: true,
      pid: process.pid + 9999,
      vaultRoot: vault,
      startedAt: "2026-01-01T00:00:00.000Z",
      version: "1.9.1",
    });
    releaseLock(vault);
    expect(existsSync(join(vault, ".daftari", "process.lock"))).toBe(true);
  });
});
