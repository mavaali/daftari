// config-default-role.test.ts — kg64: `default_role` is the role a stdio
// server runs as when started without --role. Absent = deny-all guest
// (unchanged for existing vaults); it must name a declared role.
//
// Run with: npx vitest run test/utils/config-default-role.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig } from "../../src/utils/config.js";

describe("loadConfig — default_role", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-config-default-role-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function load(yaml: string) {
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(configPath(dir), yaml);
    return loadConfig(dir);
  }

  const base = "version: 1\nvault_name: v\nroles:\n  admin:\n    read: ['*']\n";

  it("is null when absent", () => {
    const result = load(base);
    expect(result.ok && result.value.defaultRole).toBe(null);
  });

  it("parses a declared role", () => {
    const result = load(`${base}default_role: admin\n`);
    expect(result.ok && result.value.defaultRole).toBe("admin");
  });

  it("rejects a role not declared under roles", () => {
    const result = load(`${base}default_role: superuser\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/default_role.*superuser/);
  });

  it("rejects an inherited Object key (constructor/__proto__/toString)", () => {
    for (const k of ["constructor", "__proto__", "toString"]) {
      expect(load(`${base}default_role: ${k}\n`).ok, k).toBe(false);
    }
  });

  it("rejects a non-string value", () => {
    const result = load(`${base}default_role: true\n`);
    expect(result.ok).toBe(false);
  });
});
