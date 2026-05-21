import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isDaftariProcess,
  isProcessAlive,
  type LockData,
  readLockfile,
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
