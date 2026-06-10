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

  describe("code repos (#118)", () => {
    it("indexes a code repo by path, including non-markdown files", async () => {
      const repo = join(tmp, "svc");
      mkdirSync(repo);
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "src", "login.ts"), `export function login() {}\n`);
      writeFileSync(join(repo, "data.json"), `{"k":1}\n`);
      writeFileSync(join(repo, "README.md"), `# Service\n## Setup\n`);

      const result = await collectRepos({
        repos: [{ name: "svc", path: repo, docsGlob: "**/*", urls: [], type: "code" }],
        output: {},
        staleness: { thresholdDays: 540 },
        failOn: { brokenRefs: 1, transitiveStaleness: 100 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const docs = result.value[0]?.docs;
      expect(new Set(docs?.keys())).toEqual(new Set(["src/login.ts", "data.json", "README.md"]));
    });

    it("captures describes frontmatter on a docs-repo doc (#119)", async () => {
      const repo = join(tmp, "d");
      mkdirSync(repo);
      writeFileSync(
        join(repo, "a.md"),
        `---\ntitle: A\ndescribes:\n  - svc:src/login.ts\n  - svc:src/login.ts::validateCredentials\n---\n# A\n`,
      );
      writeFileSync(join(repo, "b.md"), `---\ntitle: B\n---\n# B\n`);

      const result = await collectRepos({
        repos: [{ name: "d", path: repo, docsGlob: "**/*.md", urls: [], type: "docs" }],
        output: {},
        staleness: { thresholdDays: 540 },
        failOn: { brokenRefs: 1, transitiveStaleness: 100 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.docs.get("a.md")?.describes).toEqual([
        "svc:src/login.ts",
        "svc:src/login.ts::validateCredentials",
      ]);
      // absent describes defaults to []
      expect(result.value[0]?.docs.get("b.md")?.describes).toEqual([]);
    });

    it("does not parse frontmatter, headings, or links in a code repo", async () => {
      const repo = join(tmp, "svc");
      mkdirSync(repo);
      // A markdown file that WOULD yield headings/links if parsed as a doc.
      writeFileSync(join(repo, "README.md"), `---\ntitle: X\n---\n# Heading\nsee [a](a.md)\n`);

      const result = await collectRepos({
        repos: [{ name: "svc", path: repo, docsGlob: "**/*", urls: [], type: "code" }],
        output: {},
        staleness: { thresholdDays: 540 },
        failOn: { brokenRefs: 1, transitiveStaleness: 100 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const stub = result.value[0]?.docs.get("README.md");
      expect(stub?.headings).toEqual(new Set());
      expect(stub?.links).toEqual([]);
    });
  });
});
