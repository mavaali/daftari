// test/audit/pin-cli.test.ts
// `daftari audit --pin` / `--pin --apply` end to end, plus the missing-pin
// auto-tension dedupe and moved-first semantic ordering (2026-07-26 spec,
// Decisions 3 and 5).

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAudit } from "../../src/audit/index.js";
import { listTensions } from "../../src/curation/tension.js";
import type { LlmClient } from "../../src/eval/llm.js";
import { ok } from "../../src/frontmatter/types.js";
import { writeLockfile } from "../../src/lifecycle/lock.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "ignore" });
}

function hashOf(repo: string, relPath: string): string {
  return execFileSync("git", ["-C", repo, "hash-object", relPath], { env: GIT_ENV })
    .toString()
    .trim();
}

function docFrontmatter(describes: string[]): string {
  return `---
title: "Retry logic"
domain: accumulation
collection: engineering
status: canonical
confidence: high
created: "2026-01-05"
updated: "2026-01-05"
updated_by: agent:test
provenance: direct
tags: []
describes:
${describes.map((d) => `  - "${d}"`).join("\n")}
---

The retry loop.
`;
}

// Names the code repo "svc" in the AUDIT's own registry, matching what
// code_repos and the describes prefix both use — the aligned case. (A
// misaligned case, where --code-repo gets an anonymous code-N name instead,
// is exactly what the "registry mismatch" / "unpinnable" tests exercise.)
function writeAuditYaml(tmp: string, docsRepo: string, codeRepo: string): string {
  const path = join(tmp, "audit.yaml");
  writeFileSync(
    path,
    `repos:\n  - name: docs\n    path: ${docsRepo}\n  - name: svc\n    path: ${codeRepo}\n    type: code\n`,
  );
  return path;
}

const stubLlm = (parsed: unknown): LlmClient =>
  ({
    completeJson: vi.fn(async () =>
      ok({ text: "", input_tokens: 1, output_tokens: 1, stop_reason: "end_turn", parsed }),
    ),
  }) as unknown as LlmClient;

