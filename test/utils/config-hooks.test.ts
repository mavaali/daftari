import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig } from "../../src/utils/config.js";

describe("loadConfig — hooks", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-config-hooks-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): void {
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(configPath(dir), yaml);
  }

  it("yields an empty hook list when no config file exists", () => {
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hooks).toEqual({ preWrite: [], preWriteTransform: [] });
  });

  it("yields an empty hook list when the block is omitted", () => {
    writeConfig("version: 1\nvault_name: v\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hooks).toEqual({ preWrite: [], preWriteTransform: [] });
  });

  it("parses an ordered list of pre_write hook declarations", () => {
    writeConfig(
      [
        "version: 1",
        "hooks:",
        "  pre_write:",
        "    - path: .daftari/hooks/first.mjs",
        "    - path: .daftari/hooks/second.mjs",
        "",
      ].join("\n"),
    );
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hooks.preWrite).toEqual([
      { path: ".daftari/hooks/first.mjs" },
      { path: ".daftari/hooks/second.mjs" },
    ]);
  });

  it("yields an empty list when pre_write is present but empty", () => {
    writeConfig("hooks:\n  pre_write: []\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hooks.preWrite).toEqual([]);
  });

  it("parses an ordered list of pre_write_transform hook declarations", () => {
    writeConfig(
      [
        "version: 1",
        "hooks:",
        "  pre_write_transform:",
        "    - path: .daftari/hooks/derive-a.mjs",
        "    - path: .daftari/hooks/derive-b.mjs",
        "",
      ].join("\n"),
    );
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hooks.preWriteTransform).toEqual([
      { path: ".daftari/hooks/derive-a.mjs" },
      { path: ".daftari/hooks/derive-b.mjs" },
    ]);
  });

  it("parses pre_write and pre_write_transform as independent lists", () => {
    writeConfig(
      [
        "hooks:",
        "  pre_write_transform:",
        "    - path: .daftari/hooks/transform.mjs",
        "  pre_write:",
        "    - path: .daftari/hooks/validate.mjs",
        "",
      ].join("\n"),
    );
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hooks.preWrite).toEqual([{ path: ".daftari/hooks/validate.mjs" }]);
    expect(result.value.hooks.preWriteTransform).toEqual([
      { path: ".daftari/hooks/transform.mjs" },
    ]);
  });

  describe("malformed", () => {
    const cases: { name: string; yaml: string; contains: string }[] = [
      {
        name: "hooks must be a mapping",
        yaml: "hooks: not-a-mapping\n",
        contains: "'hooks' must be a mapping",
      },
      {
        name: "pre_write must be a list",
        yaml: "hooks:\n  pre_write: not-a-list\n",
        contains: "'hooks.pre_write' must be a list",
      },
      {
        name: "pre_write entry must be a mapping",
        yaml: "hooks:\n  pre_write:\n    - just-a-string\n",
        contains: "'hooks.pre_write[0]' must be a mapping",
      },
      {
        name: "pre_write entry path must be a non-empty string",
        yaml: "hooks:\n  pre_write:\n    - path: ''\n",
        contains: "non-empty string",
      },
      {
        name: "pre_write entry path missing",
        yaml: "hooks:\n  pre_write:\n    - other: x\n",
        contains: "path",
      },
      {
        name: "pre_write_transform must be a list",
        yaml: "hooks:\n  pre_write_transform: not-a-list\n",
        contains: "'hooks.pre_write_transform' must be a list",
      },
      {
        name: "pre_write_transform entry must be a mapping",
        yaml: "hooks:\n  pre_write_transform:\n    - just-a-string\n",
        contains: "'hooks.pre_write_transform[0]' must be a mapping",
      },
      {
        name: "pre_write_transform entry path must be a non-empty string",
        yaml: "hooks:\n  pre_write_transform:\n    - path: ''\n",
        contains: "non-empty string",
      },
      {
        name: "unrecognised hook surface key",
        yaml: "hooks:\n  post_write:\n    - path: x.mjs\n",
        contains: "not a recognised hook surface",
      },
    ];

    for (const { name, yaml, contains } of cases) {
      it(name, () => {
        writeConfig(yaml);
        const result = loadConfig(dir);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.message).toContain("malformed config");
        expect(result.error.message).toContain(contains);
      });
    }
  });
});
