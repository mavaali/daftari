// test/audit/collect.test.ts
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectRepos } from "../../src/audit/collect.js";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

describe("collectRepos", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "daftari-audit-coll-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("globs markdown, extracts slugged headings, and populates link refs", async () => {
    const repo = join(tmp, "r");
    mkdirSync(repo);
    writeFileSync(
      join(repo, "a.md"),
      `---\ntitle: A\n---\n# Top\n## A Section!\nsee [b](b.md#top)\n`,
    );
    writeFileSync(join(repo, "b.md"), `# Top\n\nbody`);
    git(repo, ["init", "-q"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "init"]);

    const result = await collectRepos({
      repos: [{ name: "r", path: repo, docsGlob: "**/*.md", urls: [] }],
      output: {},
      staleness: { thresholdDays: 540 },
      failOn: { brokenRefs: 1, transitiveStaleness: 100 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const snapshots = result.value;

    expect(snapshots).toHaveLength(1);
    const docA = snapshots[0]?.docs.get("a.md");
    expect(docA?.headings).toEqual(new Set(["top", "a-section"]));
    expect(docA?.links[0]?.href).toBe("b.md");
    expect(docA?.mtimeSource).toBe("git");
  });

  it("falls back to fs mtime when git is unavailable for the repo", async () => {
    const repo = join(tmp, "r");
    mkdirSync(repo);
    writeFileSync(join(repo, "a.md"), `# H\n`);
    // No git init.
    const result = await collectRepos({
      repos: [{ name: "r", path: repo, docsGlob: "**/*.md", urls: [] }],
      output: {},
      staleness: { thresholdDays: 540 },
      failOn: { brokenRefs: 1, transitiveStaleness: 100 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.docs.get("a.md")?.mtimeSource).toBe("fs");
  });

  it("warns and skips an unreadable file but continues the repo", async () => {
    const repo = join(tmp, "r");
    mkdirSync(repo);
    writeFileSync(join(repo, "good.md"), `# Good\n`);
    // Create an unreadable file (chmod 000). Skip on Windows/runners that
    // don't honor chmod (vitest will mark expected failure).
    const badPath = join(repo, "bad.md");
    writeFileSync(badPath, `# Bad\n`);
    chmodSync(badPath, 0o000);

    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const result = await collectRepos({
        repos: [{ name: "r", path: repo, docsGlob: "**/*.md", urls: [] }],
        output: {},
        staleness: { thresholdDays: 540 },
        failOn: { brokenRefs: 1, transitiveStaleness: 100 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const docs = result.value[0]?.docs;
      expect(docs?.has("good.md")).toBe(true);
      expect(docs?.has("bad.md")).toBe(false);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("unreadable doc bad.md"));
    } finally {
      chmodSync(badPath, 0o644); // so afterEach can clean it up
      stderr.mockRestore();
    }
  });

  it("skips files outside the docs glob", async () => {
    const repo = join(tmp, "r");
    mkdirSync(repo);
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "README.md"), `# r\n`);
    writeFileSync(join(repo, "docs", "x.md"), `# x\n`);

    const result = await collectRepos({
      repos: [{ name: "r", path: repo, docsGlob: "docs/**/*.md", urls: [] }],
      output: {},
      staleness: { thresholdDays: 540 },
      failOn: { brokenRefs: 1, transitiveStaleness: 100 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...(result.value[0]?.docs.keys() ?? [])]).toEqual(["docs/x.md"]);
  });
});
