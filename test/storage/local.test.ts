import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  directoryExists,
  listFiles,
  readFile,
  resolveVaultPath,
} from "../../src/storage/local.js";

const VAULT = resolve("test/fixtures/sample-vault");

describe("listFiles", () => {
  it("lists all markdown files in the vault, excluding .daftari", async () => {
    const result = await listFiles(VAULT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(7);
    expect(result.value.every((p) => p.endsWith(".md"))).toBe(true);
    expect(result.value.some((p) => p.includes(".daftari"))).toBe(false);
  });

  it("returns vault-relative POSIX paths, sorted", async () => {
    const result = await listFiles(VAULT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain(
      "competitive-intel/databricks-lakeflow-vs-data-factory.md",
    );
    const sorted = [...result.value].sort();
    expect(result.value).toEqual(sorted);
  });

  it("respects a custom glob pattern", async () => {
    const result = await listFiles(VAULT, "pricing/*.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
  });
});

describe("readFile", () => {
  it("reads an existing file", async () => {
    const target = resolve(
      VAULT,
      "competitive-intel/databricks-lakeflow-vs-data-factory.md",
    );
    const result = await readFile(target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain("Databricks Lakeflow vs Data Factory");
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
    const result = resolveVaultPath(VAULT, "pricing/databricks-consumption-pricing.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(
      resolve(VAULT, "pricing/databricks-consumption-pricing.md"),
    );
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

describe("directoryExists", () => {
  it("is true for the vault directory", async () => {
    expect(await directoryExists(VAULT)).toBe(true);
  });

  it("is false for a missing directory", async () => {
    expect(await directoryExists(resolve(VAULT, "nope"))).toBe(false);
  });
});
