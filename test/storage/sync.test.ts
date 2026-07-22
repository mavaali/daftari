// The sync engine (#6): incremental push against the remote manifest,
// exclusion of rebuildable state, and restore into an empty directory.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StorageBackend } from "../../src/storage/backend.js";
import { createFsBackend } from "../../src/storage/backends/fs.js";
import { MANIFEST_KEY, restoreVault, syncVault } from "../../src/storage/sync.js";

describe("storage sync engine (#6)", () => {
  let vault: string;
  let backing: string;
  let backend: StorageBackend;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-sync-vault-"));
    backing = mkdtempSync(join(tmpdir(), "daftari-sync-backing-"));
    const created = createFsBackend(backing);
    if (!created.ok) throw created.error;
    backend = created.value;

    // A miniature vault: markdown tree, a fake .git dir (sync must include
    // it — git IS the version layer), durable .daftari state, and the
    // rebuildable files that must never sync.
    mkdirSync(join(vault, "notes"), { recursive: true });
    mkdirSync(join(vault, ".git", "refs", "heads"), { recursive: true });
    mkdirSync(join(vault, ".git", "hooks"), { recursive: true });
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(join(vault, "notes", "a.md"), "# a\n");
    writeFileSync(join(vault, "notes", "b.md"), "# b\n");
    writeFileSync(join(vault, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(vault, ".git", "refs", "heads", "main"), "abc123\n");
    // Git executes these — they must never travel through the backing.
    writeFileSync(join(vault, ".git", "config"), '[filter "x"]\n\tclean = evil\n');
    writeFileSync(join(vault, ".git", "hooks", "pre-commit"), "#!/bin/sh\nevil\n");
    writeFileSync(join(vault, ".daftari", "config.yaml"), "version: 1\n");
    writeFileSync(join(vault, ".daftari", "read-log.jsonl"), '{"read":"a"}\n');
    writeFileSync(join(vault, ".daftari", "index.db"), "SQLITE");
    writeFileSync(join(vault, ".daftari", "locks.db-wal"), "WAL");
    writeFileSync(join(vault, ".daftari", "process.lock"), '{"pid":1}');
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(backing, { recursive: true, force: true });
  });

  it("git config and hooks never sync, and a poisoned manifest cannot restore them", async () => {
    expect((await syncVault(vault, backend)).ok).toBe(true);
    const keys = await backend.list("tree/.git/");
    expect(keys.ok).toBe(true);
    if (!keys.ok) return;
    expect(keys.value).not.toContain("tree/.git/config");
    expect(keys.value.some((k) => k.startsWith("tree/.git/hooks/"))).toBe(false);

    // A backing written by an attacker (not this engine) lists .git/config
    // in its manifest — restore must refuse to materialize it.
    await backend.put("tree/.git/config", Buffer.from('[filter "x"]\n\tclean = evil\n'));
    const manifestRaw = await backend.get(MANIFEST_KEY);
    if (!manifestRaw.ok || manifestRaw.value === null) throw new Error("manifest missing");
    const manifest = JSON.parse(manifestRaw.value.toString());
    manifest.files[".git/config"] = "00";
    await backend.put(MANIFEST_KEY, Buffer.from(JSON.stringify(manifest)));

    const target = join(mkdtempSync(join(tmpdir(), "daftari-restore-poison-")), "vault");
    const restored = await restoreVault(target, backend);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.skippedExcluded).toBe(1);
    expect(existsSync(join(target, ".git", "config"))).toBe(false);
    expect(existsSync(join(target, ".git", "HEAD"))).toBe(true);
    rmSync(target, { recursive: true, force: true });
  });

  it("first push uploads the tree + .git + durable state, never the rebuildables", async () => {
    const result = await syncVault(vault, backend);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.uploaded).toBe(6);
    expect(result.value.deleted).toBe(0);

    const keys = await backend.list("tree/");
    expect(keys.ok).toBe(true);
    if (!keys.ok) return;
    expect(keys.value.sort()).toEqual([
      "tree/.daftari/config.yaml",
      "tree/.daftari/read-log.jsonl",
      "tree/.git/HEAD",
      "tree/.git/refs/heads/main",
      "tree/notes/a.md",
      "tree/notes/b.md",
    ]);
    const manifest = await backend.get(MANIFEST_KEY);
    expect(manifest.ok && manifest.value !== null).toBe(true);
  });

  it("second push is incremental: only the changed file re-uploads, removals delete", async () => {
    expect((await syncVault(vault, backend)).ok).toBe(true);

    writeFileSync(join(vault, "notes", "a.md"), "# a v2\n");
    rmSync(join(vault, "notes", "b.md"));

    const second = await syncVault(vault, backend);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.uploaded).toBe(1);
    expect(second.value.deleted).toBe(1);
    expect(second.value.unchanged).toBe(4);

    const gone = await backend.get("tree/notes/b.md");
    if (gone.ok) expect(gone.value).toBeNull();
    const changed = await backend.get("tree/notes/a.md");
    expect(changed.ok && changed.value?.toString()).toBe("# a v2\n");
  });

  it("dry-run reports the diff without touching the backing", async () => {
    const dry = await syncVault(vault, backend, { dryRun: true });
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.value.uploaded).toBe(6);
    const keys = await backend.list("");
    if (keys.ok) expect(keys.value).toEqual([]);
  });

  it("symlinks are skipped and counted, never followed", async () => {
    writeFileSync(join(backing, "outside.txt"), "outside");
    symlinkSync(join(backing, "outside.txt"), join(vault, "notes", "link.md"));
    const result = await syncVault(vault, backend);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skippedSymlinks).toBe(1);
    const linked = await backend.get("tree/notes/link.md");
    if (linked.ok) expect(linked.value).toBeNull();
  });

  it("restore reproduces the pushed tree into an empty directory", async () => {
    expect((await syncVault(vault, backend)).ok).toBe(true);

    const target = join(mkdtempSync(join(tmpdir(), "daftari-restore-")), "vault");
    const restored = await restoreVault(target, backend);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.restored).toBe(6);
    expect(readFileSync(join(target, "notes", "a.md"), "utf-8")).toBe("# a\n");
    expect(readFileSync(join(target, ".git", "HEAD"), "utf-8")).toBe("ref: refs/heads/main\n");
    rmSync(target, { recursive: true, force: true });
  });

  it("restore refuses a non-empty directory and an empty backing", async () => {
    const nonEmpty = await restoreVault(vault, backend);
    expect(nonEmpty.ok).toBe(false);
    if (!nonEmpty.ok) expect(nonEmpty.error.message).toContain("non-empty");

    const target = mkdtempSync(join(tmpdir(), "daftari-restore-empty-"));
    const noManifest = await restoreVault(target, backend);
    expect(noManifest.ok).toBe(false);
    if (!noManifest.ok) expect(noManifest.error.message).toContain("nothing to restore");
    rmSync(target, { recursive: true, force: true });
  });

  it("restore fails loud when an object's bytes do not match the manifest hash", async () => {
    expect((await syncVault(vault, backend)).ok).toBe(true);
    // Corrupt one object in the backing without touching the manifest.
    await backend.put("tree/notes/a.md", Buffer.from("# bitrot\n"));

    const target = join(mkdtempSync(join(tmpdir(), "daftari-restore-corrupt-")), "vault");
    const restored = await restoreVault(target, backend);
    expect(restored.ok).toBe(false);
    if (!restored.ok) expect(restored.error.message).toContain("does not match its manifest hash");
    rmSync(target, { recursive: true, force: true });
  });

  it("a manifest path that escapes the restore root is refused", async () => {
    await backend.put(
      MANIFEST_KEY,
      Buffer.from(JSON.stringify({ version: 1, files: { "../evil.md": "00" } })),
    );
    const target = mkdtempSync(join(tmpdir(), "daftari-restore-escape-"));
    const restored = await restoreVault(join(target, "vault"), backend);
    expect(restored.ok).toBe(false);
    if (!restored.ok) expect(restored.error.message).toContain("escapes restore root");
    rmSync(target, { recursive: true, force: true });
  });
});
