// test/audit/audit.integration.test.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAudit } from "../../src/audit/index.js";

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
    stdio: "ignore",
  });

function backdateCommit(repo: string, isoTime: string): void {
  execFileSync("git", ["commit", "--amend", "--no-edit", `--date=${isoTime}`], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: isoTime,
      GIT_COMMITTER_DATE: isoTime,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
    stdio: "ignore",
  });
}

describe("audit integration", () => {
  let tmp: string;
  let repoA: string;
  let repoB: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "daftari-audit-int-"));
    repoA = join(tmp, "repo-a");
    mkdirSync(repoA);
    repoB = join(tmp, "repo-b");
    mkdirSync(repoB);

    // Stale doc in repo-b: backdated 5 years.
    writeFileSync(join(repoB, "api.md"), `# API\n\n## Run\n\nLegacy notes.\n`);
    git(repoB, ["init", "-q"]);
    git(repoB, ["add", "."]);
    git(repoB, ["commit", "-q", "-m", "init"]);
    backdateCommit(repoB, "2020-01-01T00:00:00Z");

    // Repo-a docs: one URL ref into b (OK), one anchor miss, one missing file.
    writeFileSync(
      join(repoA, "intro.md"),
      `# Intro\n\nsee [api](https://github.com/org/service-b/blob/main/api.md#run)\n`,
    );
    writeFileSync(
      join(repoA, "bad-anchor.md"),
      `# Bad\n\nsee [api](https://github.com/org/service-b/blob/main/api.md#missing)\n`,
    );
    writeFileSync(join(repoA, "bad-file.md"), `# Bad\n\nsee [gone](./gone.md)\n`);
    writeFileSync(
      join(repoA, "links-to-stale.md"),
      `# Fresh\n\nsee [api](https://github.com/org/service-b/blob/main/api.md)\n`,
    );
    git(repoA, ["init", "-q"]);
    git(repoA, ["add", "."]);
    git(repoA, ["commit", "-q", "-m", "init"]);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs end-to-end with the expected findings and exit code", async () => {
    const yamlPath = join(tmp, "audit.yaml");
    writeFileSync(
      yamlPath,
      `
repos:
  - name: a
    path: ${repoA}
  - name: b
    path: ${repoB}
    urls:
      - github.com/org/service-b
output:
  markdown: ${join(tmp, "report.md")}
  json: ${join(tmp, "report.json")}
staleness:
  threshold_days: 540
fail_on:
  broken_refs: 1
  transitive_staleness: 1
`,
    );
    const code = await runAudit(["--config", yamlPath]);
    expect(code).toBe(1); // findings present

    const report = JSON.parse(readFileSync(join(tmp, "report.json"), "utf-8"));
    // Both anchor-miss and missing-file should show.
    expect(report.totals.brokenRefs).toBeGreaterThanOrEqual(2);
    expect(report.brokenRefs.some((r: { kind: string }) => r.kind === "missing_anchor")).toBe(true);
    expect(report.brokenRefs.some((r: { kind: string }) => r.kind === "missing_file")).toBe(true);
    // The cross-repo URL into the stale api.md triggers transitive staleness on links-to-stale.md.
    expect(report.totals.transitivelyStale).toBeGreaterThanOrEqual(1);
    expect(report.totals.directlyStale).toBeGreaterThanOrEqual(1);
  });

  it("resolves describes bindings against a code repo and flags broken ones (#119)", async () => {
    const repoC = join(tmp, "svc");
    mkdirSync(repoC);
    mkdirSync(join(repoC, "src"));
    writeFileSync(join(repoC, "src", "login.ts"), `export function login() {}\n`);

    // A docs-repo doc that describes one real and one missing code file.
    writeFileSync(
      join(repoA, "auth-doc.md"),
      `---\ntitle: Auth\ndescribes:\n  - svc:src/login.ts\n  - svc:src/gone.ts::validateCredentials\n---\n# Auth\n`,
    );
    git(repoA, ["add", "."]);
    git(repoA, ["commit", "-q", "-m", "add auth-doc"]);

    const yamlPath = join(tmp, "audit-desc.yaml");
    writeFileSync(
      yamlPath,
      `
repos:
  - name: a
    path: ${repoA}
  - name: svc
    path: ${repoC}
    type: code
output:
  json: ${join(tmp, "report-desc.json")}
staleness:
  threshold_days: 540
fail_on:
  broken_refs: 1000
  transitive_staleness: 1000
  broken_describes: 1
`,
    );
    const code = await runAudit(["--config", yamlPath]);
    const report = JSON.parse(readFileSync(join(tmp, "report-desc.json"), "utf-8"));

    expect(report.totals.brokenDescribes).toBe(1);
    expect(report.describesRefs).toHaveLength(1);
    expect(report.describesRefs[0]).toMatchObject({
      source: { repo: "a", path: "auth-doc.md" },
      target: { repo: "svc", path: "src/gone.ts", symbol: "validateCredentials" },
    });
    // broken_describes threshold of 1 is hit → non-zero exit.
    expect(code).toBe(1);
  });

  it("returns 2 on a config error", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const code = await runAudit(["--repo", "/no/such/path"]);
    expect(code).toBe(2);
    stderr.mockRestore();
  });

  it("detects cross-repo relative-path escape and does not flag valid targets", async () => {
    // repo-a/cross-rel.md links to ../repo-b/api.md — escapes repo-a root,
    // resolves into repo-b/api.md (which exists in beforeEach setup).
    writeFileSync(join(repoA, "cross-rel.md"), `# Cross\n\nsee [api](../repo-b/api.md)\n`);
    git(repoA, ["add", "."]);
    git(repoA, ["commit", "-q", "-m", "add cross-rel"]);

    const yamlPath = join(tmp, "audit.yaml");
    writeFileSync(
      yamlPath,
      `
repos:
  - name: a
    path: ${repoA}
  - name: b
    path: ${repoB}
    urls:
      - github.com/org/service-b
output:
  json: ${join(tmp, "report-rel.json")}
staleness:
  threshold_days: 540
fail_on:
  broken_refs: 1
  transitive_staleness: 1
`,
    );
    await runAudit(["--config", yamlPath]);
    const report = JSON.parse(readFileSync(join(tmp, "report-rel.json"), "utf-8"));
    // The cross-repo escape edge from cross-rel.md to repo-b/api.md should
    // NOT appear in brokenRefs (api.md exists).
    const crossRelFindings = report.brokenRefs.filter(
      (r: { source: { path: string } }) => r.source.path === "cross-rel.md",
    );
    expect(crossRelFindings).toEqual([]);
  });
});
