import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveVaultSourceRef, verifyRepoSourceRef } from "../../src/curation/source-refs.js";
import { parseSourceRef } from "../../src/frontmatter/source-ref.js";

describe("parseSourceRef", () => {
  it.each([
    ["vault:canon/fact.md", "vault", "canon/fact.md"],
    ["repo:docs/evidence.md", "repo", "docs/evidence.md"],
    ["https://example.com/a", "external", undefined],
    ["mailto:owner@example.com", "external", undefined],
    ["distill:source-1#claim-2", "distill", undefined],
    ["doi:10.1000/182", "opaque", undefined],
    ["interview/session-7", "legacy", "interview/session-7"],
  ])("classifies %s as %s", (raw, kind, target) => {
    const parsed = parseSourceRef(raw);
    expect(parsed.kind).toBe(kind);
    if (target !== undefined) expect("target" in parsed ? parsed.target : undefined).toBe(target);
  });
});

describe("resolveVaultSourceRef", () => {
  const byPath = new Set(["canon/fact.md", "other/fact.md"]);
  const byBasename = new Map<string, string | null>([["fact", null]]);

  it("resolves explicit vault addresses from the vault root", () => {
    expect(
      resolveVaultSourceRef("vault:canon/fact", "readers/note.md", byPath, byBasename),
    ).toEqual({ kind: "vault", explicit: true, target: "canon/fact.md" });
  });

  it("rejects traversal and never basename-falls back for explicit vault addresses", () => {
    expect(
      resolveVaultSourceRef("vault:../fact.md", "readers/note.md", byPath, byBasename),
    ).toEqual({ kind: "vault", explicit: true, target: null });
    expect(
      resolveVaultSourceRef("vault:gone/fact.md", "readers/note.md", byPath, byBasename),
    ).toEqual({ kind: "vault", explicit: true, target: null });
  });

  it("keeps legacy resolution for existing in-vault references only", () => {
    expect(
      resolveVaultSourceRef("../canon/fact.md", "readers/note.md", byPath, byBasename),
    ).toEqual({ kind: "vault", explicit: false, target: "canon/fact.md" });
    expect(
      resolveVaultSourceRef("opaque/slash-shaped-citation", "readers/note.md", byPath, byBasename),
    ).toEqual({ kind: "non-vault" });
  });
});

describe("verifyRepoSourceRef", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("checks metadata without returning file contents", () => {
    const root = mkdtempSync(join(tmpdir(), "daftari-source-ref-"));
    dirs.push(root);
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "evidence.md"), "TOP SECRET CONTENT");
    expect(verifyRepoSourceRef(root, "docs/evidence.md")).toEqual({ status: "exists" });
    expect(verifyRepoSourceRef(root, "docs/missing.md")).toEqual({ status: "missing" });
  });

  it("rejects absolute paths, traversal, and symlink escapes", () => {
    const parent = mkdtempSync(join(tmpdir(), "daftari-source-ref-"));
    dirs.push(parent);
    const root = join(parent, "repo");
    const outside = join(parent, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "evidence.md"), "outside");
    symlinkSync(outside, join(root, "escape"));

    expect(verifyRepoSourceRef(root, "/etc/passwd").status).toBe("invalid");
    expect(verifyRepoSourceRef(root, "../outside/evidence.md").status).toBe("invalid");
    expect(verifyRepoSourceRef(root, "escape/evidence.md").status).toBe("outside_root");
  });
});
