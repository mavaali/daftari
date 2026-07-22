// The shared storage walker (#6): recursion, symlink accounting, and the
// shapes the backends and sync engine rely on.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkFiles } from "../../src/storage/fs-walk.js";

describe("walkFiles (#6)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "daftari-walk-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("walks nested directories and returns only regular files", async () => {
    mkdirSync(join(root, "a", "b", "c"), { recursive: true });
    mkdirSync(join(root, "empty"), { recursive: true });
    writeFileSync(join(root, "top.md"), "t");
    writeFileSync(join(root, "a", "mid.md"), "m");
    writeFileSync(join(root, "a", "b", "c", "deep.md"), "d");

    const walked = await walkFiles(root);
    expect(walked.symlinks).toBe(0);
    expect(walked.files.map((f) => f.slice(root.length + 1)).sort()).toEqual([
      "a/b/c/deep.md",
      "a/mid.md",
      "top.md",
    ]);
  });

  it("counts symlinks (file and directory targets) without following them", async () => {
    mkdirSync(join(root, "real"), { recursive: true });
    writeFileSync(join(root, "real", "f.md"), "f");
    writeFileSync(join(root, "plain.md"), "p");
    symlinkSync(join(root, "plain.md"), join(root, "file-link"));
    symlinkSync(join(root, "real"), join(root, "dir-link"));
    symlinkSync(join(root, "missing"), join(root, "dangling-link"));

    const walked = await walkFiles(root);
    expect(walked.symlinks).toBe(3);
    // Nothing behind the directory symlink is walked twice, and the
    // dangling link is neither a file nor an error.
    expect(walked.files.map((f) => f.slice(root.length + 1)).sort()).toEqual([
      "plain.md",
      "real/f.md",
    ]);
  });

  it("an empty root yields no files", async () => {
    const walked = await walkFiles(root);
    expect(walked.files).toEqual([]);
    expect(walked.symlinks).toBe(0);
  });
});
