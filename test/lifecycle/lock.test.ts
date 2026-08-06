import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  commandLineTargetsVault,
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

describe("commandLineTargetsVault", () => {
  const VAULT = "/Users/x/vault";

  // Legitimate holders of THIS vault must still match (no new false-negatives —
  // a missed live holder overwrites its lock and double-writes index.db).
  it("matches the resolved vault path as a whole token, mid-command", () => {
    expect(commandLineTargetsVault(`node cli.js --vault ${VAULT} --user me`, VAULT)).toBe(true);
  });
  it("matches the vault path at end-of-command", () => {
    expect(commandLineTargetsVault(`node cli.js --vault ${VAULT}`, VAULT)).toBe(true);
  });
  it("matches a trailing-slash invocation (resolve() strips it from vaultRoot)", () => {
    expect(commandLineTargetsVault(`node cli.js --vault ${VAULT}/ serve`, VAULT)).toBe(true);
    expect(commandLineTargetsVault(`node cli.js --vault ${VAULT}/`, VAULT)).toBe(true);
  });
  it("matches a vault path containing spaces", () => {
    const spaced = "/Users/x/my vault";
    expect(commandLineTargetsVault(`node cli.js --vault ${spaced} serve`, spaced)).toBe(true);
  });

  // The two documented false-positive shapes must be rejected.
  it("rejects a prefix-aliased sibling vault (…/vault vs …/vault2)", () => {
    expect(commandLineTargetsVault(`node cli.js --vault ${VAULT}2 serve`, VAULT)).toBe(false);
    expect(commandLineTargetsVault(`node cli.js --vault ${VAULT}-backup`, VAULT)).toBe(false);
  });
  it("rejects an unrelated process editing a file inside the vault (PID recycle)", () => {
    expect(commandLineTargetsVault(`vim ${VAULT}/notes.md`, VAULT)).toBe(false);
  });
  it("rejects when the path is absent entirely", () => {
    expect(commandLineTargetsVault("node cli.js --vault /other/place", VAULT)).toBe(false);
  });
  it("matches a real occurrence even when a prefix-alias occurrence appears first", () => {
    expect(commandLineTargetsVault(`x ${VAULT}2 y ${VAULT} z`, VAULT)).toBe(true);
  });
  it("returns false for an empty vaultRoot rather than matching everything", () => {
    expect(commandLineTargetsVault("node cli.js", "")).toBe(false);
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
