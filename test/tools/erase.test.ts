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
import { vaultErase, vaultErasePlan } from "../../src/tools/erase.js";
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

function markdown(path: string, sources: string[] = [], body = "Body."): string {
  return [
    "---",
    `title: "${path}"`,
    "domain: accumulation",
    `collection: ${path.split("/")[0] ?? "docs"}`,
    "status: canonical",
    "confidence: high",
    "created: 2026-01-01",
    "updated: 2026-01-01",
    "updated_by: agent:test",
    "provenance: direct",
    `sources: [${sources.map((source) => `"${source}"`).join(", ")}]`,
    "superseded_by: null",
    "ttl_days: null",
    "tags: []",
    "---",
    "",
    body,
  ].join("\n");
}

function addCommittedFile(vault: string, path: string, body: string): void {
  mkdirSync(join(vault, dirname(path)), { recursive: true });
  writeFileSync(join(vault, path), body);
  git(vault, ["add", "--", path]);
  git(vault, ["commit", "--quiet", "-m", `add ${path}`]);
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
const scopedEraser: AccessContext = {
  user: "scoped-admin",
  roleName: "scoped-admin",
  role: { read: ["notes", "analysis"], write: ["*"], promote: true, ratify: true, erase: true },
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

  it("fails closed when no access context is supplied", async () => {
    const r = await vaultErase(vault, { path: "notes/x.md", confirm: "notes/x.md" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/fail-closed|authenticated access/);
  });

  it("aborts on a confirm mismatch WITHOUT echoing the target token", async () => {
    const r = await vaultErase(vault, { path: "notes/x.md", confirm: "notes/y.md" }, eraser);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/did not match/);
    // The expected value must not be handed back — an agent caller must not be
    // able to copy it verbatim on retry.
    expect(r.error.message).not.toContain("notes/x.md");
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
    expect(r.value.refused).toBe(true);
    // A refused erase is NOT a success: erased is empty, not the target paths.
    expect(r.value.erased).toEqual([]);
    expect(r.value.incomplete).toContain("git-history: filter-repo not installed");
    // Worktree untouched — nothing was silently removed.
    expect(existsSync(join(vault, file))).toBe(true);
    // The refusal is an auditable event, recorded as a refusal (not an erasure).
    const receipt = readFileSync(join(vault, ".daftari/erasures.jsonl"), "utf8");
    expect(receipt).toMatch(/"kind":"erasure_refused"/);
  });

  it("errors (does not report success) when the path was never in git history", async () => {
    initRepo(vault, "notes/leak.md", MARKER);
    // A typo for the real path: never committed, so nothing to scrub.
    const typo = "notes/leek.md";
    const r = await vaultErase(vault, { path: typo, confirm: typo }, eraser, {
      filterRepoAvailable: async () => true,
      runFilterRepo: async () => ({ ok: true, value: undefined }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/not present in git history/);
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

  it("refuses to dispatch a nonzero downstream blast without a plan acknowledgment", async () => {
    const target = "notes/target.md";
    initRepo(vault, target, markdown(target));
    addCommittedFile(vault, "analysis/dependent.md", markdown("analysis/dependent.md", [target]));
    let rewriteCalled = false;

    const r = await vaultErase(vault, { path: target, confirm: target }, eraser, {
      filterRepoAvailable: async () => true,
      runFilterRepo: async () => {
        rewriteCalled = true;
        return { ok: true, value: undefined };
      },
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/downstream dependents|plan_hash/);
    expect(rewriteCalled).toBe(false);
  });

  it("rejects an arbitrary plan hash before dispatch", async () => {
    const target = "notes/target.md";
    initRepo(vault, target, markdown(target));
    addCommittedFile(vault, "analysis/dependent.md", markdown("analysis/dependent.md", [target]));
    let rewriteCalled = false;

    const r = await vaultErase(
      vault,
      { path: target, confirm: target, plan_hash: "0".repeat(64) },
      eraser,
      {
        filterRepoAvailable: async () => true,
        runFilterRepo: async () => {
          rewriteCalled = true;
          return { ok: true, value: undefined };
        },
      },
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/plan_hash.*current erase plan|stale/i);
    expect(rewriteCalled).toBe(false);
  });

  it("dispatches a nonzero downstream blast with the exact current plan hash", async () => {
    const target = "notes/target.md";
    initRepo(vault, target, markdown(target));
    addCommittedFile(vault, "analysis/dependent.md", markdown("analysis/dependent.md", [target]));
    const plan = await vaultErasePlan(vault, { path: target }, eraser);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    let rewriteCalled = false;

    const r = await vaultErase(
      vault,
      { path: target, confirm: target, plan_hash: plan.value.plan_hash },
      eraser,
      {
        filterRepoAvailable: async () => true,
        runFilterRepo: async () => {
          rewriteCalled = true;
          return { ok: true, value: undefined };
        },
      },
    );

    expect(r.ok).toBe(true);
    expect(rewriteCalled).toBe(true);
  });

  it("rejects graph drift that lands during the pre-rewrite phase", async () => {
    const target = "notes/target.md";
    initRepo(vault, target, markdown(target));
    addCommittedFile(vault, "analysis/dependent.md", markdown("analysis/dependent.md", [target]));
    const plan = await vaultErasePlan(vault, { path: target }, eraser);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    let rewriteCalled = false;

    const r = await vaultErase(
      vault,
      { path: target, confirm: target, plan_hash: plan.value.plan_hash },
      eraser,
      {
        filterRepoAvailable: async () => {
          const added = "links/late-dependent.md";
          mkdirSync(join(vault, dirname(added)), { recursive: true });
          writeFileSync(join(vault, added), markdown(added, [], `See [target](${target}).`));
          return true;
        },
        runFilterRepo: async () => {
          rewriteCalled = true;
          return { ok: true, value: undefined };
        },
      },
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/plan_hash.*current erase plan|stale/i);
    expect(rewriteCalled).toBe(false);
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

  it("flags worktree-only resolution when erasing by source_ref", async () => {
    const ref = "distill:chat-a#c1";
    const doc = [
      "---",
      "title: A claim",
      "domain: accumulation",
      "collection: distill",
      "status: draft",
      "confidence: low",
      "created: 2026-01-01",
      "updated: 2026-01-01",
      "updated_by: agent:test",
      "provenance: synthesized",
      `sources: ["${ref}"]`,
      "tags: []",
      "---",
      "",
      "Body.",
    ].join("\n");
    initRepo(vault, "notes/claim.md", doc);
    const r = await vaultErase(vault, { source_ref: ref, confirm: ref }, eraser, {
      filterRepoAvailable: async () => true,
      runFilterRepo: async () => ({ ok: true, value: undefined }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.erased).toContain("notes/claim.md");
    expect(r.value.incomplete.some((s) => s.includes("worktree only"))).toBe(true);
  });
});

describe("vault_erase — dependents plan", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-erase-plan-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("returns a deterministic pre-scrub plan across both dependency channels", async () => {
    const target = "notes/target.md";
    initRepo(vault, target, markdown(target));
    addCommittedFile(
      vault,
      "analysis/source-dependent.md",
      markdown("analysis/source-dependent.md", [target]),
    );
    addCommittedFile(
      vault,
      "links/link-dependent.md",
      markdown("links/link-dependent.md", [], `See [target](${target}).`),
    );

    const first = await vaultErasePlan(vault, { path: target }, eraser);
    const second = await vaultErasePlan(vault, { path: target }, eraser);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value).toMatchObject({
      target: { kind: "path", value: target },
      target_paths: [target],
      hidden_targets: "none",
      downstream: [
        { path: "analysis/source-dependent.md", dependency_type: "source", distance: 1 },
        { path: "links/link-dependent.md", dependency_type: "link", distance: 1 },
      ],
      primary_blast: 1,
      advisory_blast: 1,
      hidden_downstream: "none",
    });
    expect(first.value.vault_head).toMatch(/^[0-9a-f]{40}$/);
    expect(first.value.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.value.plan_hash).toBe(first.value.plan_hash);
  });

  it("omits unreadable dependents and coarsens the hidden remainder", async () => {
    const target = "notes/target.md";
    initRepo(vault, target, markdown(target));
    addCommittedFile(vault, "analysis/visible.md", markdown("analysis/visible.md", [target]));
    addCommittedFile(vault, "restricted/hidden.md", markdown("restricted/hidden.md", [target]));

    const plan = await vaultErasePlan(vault, { path: target }, scopedEraser);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.downstream).toEqual([
      { path: "analysis/visible.md", dependency_type: "source", distance: 1 },
    ]);
    expect(plan.value.primary_blast).toBe(1);
    expect(plan.value.advisory_blast).toBe(0);
    expect(plan.value.hidden_downstream).toBe("some");
    expect(JSON.stringify(plan.value)).not.toContain("restricted/hidden.md");
  });

  it("unions and deduplicates dependents across every source_ref-selected target", async () => {
    const sourceRef = "distill:session-a#claim-1";
    const firstTarget = "notes/a.md";
    const secondTarget = "notes/b.md";
    initRepo(vault, firstTarget, markdown(firstTarget, [sourceRef]));
    addCommittedFile(vault, secondTarget, markdown(secondTarget, [sourceRef]));
    addCommittedFile(
      vault,
      "analysis/shared.md",
      markdown("analysis/shared.md", [firstTarget, secondTarget]),
    );

    const plan = await vaultErasePlan(vault, { source_ref: sourceRef }, eraser);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.target_paths).toEqual([firstTarget, secondTarget]);
    expect(plan.value.downstream).toEqual([
      { path: "analysis/shared.md", dependency_type: "source", distance: 1 },
    ]);
    expect(plan.value.primary_blast).toBe(1);
  });

  it("invalidates an acknowledged plan when vault HEAD changes", async () => {
    const target = "notes/target.md";
    initRepo(vault, target, markdown(target));
    addCommittedFile(vault, "analysis/dependent.md", markdown("analysis/dependent.md", [target]));
    const plan = await vaultErasePlan(vault, { path: target }, eraser);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    addCommittedFile(vault, "unrelated.md", markdown("unrelated.md"));
    let rewriteCalled = false;

    const r = await vaultErase(
      vault,
      { path: target, confirm: target, plan_hash: plan.value.plan_hash },
      eraser,
      {
        filterRepoAvailable: async () => true,
        runFilterRepo: async () => {
          rewriteCalled = true;
          return { ok: true, value: undefined };
        },
      },
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/plan_hash.*current erase plan|stale/i);
    expect(rewriteCalled).toBe(false);
  });

  it("documents the pre-scrub plan and exposure gate", () => {
    const protocol = readFileSync(join(process.cwd(), "docs/erasure-protocol.md"), "utf8");
    expect(protocol).toContain("vaultErasePlan");
    expect(protocol).toContain("plan_hash");
    expect(protocol).toMatch(/source.*link.*dependents/is);
    expect(protocol).toMatch(/stale.*plan.*retry/is);
    expect(protocol).toMatch(/not.*registered.*MCP.*CLI/is);
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
