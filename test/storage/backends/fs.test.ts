// The fs backend is the reference implementation of the backend contract
// (#6): these tests pin the semantics the sync engine relies on — null on
// missing get, idempotent delete, prefix list, key confinement.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StorageBackend } from "../../../src/storage/backend.js";
import { createFsBackend } from "../../../src/storage/backends/fs.js";

describe("fs storage backend (#6)", () => {
  let root: string;
  let backend: StorageBackend;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "daftari-backend-"));
    const created = createFsBackend(root);
    if (!created.ok) throw created.error;
    backend = created.value;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips put/get, including nested keys and overwrites", async () => {
    expect((await backend.put("tree/a/b.md", Buffer.from("one"))).ok).toBe(true);
    const first = await backend.get("tree/a/b.md");
    expect(first.ok && first.value?.toString()).toBe("one");

    expect((await backend.put("tree/a/b.md", Buffer.from("two"))).ok).toBe(true);
    const second = await backend.get("tree/a/b.md");
    expect(second.ok && second.value?.toString()).toBe("two");
  });

  it("get of a missing key is ok(null), not an error", async () => {
    const got = await backend.get("tree/nope.md");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toBeNull();
  });

  it("list returns keys under a prefix; delete is idempotent", async () => {
    await backend.put("tree/x.md", Buffer.from("x"));
    await backend.put("tree/sub/y.md", Buffer.from("y"));
    await backend.put("meta/manifest.json", Buffer.from("{}"));

    const tree = await backend.list("tree/");
    expect(tree.ok).toBe(true);
    if (tree.ok) expect(tree.value.sort()).toEqual(["tree/sub/y.md", "tree/x.md"]);

    expect((await backend.delete("tree/x.md")).ok).toBe(true);
    expect((await backend.delete("tree/x.md")).ok).toBe(true); // second delete: still ok
    const after = await backend.list("tree/");
    if (after.ok) expect(after.value).toEqual(["tree/sub/y.md"]);
  });

  it("refuses keys that escape the backend root", async () => {
    const escapePut = await backend.put("../evil.md", Buffer.from("no"));
    expect(escapePut.ok).toBe(false);
    const escapeGet = await backend.get("../../etc/passwd");
    expect(escapeGet.ok).toBe(false);
  });
});
