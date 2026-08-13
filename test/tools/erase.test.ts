// test/tools/erase.test.ts
//
// vault_erase — the path/source-keyed history scrub (U14 / R11-R13).
//
// The git-filter-repo happy paths are exercised with an INJECTED runFilterRepo
// (the binary is not a test dependency); the refuse-path is tested with the
// availability probe forced false. A real end-to-end canary — erase a synthetic
// marker, then confirm it is absent from worktree AND history — is gated on
// git-filter-repo actually being installed, so it runs where the tool exists
// and skips cleanly where it does not.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { vaultErase } from "../../src/tools/erase.js";
import { resolveGitDir } from "../../src/utils/git-erase.js";

const MARKER = "SUPER_SECRET_MARKER_XYZZY";

function git(vault: string, args: string[]): void {
  execFileSync("git", ["-C", vault, ...args], { stdio: "pipe" });
}

function initRepo(vault: string, file: string, body: string, gitDir?: string): void {
  mkdirSync(join(vault, dirname(file)), { recursive: true });
  writeFileSync(join(vault, file), body);
  git(vault, gitDir ? ["init", "--quiet", `--separate-git-dir=${gitDir}`] : ["init", "--quiet"]);
  git(vault, ["config", "user.email", "t@example.com"]);
  git(vault, ["config", "user.name", "Tester"]);
  git(vault, ["add", "."]);
  git(vault, ["commit", "--quiet", "-m", "init"]);
}

function filterRepoInstalled(): boolean {
  try {
    execFileSync("git", ["filter-repo", "--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const eraser: AccessContext = {
  user: "admin",
  roleName: "admin",
  role: { read: ["*"], write: ["*"], promote: true, ratify: true, erase: true },
};
const nonEraser: AccessContext = {
  user: "writer",
  roleName: "writer",
  role: { read: ["*"], write: ["*"], promote: false, ratify: false },
};

describe("vault_erase — guardrails", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-erase-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("denies a role without the erase capability", async () => {
    const r = await vaultErase(vault, { path: "notes/x.md", confirm: "notes/x.md" }, nonEraser);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/access denied/);
  });

  it("aborts when confirm does not echo the target exactly", async () => {
    const r = await vaultErase(vault, { path: "notes/x.md", confirm: "notes/y.md" }, eraser);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/aborted/);
  });

  it("requires exactly one of path or source_ref", async () => {
    const both = await vaultErase(
      vault,
      { path: "a.md", source_ref: "distill:s#c", confirm: "a.md" },
      eraser,
    );
    expect(both.ok).toBe(false);
    const neither = await vaultErase(vault, { confirm: "" }, eraser);
    expect(neither.ok).toBe(false);
  });
});

describe("vault_erase — history scrub", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-erase-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("refuses the history op and leaves the worktree untouched when filter-repo is absent", async () => {
    const file = "notes/leak.md";
    initRepo(vault, file, MARKER);
    const r = await vaultErase(vault, { path: file, confirm: file }, eraser, {
      filterRepoAvailable: async () => false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.incomplete).toContain("git-history: filter-repo not installed");
    // Worktree untouched — nothing was silently removed.
    expect(existsSync(join(vault, file))).toBe(true);
    // The refusal is still an auditable event.
    const receipt = readFileSync(join(vault, ".daftari/erasures.jsonl"), "utf8");
    expect(receipt).toMatch(/filter-repo not installed/);
  });

  it("dispatches the rewrite and writes a receipt when filter-repo is available (stubbed)", async () => {
    const file = "notes/leak.md";
    initRepo(vault, file, MARKER);
    const r = await vaultErase(vault, { path: file, confirm: file }, eraser, {
      filterRepoAvailable: async () => true,
      // Stand in for filter-repo: drop the file from the worktree, report success.
      runFilterRepo: async (v, _gitDir, paths) => {
        for (const p of paths) rmSync(join(v, p), { force: true });
        return { ok: true, value: undefined };
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.erased).toEqual([file]);
    expect(r.value.incomplete).toEqual([]); // no remote configured
    expect(existsSync(join(vault, file))).toBe(false);
    const receipt = readFileSync(join(vault, ".daftari/erasures.jsonl"), "utf8");
    expect(receipt).toMatch(/"kind":"erasure"/);
    expect(receipt).toContain(file);
  });

  it("names a configured remote in incomplete[] (remote-side gc is not self-serve)", async () => {
    const file = "notes/leak.md";
    initRepo(vault, file, MARKER);
    git(vault, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
    const r = await vaultErase(vault, { path: file, confirm: file }, eraser, {
      filterRepoAvailable: async () => true,
      runFilterRepo: async () => ({ ok: true, value: undefined }),
      runForcePush: async () => ({ ok: true, value: undefined }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.incomplete.some((s) => s.includes("origin"))).toBe(true);
  });

  it("resolves the git_dir of a --separate-git-dir vault", async () => {
    const gitDir = mkdtempSync(join(tmpdir(), "daftari-erase-gd-"));
    const file = "notes/leak.md";
    initRepo(vault, file, MARKER, gitDir);
    const resolved = await resolveGitDir(vault);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toContain(gitDir);
    // And the full scrub still runs (stubbed) against that resolved store.
    const r = await vaultErase(vault, { path: file, confirm: file }, eraser, {
      filterRepoAvailable: async () => true,
      runFilterRepo: async () => ({ ok: true, value: undefined }),
    });
    expect(r.ok).toBe(true);
    rmSync(gitDir, { recursive: true, force: true });
  });

  it("returns rotate-first guidance for a secret-shaped target", async () => {
    const file = "config/api-key.md";
    initRepo(vault, file, MARKER);
    const r = await vaultErase(vault, { path: file, confirm: file }, eraser, {
      filterRepoAvailable: async () => true,
      runFilterRepo: async () => ({ ok: true, value: undefined }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.guidance).toMatch(/rotate/i);
  });
});

// Real end-to-end canary — only where git-filter-repo is actually installed.
describe.skipIf(!filterRepoInstalled())("vault_erase — canary (filter-repo installed)", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-erase-canary-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("erases the marker from worktree AND history", async () => {
    const file = "notes/leak.md";
    initRepo(vault, file, MARKER);
    // A second commit so the marker lives in history, not just the tip.
    writeFileSync(join(vault, "other.md"), "unrelated");
    git(vault, ["add", "."]);
    git(vault, ["commit", "--quiet", "-m", "second"]);

    const r = await vaultErase(vault, { path: file, confirm: file }, eraser);
    expect(r.ok).toBe(true);
    expect(existsSync(join(vault, file))).toBe(false);
    // The marker is absent from the entire rewritten history.
    const log = execFileSync("git", ["-C", vault, "log", "-p", "--all"], { encoding: "utf8" });
    expect(log).not.toContain(MARKER);
  });
});
