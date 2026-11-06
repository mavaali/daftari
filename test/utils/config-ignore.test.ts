// #646: `ignore` lists files that are not vault documents. A bad entry fails
// loud like every other block; `!` in particular would otherwise invert.
//
// Run with: npx vitest run test/utils/config-ignore.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig } from "../../src/utils/config.js";

describe("loadConfig — ignore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-config-ignore-"));
    mkdirSync(join(dir, ".daftari"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function load(yaml: string) {
    writeFileSync(configPath(dir), yaml);
    return loadConfig(dir);
  }

  it("defaults to an empty list, with or without a config file", () => {
    const missing = loadConfig(dir);
    expect(missing.ok && missing.value.ignore).toEqual([]);
    const absent = load("version: 1\n");
    expect(absent.ok && absent.value.ignore).toEqual([]);
  });

  it("parses entries and strips trailing slashes", () => {
    const result = load("ignore:\n  - README.md\n  - Clippings/\n  - 'archive/**/*.md'\n");
    expect(result.ok && result.value.ignore).toEqual(["README.md", "Clippings", "archive/**/*.md"]);
  });

  it("rejects a non-list and non-string entries", () => {
    expect(load("ignore: README.md\n").ok).toBe(false);
    expect(load("ignore:\n").ok).toBe(false);
    expect(load("ignore:\n  - 3\n").ok).toBe(false);
  });

  it.each([
    ["blank", "''"],
    ["whitespace only", "'  '"],
    ["only a slash", "/"],
    ["absolute", "/etc/passwd"],
    ["negated", "'!README.md'"],
    ["backslashed", "'a\\b.md'"],
    ["parent traversal", "../outside.md"],
    ["nested traversal", "a/../b.md"],
    ["leading dot segment", "./README.md"],
  ])("rejects a %s entry", (_label, entry) => {
    const result = load(`ignore:\n  - ${entry}\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/malformed config: 'ignore'/);
  });
});
