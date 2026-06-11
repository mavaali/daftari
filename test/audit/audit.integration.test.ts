// test/audit/audit.integration.test.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAudit } from "../../src/audit/index.js";
import { listTensions } from "../../src/curation/tension.js";
import type { LlmClient } from "../../src/eval/llm.js";
import { ok } from "../../src/frontmatter/types.js";

// An LlmClient whose completeJson always returns the given verdict object.
const stubLlm = (parsed: unknown): LlmClient =>
  ({
    completeJson: vi.fn(async () =>
      ok({ text: "", input_tokens: 1, output_tokens: 1, stop_reason: "end_turn", parsed }),
    ),
  }) as unknown as LlmClient;

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

  it("runs the semantic drift check and logs a tension with --auto-tension (#120)", async () => {
    const repoC = join(tmp, "svc");
    mkdirSync(repoC);
    mkdirSync(join(repoC, "src"));
    writeFileSync(join(repoC, "src", "login.ts"), `export function login(token: string) {}\n`);

    writeFileSync(
      join(repoA, "auth-doc.md"),
      `---\ntitle: Auth\ndescribes:\n  - svc:src/login.ts\n---\n# Auth\n\nCalls validateCredentials(email, password).\n`,
    );
    git(repoA, ["add", "."]);
    git(repoA, ["commit", "-q", "-m", "add auth-doc"]);

    const yamlPath = join(tmp, "audit-sem.yaml");
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
  json: ${join(tmp, "report-sem.json")}
fail_on:
  broken_refs: 1000
  transitive_staleness: 1000
  broken_describes: 1000
`,
    );

    const llm = stubLlm({
      verdict: "drifted",
      contradictions: ["doc says validateCredentials(email, password); code takes a token"],
    });
    const code = await runAudit(["--config", yamlPath, "--semantic", "--auto-tension"], { llm });

    const report = JSON.parse(readFileSync(join(tmp, "report-sem.json"), "utf-8"));
    expect(report.totals.semanticDrifted).toBe(1);
    expect(report.semantic).toHaveLength(1);
    expect(report.semantic[0]).toMatchObject({
      source: { repo: "a", path: "auth-doc.md" },
      target: { repo: "svc", path: "src/login.ts" },
      verdict: "drifted",
    });
    expect(llm.completeJson).toHaveBeenCalledTimes(1);

    // --auto-tension logged a factual tension into repo-a's vault.
    const tensions = await listTensions(repoA);
    expect(tensions.ok).toBe(true);
    if (!tensions.ok) return;
    expect(tensions.value).toHaveLength(1);
    expect(tensions.value[0]?.sourceA).toBe("auth-doc.md");

    // Semantic is advisory: drift alone does not fail the build.
    expect(code).toBe(0);
  });

  it("warns instead of silently no-op'ing when --auto-tension is passed without --semantic", async () => {
    const writes: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const yamlPath = join(tmp, "audit-at.yaml");
    writeFileSync(yamlPath, `repos:\n  - name: a\n    path: ${repoA}\n`);
    try {
      await runAudit(["--config", yamlPath, "--auto-tension"]);
      expect(writes.join("")).toContain("--auto-tension has no effect without --semantic");
    } finally {
      stderr.mockRestore();
    }
  });

  it("returns config error (exit 2) for --auto-tension without a single docs vault", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // Two docs repos → ambiguous vault root for tension logging.
    const yamlPath = join(tmp, "audit-amb.yaml");
    writeFileSync(
      yamlPath,
      `repos:\n  - name: a\n    path: ${repoA}\n  - name: b\n    path: ${repoB}\n`,
    );
    const llm = stubLlm({ verdict: "coherent", contradictions: [] });
    const code = await runAudit(["--config", yamlPath, "--semantic", "--auto-tension"], { llm });
    expect(code).toBe(2);
    stderr.mockRestore();
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
