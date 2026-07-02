import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { directoryExists, listFiles, readFile, resolveVaultPath } from "../../src/storage/local.js";

const VAULT = resolve("test/fixtures/sample-vault");

describe("listFiles", () => {
  it("lists all markdown files in the vault, excluding .daftari", async () => {
    const result = await listFiles(VAULT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(10);
    expect(result.value.every((p) => p.endsWith(".md"))).toBe(true);
    expect(result.value.some((p) => p.includes(".daftari"))).toBe(false);
  });

  it("returns vault-relative POSIX paths, sorted", async () => {
    const result = await listFiles(VAULT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain("competitive-intel/aurora-pipelines-vs-helios-connect.md");
    const sorted = [...result.value].sort();
    expect(result.value).toEqual(sorted);
  });

  it("respects a custom glob pattern", async () => {
    const result = await listFiles(VAULT, "pricing/*.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(4);
  });
});

describe("readFile", () => {
  it("reads an existing file", async () => {
    const target = resolve(VAULT, "competitive-intel/aurora-pipelines-vs-helios-connect.md");
    const result = await readFile(target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain("Aurora Pipelines vs Helios Connect");
  });

  it("returns an error for a missing file", async () => {
    const result = await readFile(resolve(VAULT, "does-not-exist.md"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("cannot read file");
  });
});

describe("resolveVaultPath", () => {
  it("resolves a normal vault-relative path", () => {
    const result = resolveVaultPath(VAULT, "pricing/helios-consumption-pricing.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.absPath).toBe(resolve(VAULT, "pricing/helios-consumption-pricing.md"));
    expect(result.value.relPath).toBe("pricing/helios-consumption-pricing.md");
  });

  it("rejects path traversal outside the vault root", () => {
    const result = resolveVaultPath(VAULT, "../../../etc/passwd");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("escapes vault root");
  });

  it("rejects a path that resolves to the vault root itself", () => {
    const result = resolveVaultPath(VAULT, ".");
    expect(result.ok).toBe(false);
  });
});

// The lock key, provenance, and commit path are all derived from the resolved
// relPath. Two spellings of the same file must collapse to one canonical
// relPath, or they take out DISTINCT write locks and the optimistic-concurrency
// guard is defeated (#127/#128 closed the identity checks but left the lock key
// keyed on the raw caller string — this is the other half of that fix).
describe("resolveVaultPath canonical relPath (lock-key aliasing, #127/#128)", () => {
  it("collapses aliased spellings of one path to a single canonical relPath", () => {
    const spellings = [
      "pricing/helios-consumption-pricing.md",
      "./pricing/helios-consumption-pricing.md",
      "pricing//helios-consumption-pricing.md",
      "pricing/./helios-consumption-pricing.md",
    ];
    for (const spelling of spellings) {
      const result = resolveVaultPath(VAULT, spelling);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.relPath).toBe("pricing/helios-consumption-pricing.md");
    }
  });

  it("keeps genuinely distinct files on distinct relPaths", () => {
    const a = resolveVaultPath(VAULT, "pricing/one.md");
    const b = resolveVaultPath(VAULT, "pricing/two.md");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.relPath).toBe("pricing/one.md");
    expect(b.value.relPath).toBe("pricing/two.md");
    expect(a.value.relPath).not.toBe(b.value.relPath);
  });
});

describe("resolveVaultPath symlink confinement", () => {
  let vault: string;
  let outside: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-vault-"));
    outside = mkdtempSync(join(tmpdir(), "daftari-outside-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects a file symlink inside the vault that points outside it", () => {
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "SECRET");
    symlinkSync(secret, join(vault, "leak.md"));

    const result = resolveVaultPath(vault, "leak.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("escapes vault root");
  });

  it("rejects a not-yet-existing target under a directory symlinked outside the vault", () => {
    // A write to a new file beneath a symlinked directory must be refused even
    // though the target file does not exist yet.
    symlinkSync(outside, join(vault, "linkdir"));

    const result = resolveVaultPath(vault, "linkdir/newfile.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("escapes vault root");
  });

  it("allows a symlink that resolves to a target inside the vault", () => {
    mkdirSync(join(vault, "notes"));
    const real = join(vault, "notes", "real.md");
    writeFileSync(real, "# Real");
    symlinkSync(real, join(vault, "alias.md"));

    const result = resolveVaultPath(vault, "alias.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The canonical relPath resolves THROUGH the symlink to the real file, so a
    // write via `alias.md` and a write via `notes/real.md` take the same lock.
    expect(result.value.relPath).toBe(join("notes", "real.md"));
  });
});

describe("directoryExists", () => {
  it("is true for the vault directory", async () => {
    expect(await directoryExists(VAULT)).toBe(true);
  });

  it("is false for a missing directory", async () => {
    expect(await directoryExists(resolve(VAULT, "nope"))).toBe(false);
  });
});
