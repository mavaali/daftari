import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig } from "../../src/utils/config.js";

// Finding E2: loadConfig is on the write hot path (7 call sites in write.ts),
// re-reading + re-parsing + re-validating .daftari/config.yaml under the write
// lock on every call. loadConfig must cache its parsed+validated result keyed
// by (resolved config path, file mtime), re-reading only when the file's mtime
// changes or the file appears/disappears.
//
// The cache is observed behaviourally: rewriting the file's *content* while
// pinning its mtime must serve the cached (stale) parse — proving the file was
// NOT re-read/re-parsed. Bumping the mtime must bust the cache.
describe("loadConfig — mtime-keyed cache (finding E2)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-config-cache-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string, mtimeMs: number): void {
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(configPath(dir), yaml);
    const t = new Date(mtimeMs);
    utimesSync(configPath(dir), t, t);
  }

  it("serves the cached parse when content changes but mtime is unchanged", () => {
    writeConfig("version: 1\nroles:\n  admin:\n    read: ['*']\n", 1_000_000_000_000);
    const first = loadConfig(dir);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(Object.keys(first.value.roles)).toEqual(["admin"]);

    // Rewrite content but keep mtime identical — a re-read would pick up the
    // new role; the cache must NOT.
    writeConfig(
      "version: 1\nroles:\n  admin:\n    read: ['*']\n  guest:\n    read: []\n",
      1_000_000_000_000,
    );

    for (let i = 0; i < 5; i++) {
      const r = loadConfig(dir);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Still only 'admin' — proving the file was not re-read/re-parsed.
      expect(Object.keys(r.value.roles)).toEqual(["admin"]);
    }
  });

  it("re-reads after the file's mtime changes (config edit between writes)", () => {
    writeConfig("version: 1\nroles:\n  admin:\n    read: ['*']\n", 1_000_000_000_000);
    const before = loadConfig(dir);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(Object.keys(before.value.roles)).toEqual(["admin"]);

    // Edit the config AND advance its mtime — the cache must not serve stale.
    writeConfig(
      "version: 1\nroles:\n  admin:\n    read: ['*']\n  guest:\n    read: []\n",
      2_000_000_000_000,
    );

    const after = loadConfig(dir);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(Object.keys(after.value.roles).sort()).toEqual(["admin", "guest"]);
  });

  it("busts the cache when the file disappears, then reappears", () => {
    writeConfig("version: 1\nroles:\n  admin:\n    read: ['*']\n", 1_000_000_000_000);
    const present = loadConfig(dir);
    expect(present.ok).toBe(true);
    if (!present.ok) return;
    expect(Object.keys(present.value.roles)).toEqual(["admin"]);

    // File disappears — must now yield the empty config, not the cached one.
    rmSync(configPath(dir));
    const absent = loadConfig(dir);
    expect(absent.ok).toBe(true);
    if (!absent.ok) return;
    expect(absent.value.roles).toEqual({});

    // File reappears with new content — must be picked up.
    writeConfig("version: 1\nroles:\n  editor:\n    read: ['*']\n", 3_000_000_000_000);
    const reappeared = loadConfig(dir);
    expect(reappeared.ok).toBe(true);
    if (!reappeared.ok) return;
    expect(Object.keys(reappeared.value.roles)).toEqual(["editor"]);
  });

  it("keeps separate cache entries per vault root", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "daftari-config-cache-b-"));
    try {
      mkdirSync(join(dir, ".daftari"), { recursive: true });
      writeFileSync(configPath(dir), "version: 1\nroles:\n  admin:\n    read: ['*']\n");
      mkdirSync(join(dir2, ".daftari"), { recursive: true });
      writeFileSync(configPath(dir2), "version: 1\nroles:\n  editor:\n    read: ['*']\n");

      const a = loadConfig(dir);
      const b = loadConfig(dir2);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(Object.keys(a.value.roles)).toEqual(["admin"]);
      expect(Object.keys(b.value.roles)).toEqual(["editor"]);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