describe("daftari audit --pin", () => {
  let tmp: string;
  let docsRepo: string;
  let codeRepo: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "daftari-audit-pin-")));
    docsRepo = join(tmp, "docs");
    codeRepo = realpathSync(mkdtempSync(join(tmpdir(), "daftari-audit-pin-code-")));

    mkdirSync(join(docsRepo, "engineering"), { recursive: true });
    mkdirSync(join(docsRepo, ".daftari"), { recursive: true });
    writeFileSync(join(docsRepo, ".daftari", "config.yaml"), `code_repos:\n  svc: ${codeRepo}\n`);

    git(codeRepo, ["init", "-q"]);
    writeFileSync(join(codeRepo, "retry.ts"), "export function retry() {}\n");
    git(codeRepo, ["add", "."]);
    git(codeRepo, ["commit", "-q", "-m", "init"]);

    git(docsRepo, ["init", "-q"]);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(codeRepo, { recursive: true, force: true });
  });

  it("plan mode prints proposals and writes nothing", async () => {
    writeFileSync(join(docsRepo, "engineering/retry.md"), docFrontmatter(["svc:retry.ts"]));
    const before = readFileSync(join(docsRepo, "engineering/retry.md"), "utf-8");

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await runAudit(["--repo", docsRepo, "--code-repo", codeRepo, "--pin"]);
    stdout.mockRestore();

    expect(code).toBe(0);
    const after = readFileSync(join(docsRepo, "engineering/retry.md"), "utf-8");
    expect(after).toBe(before); // nothing written
  });

  it("plan mode's printed output names the proposed pin", async () => {
    writeFileSync(join(docsRepo, "engineering/retry.md"), docFrontmatter(["svc:retry.ts"]));
    let printed = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      printed += String(chunk);
      return true;
    });
    await runAudit(["--repo", docsRepo, "--code-repo", codeRepo, "--pin"]);
    stdout.mockRestore();

    const sha = hashOf(codeRepo, "retry.ts").slice(0, 12);
    expect(printed).toContain("engineering/retry.md");
    expect(printed).toContain(`svc:retry.ts -> svc:retry.ts@${sha}`);
    expect(printed).toContain("proposed: 1");
  });

  it("skips a dirty working-tree file with the dirty-skip message", async () => {
    writeFileSync(join(docsRepo, "engineering/retry.md"), docFrontmatter(["svc:retry.ts"]));
    // Dirty the code repo's working tree without committing.
    writeFileSync(join(codeRepo, "retry.ts"), "export function retry(n) { return n; }\n");

    let printed = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      printed += String(chunk);
      return true;
    });
    const code = await runAudit(["--repo", docsRepo, "--code-repo", codeRepo, "--pin"]);
    stdout.mockRestore();

    expect(code).toBe(0);
    expect(printed).toContain("skipped: working tree differs from HEAD");
    expect(printed).toContain("proposed: 0");
  });

  it("--pin --apply writes a whole-file 12-char pin, commits once, is idempotent, and the pin classifies intact", async () => {
    writeFileSync(join(docsRepo, "engineering/retry.md"), docFrontmatter(["svc:retry.ts"]));
    const yamlPath = writeAuditYaml(tmp, docsRepo, codeRepo);

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await runAudit(["--config", yamlPath, "--pin", "--apply"]);
    stdout.mockRestore();
    expect(code).toBe(0);

    const written = readFileSync(join(docsRepo, "engineering/retry.md"), "utf-8");
    const sha = hashOf(codeRepo, "retry.ts");
    expect(written).toContain(`svc:retry.ts@${sha.slice(0, 12)}`);
    expect(written).not.toContain('"svc:retry.ts"'); // old unpinned entry replaced

    const log = execFileSync("git", ["-C", docsRepo, "log", "--oneline"], {
      env: GIT_ENV,
    }).toString();
    expect(log.trim().split("\n")).toHaveLength(1); // one commit

    // Re-running --apply against the now-pinned doc is a no-op: nothing left
    // to propose, so nothing to write, and no second commit.
    const stdout2 = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runAudit(["--config", yamlPath, "--pin", "--apply"]);
    stdout2.mockRestore();
    const log2 = execFileSync("git", ["-C", docsRepo, "log", "--oneline"], {
      env: GIT_ENV,
    }).toString();
    expect(log2.trim().split("\n")).toHaveLength(1); // still one commit

    // The applied pin, read back via the audit's own pin classifier (against
    // a registry that names the code repo the same as code_repos does), is
    // intact-on-arrival by construction.
    let output = "";
    const stdout3 = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      output += String(chunk);
      return true;
    });
    await runAudit(["--config", yamlPath]);
    stdout3.mockRestore();
    expect(output).toContain("code pins intact / moved / missing: **1 / 0 / 0**");
  });

  it("--pin --apply refuses with two docs repos", async () => {
    const docsRepo2 = join(tmp, "docs2");
    mkdirSync(docsRepo2, { recursive: true });
    git(docsRepo2, ["init", "-q"]);
    writeFileSync(join(docsRepo, "engineering/retry.md"), docFrontmatter(["svc:retry.ts"]));

    const code = await runAudit([
      "--repo",
      docsRepo,
      "--repo",
      docsRepo2,
      "--code-repo",
      codeRepo,
      "--pin",
    ]);
    expect(code).toBe(2);
  });

  it("--pin --apply refuses against a live process.lock holder, naming its pid and mode", async () => {
    writeFileSync(join(docsRepo, "engineering/retry.md"), docFrontmatter(["svc:retry.ts"]));

    // A real, live child process whose OWN argv contains the vault path —
    // isDaftariProcess matches on that substring via `ps`, so a synthetic
    // pid (or this test's own pid, whose argv is vitest's own command line)
    // would not exercise the real liveness check.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", docsRepo], {
      stdio: "ignore",
    });
    await new Promise((resolve) => setTimeout(resolve, 250)); // let it actually start
    try {
      writeLockfile(docsRepo, {
        daftari: true,
        pid: child.pid as number,
        vaultRoot: docsRepo,
        startedAt: new Date().toISOString(),
        version: "test",
        mode: "serve",
      });

      const before = readFileSync(join(docsRepo, "engineering/retry.md"), "utf-8");
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const code = await runAudit([
        "--repo",
        docsRepo,
        "--code-repo",
        codeRepo,
        "--pin",
        "--apply",
      ]);
      const messages = stderr.mock.calls.map((c) => String(c[0])).join("");
      stderr.mockRestore();
      stdout.mockRestore();

      expect(code).toBe(2);
      expect(messages).toContain(String(child.pid));
      expect(messages).toContain("serve");
      const after = readFileSync(join(docsRepo, "engineering/retry.md"), "utf-8");
      expect(after).toBe(before); // refused before any write
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("lists a prefix as unpinnable when it's only in the audit's --code-repo registry, not code_repos", async () => {
    // A SECOND anonymous code repo the audit knows about (code-0/code-1) but
    // the docs vault's own code_repos does not declare.
    const otherCode = realpathSync(mkdtempSync(join(tmpdir(), "daftari-audit-pin-other-")));
    try {
      git(otherCode, ["init", "-q"]);
      writeFileSync(join(otherCode, "x.ts"), "export const x = 1;\n");
      git(otherCode, ["add", "."]);
      git(otherCode, ["commit", "-q", "-m", "init"]);

      writeFileSync(join(docsRepo, "engineering/other.md"), docFrontmatter(["code-1:x.ts"]));

      let printed = "";
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        printed += String(chunk);
        return true;
      });
      await runAudit([
        "--repo",
        docsRepo,
        "--code-repo",
        codeRepo,
        "--code-repo",
        otherCode,
        "--pin",
      ]);
      stdout.mockRestore();
      expect(printed).toContain("unpinnable");
      expect(printed).toContain("code-1");
    } finally {
      rmSync(otherCode, { recursive: true, force: true });
    }
  });
});

