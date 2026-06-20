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
    expect(result.value).toBe(resolve(VAULT, "pricing/helios-consumption-pricing.md"));
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
