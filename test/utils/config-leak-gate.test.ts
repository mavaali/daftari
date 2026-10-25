// Config parsing for the `leak_gate` block (cross-vault leak gate, U2). One
// optional key: `session_ledger_path`, an override for the OS-level ledger
// location the leak-ledger module otherwise defaults on its own. Same
// loud-config contract as every other block in this file.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig } from "../../src/utils/config.js";

describe("loadConfig — leak_gate", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-config-leak-gate-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): void {
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(configPath(dir), yaml);
  }

  it("defaults to an empty block (no override) when absent", () => {
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.leakGate).toEqual({ mode: "off" });
  });

  it("parses a configured session_ledger_path", () => {
    writeConfig('leak_gate:\n  session_ledger_path: "/tmp/custom-ledger.jsonl"\n');
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.leakGate.sessionLedgerPath).toBe("/tmp/custom-ledger.jsonl");
  });

  it("fails loud on a non-string session_ledger_path", () => {
    writeConfig("leak_gate:\n  session_ledger_path: 42\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/session_ledger_path/);
    expect(result.error.message).toMatch(/string/);
  });

  it("fails loud on an unknown key in the leak_gate block", () => {
    writeConfig("leak_gate:\n  bogus_key: true\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/leak_gate/);
  });

  it("fails loud when leak_gate is not a mapping", () => {
    writeConfig("leak_gate: 42\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/leak_gate/);
    expect(result.error.message).toMatch(/mapping/);
  });

  it("defaults leak_gate.mode to off (a household deployment opts in with mode: refuse)", () => {
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.leakGate.mode).toBe("off");
  });

  it("parses a configured leak_gate.mode", () => {
    writeConfig("leak_gate:\n  mode: warn\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.leakGate.mode).toBe("warn");
  });

  it("fails loud on an unknown leak_gate.mode", () => {
    writeConfig("leak_gate:\n  mode: bogus\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/leak_gate\.mode/);
  });
});
