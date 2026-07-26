import { describe, expect, it } from "vitest";
import { scanVault, scopeOf } from "../../src/schema/scan.js";
import { buildVault, cleanupVault } from "./helpers.js";

describe("scopeOf", () => {
  it("returns the first path component, or '' for a root file", () => {
    expect(scopeOf("notes/a.md")).toBe("notes");
    expect(scopeOf("other/nested/c.md")).toBe("other");
    expect(scopeOf("readme.md")).toBe("");
  });
});

describe("scanVault", () => {
  it("reads raw frontmatter for every markdown doc", async () => {
    const vault = buildVault([
      { path: "notes/a.md", body: "---\ntitle: A\npriority: high\n---\nbody\n" },
      { path: "notes/b.md", body: "---\ntitle: B\npriority: high\n---\nbody\n" },
      { path: "other/c.md", body: "---\ntitle: C\npriority: low\n---\nbody\n" },
    ]);
    try {
      const result = await scanVault(vault);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.docs).toHaveLength(3);
      expect(result.value.skipped).toEqual([]);
      const a = result.value.docs.find((d) => d.relPath === "notes/a.md");
      expect(a?.scope).toBe("notes");
      expect(a?.raw).toEqual({ title: "A", priority: "high" });
    } finally {
      cleanupVault(vault);
    }
  });

  it("restricts the walk to --scope", async () => {
    const vault = buildVault([
      { path: "notes/a.md", body: "---\ntitle: A\n---\nbody\n" },
      { path: "other/c.md", body: "---\ntitle: C\n---\nbody\n" },
    ]);
    try {
      const result = await scanVault(vault, { scope: "notes" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.docs.map((d) => d.relPath)).toEqual(["notes/a.md"]);
    } finally {
      cleanupVault(vault);
    }
  });

  it("skips a doc with malformed YAML frontmatter rather than failing the walk", async () => {
    const vault = buildVault([
      { path: "notes/good.md", body: "---\ntitle: Good\n---\nbody\n" },
      { path: "notes/bad.md", body: "---\ntitle: [unterminated\n---\nbody\n" },
    ]);
    try {
      const result = await scanVault(vault);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.docs.map((d) => d.relPath)).toEqual(["notes/good.md"]);
      expect(result.value.skipped).toHaveLength(1);
      expect(result.value.skipped[0]?.path).toBe("notes/bad.md");
    } finally {
      cleanupVault(vault);
    }
  });
});
