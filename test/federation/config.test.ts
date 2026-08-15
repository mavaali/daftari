// Shape validation of the `federation` config block (#297, spec Decision 1).
// Filesystem-dependent checks (realpath, nesting, collisions) are mount-load
// concerns tested in mounts.test.ts; this file covers what config load alone
// can decide, under the loud-failure contract every block shares.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearConfigCache, loadConfig } from "../../src/utils/config.js";

let root: string;

function writeConfig(yaml: string): void {
  mkdirSync(join(root, ".daftari"), { recursive: true });
  writeFileSync(join(root, ".daftari", "config.yaml"), yaml);
  clearConfigCache();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "daftari-fedcfg-"));
});

afterEach(() => {
  clearConfigCache();
  rmSync(root, { recursive: true, force: true });
});

describe("federation config block", () => {
  it("parses a full block with defaults applied", () => {
    writeConfig(`
federation:
  mounts:
    - alias: research
      path: ../research-vault
    - alias: ops
      path: /abs/ops
      index: lexical
      optional: true
  principals:
    "human:mihir": { role: researcher }
`);
    const config = loadConfig(root);
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    expect(config.value.federation?.mounts).toEqual([
      { alias: "research", path: "../research-vault", index: "full", optional: false },
      { alias: "ops", path: "/abs/ops", index: "lexical", optional: true },
    ]);
    expect(config.value.federation?.principals["human:mihir"]).toEqual({ role: "researcher" });
  });

  it("is undefined when the block is absent", () => {
    writeConfig("roles: {}\n");
    const config = loadConfig(root);
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    expect(config.value.federation).toBeUndefined();
  });

  it.each([
    ["r", "must match"], // single char — drive-letter ambiguity
    ["Research", "must match"], // uppercase
    ["has space", "must match"],
    ["local", "reserved alias"],
  ])("refuses alias %j", (alias, message) => {
    writeConfig(`
federation:
  mounts:
    - alias: "${alias}"
      path: ../x
`);
    const config = loadConfig(root);
    expect(config.ok).toBe(false);
    if (config.ok) return;
    expect(config.error.message).toContain(message);
  });

  it("refuses a duplicate alias", () => {
    writeConfig(`
federation:
  mounts:
    - alias: research
      path: ../a
    - alias: research
      path: ../b
`);
    const config = loadConfig(root);
    expect(config.ok).toBe(false);
    if (config.ok) return;
    expect(config.error.message).toContain('declares alias "research" twice');
  });

  it("refuses an unknown index mode and an unknown mount key", () => {
    writeConfig(`
federation:
  mounts:
    - alias: research
      path: ../a
      index: vectors
`);
    const badIndex = loadConfig(root);
    expect(badIndex.ok).toBe(false);
    if (!badIndex.ok) expect(badIndex.error.message).toContain("index");

    writeConfig(`
federation:
  mounts:
    - alias: research
      path: ../a
      watch: true
`);
    const badKey = loadConfig(root);
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) expect(badKey.error.message).toContain("not a recognised");
  });

  it("refuses malformed principals entries", () => {
    writeConfig(`
federation:
  principals:
    "human:mihir": { role: "" }
`);
    const config = loadConfig(root);
    expect(config.ok).toBe(false);
    if (config.ok) return;
    expect(config.error.message).toContain("federation.principals");
  });
});