describe("daftari audit — registry cross-check (C2)", () => {
  let tmp: string;
  let docsRepo: string;
  let codeRepo: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "daftari-audit-registry-")));
    docsRepo = join(tmp, "docs");
    codeRepo = realpathSync(mkdtempSync(join(tmpdir(), "daftari-audit-registry-code-")));
    mkdirSync(join(docsRepo, "engineering"), { recursive: true });
    git(codeRepo, ["init", "-q"]);
    writeFileSync(join(codeRepo, "retry.ts"), "export function retry() {}\n");
    git(codeRepo, ["add", "."]);
    git(codeRepo, ["commit", "-q", "-m", "init"]);
    git(docsRepo, ["init", "-q"]);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(codeRepo, { recursive: true, force: true });
  });

  it("warns when a pinned repo name is in the audit registry but not code_repos", async () => {
    // No .daftari/config.yaml written for docsRepo -> code_repos is empty.
    writeFileSync(
      join(docsRepo, "engineering/retry.md"),
      docFrontmatter([`svc:retry.ts@${hashOf(codeRepo, "retry.ts")}`]),
    );
    const yamlPath = writeAuditYaml(tmp, docsRepo, codeRepo);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runAudit(["--config", yamlPath]);
    const calls = stderr.mock.calls.map((c) => String(c[0]));
    stderr.mockRestore();
    stdout.mockRestore();
    expect(calls.some((c) => c.includes("registry mismatch") && c.includes("svc"))).toBe(true);
  });

  it("warns when a pinned repo name is in code_repos but not the audit registry", async () => {
    mkdirSync(join(docsRepo, ".daftari"), { recursive: true });
    writeFileSync(join(docsRepo, ".daftari", "config.yaml"), `code_repos:\n  svc: ${codeRepo}\n`);
    writeFileSync(
      join(docsRepo, "engineering/retry.md"),
      docFrontmatter([`svc:retry.ts@${hashOf(codeRepo, "retry.ts")}`]),
    );
    // Audit registry names the SAME repo "code-0" (anonymous), not "svc".
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runAudit(["--repo", docsRepo, "--code-repo", codeRepo]);
    const calls = stderr.mock.calls.map((c) => String(c[0]));
    stderr.mockRestore();
    stdout.mockRestore();
    expect(calls.some((c) => c.includes("registry mismatch") && c.includes("svc"))).toBe(true);
  });

  it("warns when both registries know the name but resolve it to different paths", async () => {
    const otherCode = realpathSync(mkdtempSync(join(tmpdir(), "daftari-audit-registry-other-")));
    try {
      git(otherCode, ["init", "-q"]);
      writeFileSync(join(otherCode, "retry.ts"), "export function retry() { /* different */ }\n");
      git(otherCode, ["add", "."]);
      git(otherCode, ["commit", "-q", "-m", "init"]);

      mkdirSync(join(docsRepo, ".daftari"), { recursive: true });
      // code_repos points 'svc' at otherCode; the audit.yaml below points
      // its own 'svc' entry at codeRepo — same name, different real paths.
      writeFileSync(
        join(docsRepo, ".daftari", "config.yaml"),
        `code_repos:\n  svc: ${otherCode}\n`,
      );
      writeFileSync(
        join(docsRepo, "engineering/retry.md"),
        docFrontmatter([`svc:retry.ts@${hashOf(codeRepo, "retry.ts")}`]),
      );
      const yamlPath = writeAuditYaml(tmp, docsRepo, codeRepo);

      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await runAudit(["--config", yamlPath]);
      const calls = stderr.mock.calls.map((c) => String(c[0]));
      stderr.mockRestore();
      stdout.mockRestore();
      expect(
        calls.some((c) => c.includes("registry mismatch") && c.includes("different paths")),
      ).toBe(true);
    } finally {
      rmSync(otherCode, { recursive: true, force: true });
    }
  });
});

