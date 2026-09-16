import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanVaultFrontmatter } from "../../src/schema/scan.js";

describe("scanVaultFrontmatter", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeVault(): string {
    const vault = mkdtempSync(join(tmpdir(), "daftari-schema-scan-"));
    roots.push(vault);
    mkdirSync(join(vault, "notes", "nested"), { recursive: true });
    mkdirSync(join(vault, "other"), { recursive: true });
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(join(vault, "notes", "a.md"), "---\nteam: platform\n---\n# A\n");
    writeFileSync(join(vault, "notes", "nested", "b.md"), "# No frontmatter\n");
    writeFileSync(join(vault, "notes", "bad.md"), "---\nteam: [broken\n---\n");
    writeFileSync(join(vault, "other", "c.md"), "---\nteam: data\n---\n# C\n");
    writeFileSync(join(vault, ".daftari", "hidden.md"), "---\nsecret: true\n---\n");
    return vault;
  }

  it("scans only markdown under the requested folder and reports malformed YAML", async () => {
    const result = await scanVaultFrontmatter(makeVault(), "notes");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filesScanned).toBe(3);
    expect(result.value.documents).toEqual([
      { path: "notes/a.md", frontmatter: { team: "platform" } },
      { path: "notes/nested/b.md", frontmatter: {} },
    ]);
    expect(result.value.issues).toHaveLength(1);
    expect(result.value.issues[0]).toMatchObject({ path: "notes/bad.md" });
    expect(result.value.issues[0]?.message).toContain("malformed YAML frontmatter");
  });

  it("rejects a scope that can escape the vault", async () => {
    const result = await scanVaultFrontmatter(makeVault(), "../outside");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("scope escapes vault root");
  });

  it("fails loud for a missing vault or an explicitly missing scope", async () => {
    const missingVault = join(tmpdir(), `daftari-schema-missing-${process.pid}-${Date.now()}`);

    const vaultResult = await scanVaultFrontmatter(missingVault);
    expect(vaultResult.ok).toBe(false);
    if (!vaultResult.ok)
      expect(vaultResult.error.message).toContain("vault root is not a directory");

    const scopeResult = await scanVaultFrontmatter(makeVault(), "mistyped");
    expect(scopeResult.ok).toBe(false);
    if (!scopeResult.ok) expect(scopeResult.error.message).toContain("scope is not a directory");
  });

  it("preserves a successful empty report for an existing empty directory", async () => {
    const vault = makeVault();
    mkdirSync(join(vault, "empty"));

    const result = await scanVaultFrontmatter(vault, "empty");

    expect(result).toEqual({
      ok: true,
      value: { filesScanned: 0, documents: [], issues: [] },
    });
  });

  it("records an unreadable or unconfined document and continues the advisory scan", async () => {
    const vault = makeVault();
    const outside = join(mkdtempSync(join(tmpdir(), "daftari-schema-outside-")), "outside.md");
    roots.push(join(outside, ".."));
    writeFileSync(outside, "---\nsecret: true\n---\n");
    symlinkSync(outside, join(vault, "notes", "escaped.md"));

    const result = await scanVaultFrontmatter(vault, "notes");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.documents.map((document) => document.path)).not.toContain(
      "notes/escaped.md",
    );
    expect(result.value.issues).toContainEqual({
      path: "notes/escaped.md",
      message: "path escapes vault root: notes/escaped.md",
    });
  });

  it("does not follow a scoped symlink to a document elsewhere in the vault", async () => {
    const vault = makeVault();
    symlinkSync(join(vault, "other", "c.md"), join(vault, "notes", "other.md"));

    const result = await scanVaultFrontmatter(vault, "notes");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.documents.map((document) => document.path)).not.toContain("other/c.md");
    expect(result.value.issues).toContainEqual({
      path: "notes/other.md",
      message: "path escapes schema scope: notes/other.md",
    });
  });

  it("counts one canonical document when two scoped paths resolve to the same file", async () => {
    const vault = makeVault();
    symlinkSync("a.md", join(vault, "notes", "alias.md"));

    const result = await scanVaultFrontmatter(vault, "notes");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.documents.filter((document) => document.path === "notes/a.md"),
    ).toHaveLength(1);
    expect(result.value.issues).toContainEqual({
      path: "notes/alias.md",
      message: "duplicate canonical document skipped: notes/a.md",
    });
  });
});
