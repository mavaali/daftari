import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StorageBackend } from "../../../src/storage/backend.js";
import { createFsBackend } from "../../../src/storage/backends/fs.js";

// Finding F5 (mavaali-beads-3p4.5): the fs backend confined keys lexically
// only, so a symlinked component beneath the root let get/put/delete follow
// the link outside the declared root. Confinement must be realpath-based.

describe("fs backend symlink confinement (F5)", () => {
  let root: string;
  let outside: string;
  let backend: StorageBackend;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "daftari-fs-root-"));
    outside = mkdtempSync(join(tmpdir(), "daftari-fs-outside-"));
    const created = createFsBackend(root);
    if (!created.ok) throw created.error;
    backend = created.value;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses put through a symlinked component that escapes the root", async () => {
    symlinkSync(outside, join(root, "tree")); // root/tree → outside
    const res = await backend.put("tree/escaped.md", Buffer.from("no"));
    expect(res.ok).toBe(false);
    expect(existsSync(join(outside, "escaped.md"))).toBe(false);
  });

  it("refuses get through a symlinked component that escapes the root", async () => {
    writeFileSync(join(outside, "secret.md"), "sekrit", "utf-8");
    symlinkSync(outside, join(root, "tree"));
    const got = await backend.get("tree/secret.md");
    expect(got.ok).toBe(false);
  });

  it("refuses delete through a symlinked component and leaves the target intact", async () => {
    writeFileSync(join(outside, "secret.md"), "sekrit", "utf-8");
    symlinkSync(outside, join(root, "tree"));
    const del = await backend.delete("tree/secret.md");
    expect(del.ok).toBe(false);
    expect(existsSync(join(outside, "secret.md"))).toBe(true);
  });

  it("refuses a backend whose configured prefix is a symlink escaping the path", async () => {
    symlinkSync(outside, join(root, "escaping-prefix"));
    const created = createFsBackend(root, "escaping-prefix");
    // Either construction fails, or every subsequent write is refused — both
    // are acceptable; the invariant is that nothing lands outside `root`.
    if (created.ok) {
      const res = await created.value.put("x.md", Buffer.from("no"));
      expect(res.ok).toBe(false);
    } else {
      expect(created.ok).toBe(false);
    }
    expect(existsSync(join(outside, "x.md"))).toBe(false);
  });

  it("still allows a symlink that stays inside the root", async () => {
    mkdirSync(join(root, "realdir"));
    symlinkSync(join(root, "realdir"), join(root, "alias")); // root/alias → root/realdir
    const res = await backend.put("alias/ok.md", Buffer.from("yes"));
    expect(res.ok).toBe(true);
  });
});