describe("daftari audit — missing-pin auto-tension (Decision 3, deduplicated)", () => {
  let tmp: string;
  let docsRepo: string;
  let codeRepo: string;
  let yamlPath: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "daftari-audit-autotension-")));
    docsRepo = join(tmp, "docs");
    codeRepo = realpathSync(mkdtempSync(join(tmpdir(), "daftari-audit-autotension-code-")));
    mkdirSync(join(docsRepo, "engineering"), { recursive: true });
    git(codeRepo, ["init", "-q"]);
    writeFileSync(join(codeRepo, "retry.ts"), "export function retry() {}\n");
    git(codeRepo, ["add", "."]);
    git(codeRepo, ["commit", "-q", "-m", "init"]);
    git(docsRepo, ["init", "-q"]);
    mkdirSync(join(docsRepo, ".daftari"), { recursive: true });
    writeFileSync(join(docsRepo, ".daftari", "config.yaml"), `code_repos:\n  svc: ${codeRepo}\n`);
    yamlPath = writeAuditYaml(tmp, docsRepo, codeRepo);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(codeRepo, { recursive: true, force: true });
  });

  it("logs a missing-pin tension without an LLM, and dedupes on a second run", async () => {
    writeFileSync(join(docsRepo, "engineering/retry.md"), docFrontmatter(["svc:gone.ts@0000000"]));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runAudit(["--config", yamlPath, "--auto-tension"]);
    await runAudit(["--config", yamlPath, "--auto-tension"]);
    stdout.mockRestore();

    const tensions = await listTensions(docsRepo);
    expect(tensions.ok).toBe(true);
    if (!tensions.ok) return;
    const missing = tensions.value.filter((t) => t.title.startsWith("Doc-code missing:"));
    expect(missing).toHaveLength(1); // deduped, not doubled on the second run
  });

  it("never auto-logs a bare 'moved' pin as a tension", async () => {
    writeFileSync(join(docsRepo, "engineering/retry.md"), docFrontmatter(["svc:retry.ts@0000000"]));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runAudit(["--config", yamlPath, "--auto-tension"]);
    stdout.mockRestore();

    const tensions = await listTensions(docsRepo);
    expect(tensions.ok && tensions.value.length).toBe(0);
  });

  it("--auto-tension without --semantic still warns when there are zero pinned bindings", async () => {
    writeFileSync(join(docsRepo, "engineering/plain.md"), docFrontmatter([]));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runAudit(["--config", yamlPath, "--auto-tension"]);
    stdout.mockRestore();
    const calls = stderr.mock.calls.map((c) => String(c[0]));
    stderr.mockRestore();
    expect(calls.some((c) => c.includes("has no effect without --semantic"))).toBe(true);
  });

  it("--auto-tension without --semantic does NOT warn when pinned bindings exist (missing-pin logging is useful work)", async () => {
    writeFileSync(join(docsRepo, "engineering/retry.md"), docFrontmatter(["svc:gone.ts@0000000"]));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runAudit(["--config", yamlPath, "--auto-tension"]);
    stdout.mockRestore();
    const calls = stderr.mock.calls.map((c) => String(c[0]));
    stderr.mockRestore();
    expect(calls.some((c) => c.includes("has no effect without --semantic"))).toBe(false);
  });
});

