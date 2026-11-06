// #646: the ignore predicate, the root-file collection rule, and listFiles as
// the single place the config's `ignore` list takes effect.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectionOfPath,
  isIgnoredVaultPath,
  listFiles,
  matchesIgnoreList,
} from "../../src/storage/local.js";
import { clearConfigCache } from "../../src/utils/config.js";

describe("matchesIgnoreList", () => {
  it("matches an exact path at the root only", () => {
    expect(matchesIgnoreList("README.md", ["README.md"])).toBe(true);
    expect(matchesIgnoreList("notes/README.md", ["README.md"])).toBe(false);
    expect(matchesIgnoreList("notes/README.md", ["**/README.md"])).toBe(true);
    expect(matchesIgnoreList("README.md", ["**/README.md"])).toBe(true);
  });

  it("treats a bare directory and a /** glob as the same folder", () => {
    for (const pattern of ["Clippings", "Clippings/**"]) {
      expect(matchesIgnoreList("Clippings/a.md", [pattern])).toBe(true);
      expect(matchesIgnoreList("Clippings/deep/b.md", [pattern])).toBe(true);
      expect(matchesIgnoreList("Clippings-old/a.md", [pattern])).toBe(false);
      expect(matchesIgnoreList("notes/Clippings/a.md", [pattern])).toBe(false);
    }
  });

  it("treats a glob naming a directory as that whole directory", () => {
    expect(matchesIgnoreList("notes/drafts/a.md", ["*/drafts"])).toBe(true);
    expect(matchesIgnoreList("notes/drafts/deep/b.md", ["*/drafts"])).toBe(true);
    expect(matchesIgnoreList("notes/drafts-old/a.md", ["*/drafts"])).toBe(false);
    expect(matchesIgnoreList("drafts/a.md", ["*/drafts"])).toBe(false);
  });

  it("supports wildcards, including over dotted names", () => {
    expect(matchesIgnoreList("drafts/a.tmp.md", ["drafts/*.tmp.md"])).toBe(true);
    expect(matchesIgnoreList("drafts/a.md", ["drafts/*.tmp.md"])).toBe(false);
    expect(matchesIgnoreList("notes/.hidden.md", ["notes/*"])).toBe(true);
  });

  it("is case-sensitive", () => {
    expect(matchesIgnoreList("readme.md", ["README.md"])).toBe(false);
  });

  it("treats a leading # literally, not as a comment", () => {
    expect(matchesIgnoreList("#inbox/a.md", ["#inbox"])).toBe(true);
  });

  it("matches nothing for an empty list", () => {
    expect(matchesIgnoreList("README.md", [])).toBe(false);
  });
});

describe("isIgnoredVaultPath", () => {
  it("keeps the built-in exclusions with or without a list", () => {
    expect(isIgnoredVaultPath(".obsidian/a.md")).toBe(true);
    expect(isIgnoredVaultPath("node_modules/a.md", ["other"])).toBe(true);
    expect(isIgnoredVaultPath("notes/a.md")).toBe(false);
  });

  it("adds the config list", () => {
    expect(isIgnoredVaultPath("Clippings/a.md", ["Clippings/**"])).toBe(true);
    expect(isIgnoredVaultPath("Clippings/a.md")).toBe(false);
  });
});

describe("collectionOfPath", () => {
  it("is the top-level directory", () => {
    expect(collectionOfPath("pricing/a.md")).toBe("pricing");
    expect(collectionOfPath("pricing/deep/a.md")).toBe("pricing");
  });

  it("is empty for a file at the vault root", () => {
    expect(collectionOfPath("README.md")).toBe("");
  });
});

describe("listFiles and the ignore config", () => {
  let vault: string;

  function put(relPath: string, text = "# doc\n"): void {
    const abs = join(vault, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-ignore-list-"));
    put("README.md");
    put("Clippings/a.md");
    put("notes/keep.md");
  });

  afterEach(() => {
    clearConfigCache();
    rmSync(vault, { recursive: true, force: true });
  });

  it("lists everything when no list is configured", async () => {
    const listed = await listFiles(vault);
    expect(listed.ok && listed.value).toEqual(["Clippings/a.md", "README.md", "notes/keep.md"]);
  });

  it("drops configured paths", async () => {
    put(".daftari/config.yaml", "ignore:\n  - README.md\n  - Clippings/**\n");
    const listed = await listFiles(vault);
    expect(listed.ok && listed.value).toEqual(["notes/keep.md"]);
  });

  it("applies the list to a custom pattern too", async () => {
    put(".daftari/config.yaml", "ignore:\n  - Clippings\n");
    const listed = await listFiles(vault, "Clippings/*.md");
    expect(listed.ok && listed.value).toEqual([]);
  });

  it("raw lists what is on disk, built-in exclusions aside", async () => {
    put(".daftari/config.yaml", "ignore:\n  - README.md\n");
    put(".obsidian/app.md");
    const listed = await listFiles(vault, undefined, { raw: true });
    expect(listed.ok && listed.value).toEqual(["Clippings/a.md", "README.md", "notes/keep.md"]);
  });

  it("lists as if nothing were ignored when the config is malformed", async () => {
    put(".daftari/config.yaml", "ignore: not-a-list\n");
    const listed = await listFiles(vault);
    expect(listed.ok && listed.value).toEqual(["Clippings/a.md", "README.md", "notes/keep.md"]);
  });

  it("picks up a config edit without a restart", async () => {
    expect((await listFiles(vault)).ok).toBe(true);
    put(".daftari/config.yaml", "ignore:\n  - README.md\n");
    clearConfigCache();
    const listed = await listFiles(vault);
    expect(listed.ok && listed.value).toEqual(["Clippings/a.md", "notes/keep.md"]);
  });
});