describe("daftari audit — moved-first semantic ordering (Decision 3)", () => {
  let tmp: string;
  let docsRepo: string;
  let codeRepo: string;
  let yamlPath: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "daftari-audit-order-")));
    docsRepo = join(tmp, "docs");
    codeRepo = realpathSync(mkdtempSync(join(tmpdir(), "daftari-audit-order-code-")));
    mkdirSync(join(docsRepo, "engineering"), { recursive: true });
    git(codeRepo, ["init", "-q"]);
    writeFileSync(join(codeRepo, "fresh.ts"), "export const fresh = 1;\n");
    writeFileSync(join(codeRepo, "stale.ts"), "export const stale = 1;\n");
    git(codeRepo, ["add", "."]);
    git(codeRepo, ["commit", "-q", "-m", "init"]);
    git(docsRepo, ["init", "-q"]);
    mkdirSync(join(docsRepo, ".daftari"), { recursive: true });
    writeFileSync(join(docsRepo, ".daftari", "config.yaml"), `code_repos:\n  svc: ${codeRepo}\n`);
    yamlPath = writeAuditYaml(tmp, docsRepo, codeRepo);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(codeRepo, { recursive: true, force: true });
  });

  it("classifies the moved-pin binding first under a --max-semantic cap of 1", async () => {
    const freshSha = hashOf(codeRepo, "fresh.ts");
    // fresh.md's pin is intact; stale.md's pin is moved. fresh.md sorts
    // alphabetically first, so WITHOUT reordering the semantic pass (capped
    // at 1) would pick fresh.md; WITH moved-first reordering it picks
    // stale.md instead.
    writeFileSync(
      join(docsRepo, "engineering/fresh.md"),
      docFrontmatter([`svc:fresh.ts@${freshSha}`]),
    );
    writeFileSync(join(docsRepo, "engineering/stale.md"), docFrontmatter(["svc:stale.ts@0000000"]));

    const llm = stubLlm({ verdict: "coherent", contradictions: [] });
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      output += String(chunk);
      return true;
    });
    await runAudit(["--config", yamlPath, "--semantic", "--max-semantic", "1"], { llm });
    stdout.mockRestore();

    expect(llm.completeJson).toHaveBeenCalledTimes(1);
    const call = (llm.completeJson as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      user: string;
    };
    expect(call.user).toContain("stale.md");
    expect(output).toContain("stale.md");
  });
});
