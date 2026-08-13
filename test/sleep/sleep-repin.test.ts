// U7 — auto-stage repin proposals in the sleep cycle.
//
// The circadian pass stages a `repin` proposal for every doc with a
// currently-relocated pin, idempotently, under `agent:sleep-repin`. Humans
// ratify; the cycle never applies. Three kill-switches:
//   - auto_repin: false
//   - jit_anchors: false
//   - empty code_repos
// All three must leave the cycle result byte-identical to pre-U7 (no `repin`
// field).
//
// The crucial dedup contract: a second run on an unchanged vault produces
// EXACTLY ONE pending `repin` and ZERO inter-proposal tensions.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listStagedActions } from "../../src/curation/staged-actions.js";
import { listTensions } from "../../src/curation/tension.js";
import { runSleepCycle } from "../../src/sleep/cycle.js";
import { clearConfigCache, configPath } from "../../src/utils/config.js";
import { commit, ensureGitRepo, hashObjectFile } from "../../src/utils/git.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TODAY = new Date().toISOString().slice(0, 10);

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Create a minimal git code repo. */
async function makeCodeRepo(): Promise<string> {
  const { mkdtempSync: mdt } = await import("node:fs");
  const dir = mdt(join(tmpdir(), "daftari-code-u7-"));
  await ensureGitRepo(dir);
  return dir;
}

/** Commit content at relPath in codeRepo; return the 40-char blob sha. */
async function commitFile(repo: string, relPath: string, content: string): Promise<string> {
  mkdirSync(join(repo, relPath, ".."), { recursive: true });
  await writeFile(join(repo, relPath), content, "utf-8");
  await commit(repo, [relPath], `add ${relPath}`, "agent:tester");
  const sha = await hashObjectFile(repo, relPath);
  if (!sha.ok) throw new Error(`hashObjectFile failed: ${sha.error.message}`);
  return sha.value;
}

/** Minimal vault doc with optional describes entries. */
function writeVaultDoc(vault: string, relPath: string, describes: string[] = []): void {
  const desBlock =
    describes.length === 0 ? "" : `describes:\n${describes.map((e) => `  - "${e}"`).join("\n")}\n`;
  const content =
    `---\ntitle: "Doc ${relPath}"\ndomain: "accumulation"\ncollection: "${relPath.split("/")[0] ?? "k"}"\n` +
    `status: "canonical"\nconfidence: "medium"\ncreated: "${TODAY}"\nupdated: "${daysAgo(60)}"\n` +
    `updated_by: "agent:test"\nprovenance: "direct"\nttl_days: 30\n${desBlock}sources: []\ntags: []\n---\n\nbody\n`;
  mkdirSync(join(vault, relPath, ".."), { recursive: true });
  writeFileSync(join(vault, relPath), content, "utf-8");
}

/** Write .daftari/config.yaml with code_repos pointing at codeRepo. */
function writeConfig(vault: string, codeRepo: string, repoName = "repo", extras = ""): void {
  mkdirSync(join(vault, ".daftari"), { recursive: true });
  writeFileSync(configPath(vault), `code_repos:\n  ${repoName}: ${codeRepo}\n${extras}`);
  clearConfigCache();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("runSleepCycle — U7 auto-repin proposer", () => {
  let vault: string;
  let codeRepo: string;

  beforeEach(async () => {
    vault = mkdtempSync(join(tmpdir(), "daftari-sleep-u7-"));
    codeRepo = await makeCodeRepo();
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(codeRepo, { recursive: true, force: true });
    clearConfigCache();
  });

  // -------------------------------------------------------------------------
  // Happy path: relocated pin → one proposal staged
  // -------------------------------------------------------------------------

  it("happy: stages a repin proposal for a doc with a relocated pin", async () => {
    // Commit the target file with some content (10 lines).
    const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const sha = await commitFile(codeRepo, "src/mod.ts", body);
    const sha12 = sha.slice(0, 12);

    // The describes entry pins L1-5 at the current sha — plain intact first.
    writeVaultDoc(vault, "knowledge/doc.md", [`repo:src/mod.ts#L1-5@${sha12}`]);
    writeConfig(vault, codeRepo);

    // Now relocate: prepend 5 lines so the block moves to L6-10.
    const prepend = Array.from({ length: 5 }, (_, i) => `prepend ${i + 1}`).join("\n");
    const newBody = `${prepend}\n${body}`;
    await writeFile(join(codeRepo, "src/mod.ts"), newBody, "utf-8");
    await commit(codeRepo, ["src/mod.ts"], "prepend lines", "agent:tester");

    const r = await runSleepCycle(vault);
    expect(r.ok, r.ok ? "" : (r as { error: Error }).error.message).toBe(true);
    if (!r.ok) return;

    // The repin field must be present.
    const repin = r.value.repin;
    expect(repin).toBeDefined();
    if (!repin) return;

    expect(repin.staged).toHaveLength(1);
    expect(repin.staged[0]?.path).toBe("knowledge/doc.md");
    expect(repin.skippedPending).toBe(0);
    expect(repin.errors).toHaveLength(0);

    // The action must be in the queue as pending.
    const actions = await listStagedActions(vault);
    expect(actions.ok).toBe(true);
    if (!actions.ok) return;

    const pending = actions.value.filter((a) => a.actionType === "repin" && a.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.proposedBy).toBe("agent:sleep-repin");
    // proposed_diff.replacements must be present.
    const diff = pending[0]?.proposedDiff as Record<string, unknown>;
    expect(Array.isArray(diff?.replacements)).toBe(true);
    const replacements = diff.replacements as { old: string; new: string }[];
    expect(replacements.length).toBeGreaterThanOrEqual(1);
    // The old pin string should be in the replacement.
    expect(replacements[0]?.old).toContain(`repo:src/mod.ts#L1-5@${sha12}`);
  });

  // -------------------------------------------------------------------------
  // Idempotency / dedup: second run → ZERO new proposals, ZERO tensions
  // -------------------------------------------------------------------------

  it("dedup: second run stages nothing; ZERO inter-proposal tensions", async () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const sha = await commitFile(codeRepo, "src/mod.ts", body);
    const sha12 = sha.slice(0, 12);

    writeVaultDoc(vault, "knowledge/doc.md", [`repo:src/mod.ts#L1-5@${sha12}`]);
    writeConfig(vault, codeRepo);

    // Relocate the block.
    const prepend = Array.from({ length: 5 }, (_, i) => `pre ${i + 1}`).join("\n");
    await writeFile(join(codeRepo, "src/mod.ts"), `${prepend}\n${body}`, "utf-8");
    await commit(codeRepo, ["src/mod.ts"], "relocate", "agent:tester");

    // First run — should stage one proposal.
    const r1 = await runSleepCycle(vault);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.repin?.staged).toHaveLength(1);

    // Second run — unchanged vault; the pending proposal is already there.
    const r2 = await runSleepCycle(vault);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    const repin2 = r2.value.repin;
    expect(repin2).toBeDefined();
    if (!repin2) return;
    expect(repin2.staged).toHaveLength(0);
    expect(repin2.skippedPending).toBe(1);
    expect(repin2.errors).toHaveLength(0);

    // ZERO inter-proposal tensions — the dedup contract.
    const tensions = await listTensions(vault);
    expect(tensions.ok).toBe(true);
    if (!tensions.ok) return;
    const interProposal = tensions.value.filter((t) => t.kind === "inter-proposal");
    expect(interProposal).toHaveLength(0);

    // Still exactly one pending repin in the queue.
    const actions = await listStagedActions(vault);
    expect(actions.ok).toBe(true);
    if (!actions.ok) return;
    const pending = actions.value.filter((a) => a.actionType === "repin" && a.status === "pending");
    expect(pending).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Pending already (human-staged): proposer skips, no duplicate, no tension
  // -------------------------------------------------------------------------

  it("skips when a human-staged pending repin already exists for the doc", async () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const sha = await commitFile(codeRepo, "src/mod.ts", body);
    const sha12 = sha.slice(0, 12);

    writeVaultDoc(vault, "knowledge/doc.md", [`repo:src/mod.ts#L1-5@${sha12}`]);
    writeConfig(vault, codeRepo);

    // Relocate.
    const prepend = Array.from({ length: 5 }, (_, i) => `pre ${i + 1}`).join("\n");
    await writeFile(join(codeRepo, "src/mod.ts"), `${prepend}\n${body}`, "utf-8");
    await commit(codeRepo, ["src/mod.ts"], "relocate", "agent:tester");

    // Human manually stages a repin first.
    const { stageActionWithConflictCheck } = await import("../../src/curation/staged-actions.js");
    const human = await stageActionWithConflictCheck(vault, {
      actionType: "repin",
      targetPath: "knowledge/doc.md",
      proposedBy: "human:alice",
      rationale: "manual repin",
      proposedDiff: { replacements: [] },
    });
    expect(human.ok).toBe(true);

    // Cycle — should skip, NOT stage a second one.
    const r = await runSleepCycle(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const repin = r.value.repin;
    expect(repin).toBeDefined();
    if (!repin) return;
    expect(repin.staged).toHaveLength(0);
    expect(repin.skippedPending).toBe(1);

    // No inter-proposal tensions.
    const tensions = await listTensions(vault);
    expect(tensions.ok).toBe(true);
    if (!tensions.ok) return;
    expect(tensions.value.filter((t) => t.kind === "inter-proposal")).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Non-pending history: rejected repin → proposer stages fresh proposal
  // -------------------------------------------------------------------------

  it("non-pending history: a rejected repin does not block a new proposal", async () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const sha = await commitFile(codeRepo, "src/mod.ts", body);
    const sha12 = sha.slice(0, 12);

    writeVaultDoc(vault, "knowledge/doc.md", [`repo:src/mod.ts#L1-5@${sha12}`]);
    writeConfig(vault, codeRepo);

    // Relocate.
    const prepend = Array.from({ length: 5 }, (_, i) => `pre ${i + 1}`).join("\n");
    await writeFile(join(codeRepo, "src/mod.ts"), `${prepend}\n${body}`, "utf-8");
    await commit(codeRepo, ["src/mod.ts"], "relocate", "agent:tester");

    // Stage and then reject.
    const { stageActionWithConflictCheck, recordDecision, nowISO } = await import(
      "../../src/curation/staged-actions.js"
    );
    const staged = await stageActionWithConflictCheck(vault, {
      actionType: "repin",
      targetPath: "knowledge/doc.md",
      proposedBy: "agent:sleep-repin",
      rationale: "old proposal",
      proposedDiff: { replacements: [] },
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    await recordDecision(vault, staged.value.id, {
      status: "rejected",
      ratifiedAt: nowISO(),
      ratifiedBy: "human:alice",
      reason: "not needed",
    });

    // Cycle — the rejected action is non-pending, so a fresh proposal must be staged.
    const r = await runSleepCycle(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const repin = r.value.repin;
    expect(repin).toBeDefined();
    if (!repin) return;
    expect(repin.staged).toHaveLength(1);
    expect(repin.skippedPending).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Kill-switch: auto_repin: false → no repin field
  // -------------------------------------------------------------------------

  it("kill-switch: auto_repin:false — no repin field, cycle shape unchanged", async () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const sha = await commitFile(codeRepo, "src/mod.ts", body);
    const sha12 = sha.slice(0, 12);

    writeVaultDoc(vault, "knowledge/doc.md", [`repo:src/mod.ts#L1-5@${sha12}`]);
    writeConfig(vault, codeRepo, "repo", "auto_repin: false\n");

    // Relocate.
    const prepend = Array.from({ length: 5 }, (_, i) => `pre ${i + 1}`).join("\n");
    await writeFile(join(codeRepo, "src/mod.ts"), `${prepend}\n${body}`, "utf-8");
    await commit(codeRepo, ["src/mod.ts"], "relocate", "agent:tester");

    const r = await runSleepCycle(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // No repin field at all.
    expect(r.value.repin).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Kill-switch: jit_anchors: false → no repin field
  // -------------------------------------------------------------------------

  it("kill-switch: jit_anchors:false — no repin field", async () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const sha = await commitFile(codeRepo, "src/mod.ts", body);
    const sha12 = sha.slice(0, 12);

    writeVaultDoc(vault, "knowledge/doc.md", [`repo:src/mod.ts#L1-5@${sha12}`]);
    writeConfig(vault, codeRepo, "repo", "jit_anchors: false\n");

    const prepend = Array.from({ length: 5 }, (_, i) => `pre ${i + 1}`).join("\n");
    await writeFile(join(codeRepo, "src/mod.ts"), `${prepend}\n${body}`, "utf-8");
    await commit(codeRepo, ["src/mod.ts"], "relocate", "agent:tester");

    const r = await runSleepCycle(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.repin).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Kill-switch: empty code_repos → no repin field
  // -------------------------------------------------------------------------

  it("kill-switch: empty code_repos — no repin field", async () => {
    // Doc with a pinned entry but no code_repos configured.
    writeVaultDoc(vault, "knowledge/doc.md", ["repo:src/mod.ts#L1-5@abcdef012345"]);
    // Config with no code_repos.
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(configPath(vault), "version: 1\n");
    clearConfigCache();

    const r = await runSleepCycle(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.repin).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Nothing relocated: candidates exist, all pins intact → zero proposals
  // -------------------------------------------------------------------------

  it("nothing relocated: plain-intact pins → repin.staged empty, queue untouched", async () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const sha = await commitFile(codeRepo, "src/mod.ts", body);
    const sha12 = sha.slice(0, 12);

    // Pin is at current position — no relocation.
    writeVaultDoc(vault, "knowledge/doc.md", [`repo:src/mod.ts#L1-5@${sha12}`]);
    writeConfig(vault, codeRepo);

    const r = await runSleepCycle(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const repin = r.value.repin;
    expect(repin).toBeDefined();
    if (!repin) return;
    expect(repin.staged).toHaveLength(0);
    expect(repin.skippedPending).toBe(0);
    expect(repin.errors).toHaveLength(0);

    // Queue completely empty.
    const actions = await listStagedActions(vault);
    expect(actions.ok).toBe(true);
    if (!actions.ok) return;
    expect(actions.value.filter((a) => a.actionType === "repin")).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Per-doc degrade: computeRepin throws for one doc → errors list, rest ok
  // -------------------------------------------------------------------------

  it("per-doc degrade: computeRepin throws for one doc; other candidate still stages; cycle ok", async () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const sha = await commitFile(codeRepo, "src/mod.ts", body);
    const sha12 = sha.slice(0, 12);

    // Two docs that both pin the same file at the same sha.
    writeVaultDoc(vault, "knowledge/doc-a.md", [`repo:src/mod.ts#L1-5@${sha12}`]);
    writeVaultDoc(vault, "knowledge/doc-b.md", [`repo:src/mod.ts#L1-5@${sha12}`]);
    writeConfig(vault, codeRepo);

    // Relocate.
    const prepend = Array.from({ length: 5 }, (_, i) => `pre ${i + 1}`).join("\n");
    await writeFile(join(codeRepo, "src/mod.ts"), `${prepend}\n${body}`, "utf-8");
    await commit(codeRepo, ["src/mod.ts"], "relocate", "agent:tester");

    // Mock computeRepin so it throws for doc-a and returns normally for doc-b.
    // This is the cleanest way to exercise the per-doc degrade path without
    // creating timing-dependent fs manipulations between loadDocuments and the
    // repin pass (both run inside the same runSleepCycle call).
    const repinMod = await import("../../src/tools/repin.js");
    const realComputeRepin = repinMod.computeRepin;
    const spy = vi
      .spyOn(repinMod, "computeRepin")
      .mockImplementation(async (vaultRoot: string, docRelPath: string) => {
        if (docRelPath === "knowledge/doc-a.md") {
          throw new Error("simulated read failure for doc-a");
        }
        return realComputeRepin(vaultRoot, docRelPath);
      });

    let r: Awaited<ReturnType<typeof runSleepCycle>>;
    try {
      r = await runSleepCycle(vault);
    } finally {
      spy.mockRestore();
    }

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const repin = r.value.repin;
    expect(repin).toBeDefined();
    if (!repin) return;
    // doc-a errors; doc-b staged.
    expect(repin.errors.length).toBeGreaterThanOrEqual(1);
    expect(repin.errors[0]?.path).toBe("knowledge/doc-a.md");
    expect(repin.staged).toHaveLength(1);
    expect(repin.staged[0]?.path).toBe("knowledge/doc-b.md");
  });

  // -------------------------------------------------------------------------
  // Integration: ratifying the staged proposal applies (U5 path)
  // -------------------------------------------------------------------------

  it("integration: ratifying the staged proposal applies the repin via vaultWrite", async () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const sha = await commitFile(codeRepo, "src/mod.ts", body);
    const sha12 = sha.slice(0, 12);

    writeVaultDoc(vault, "knowledge/doc.md", [`repo:src/mod.ts#L1-5@${sha12}`]);
    writeConfig(vault, codeRepo);

    // Relocate.
    const prepend = Array.from({ length: 5 }, (_, i) => `pre ${i + 1}`).join("\n");
    await writeFile(join(codeRepo, "src/mod.ts"), `${prepend}\n${body}`, "utf-8");
    await commit(codeRepo, ["src/mod.ts"], "relocate", "agent:tester");

    const r = await runSleepCycle(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const repin = r.value.repin;
    expect(repin?.staged).toHaveLength(1);

    // Ratify it — dispatches through U5 (repin ratify dispatch).
    const actions = await listStagedActions(vault);
    expect(actions.ok).toBe(true);
    if (!actions.ok) return;
    const pending = actions.value.filter((a) => a.actionType === "repin" && a.status === "pending");
    expect(pending).toHaveLength(1);

    const { vaultRatify } = await import("../../src/tools/staged-actions.js");
    const ratifyResult = await vaultRatify(vault, {
      id: pending[0]?.id,
      decision: "approve",
      principal: "human:alice",
    });
    // Ratify must not error.
    expect(
      ratifyResult.ok,
      ratifyResult.ok ? "" : (ratifyResult as { error: Error }).error.message,
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Morning Report section present when pass ran
  // -------------------------------------------------------------------------

  it("Morning Report includes a repin section listing staged proposals", async () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const sha = await commitFile(codeRepo, "src/mod.ts", body);
    const sha12 = sha.slice(0, 12);

    writeVaultDoc(vault, "knowledge/doc.md", [`repo:src/mod.ts#L1-5@${sha12}`]);
    writeConfig(vault, codeRepo);

    // Relocate.
    const prepend = Array.from({ length: 5 }, (_, i) => `pre ${i + 1}`).join("\n");
    await writeFile(join(codeRepo, "src/mod.ts"), `${prepend}\n${body}`, "utf-8");
    await commit(codeRepo, ["src/mod.ts"], "relocate", "agent:tester");

    const r = await runSleepCycle(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const { renderMarkdown } = await import("../../src/sleep/report.js");
    const md = renderMarkdown({
      generatedAt: new Date().toISOString(),
      vault,
      cycle: r.value,
      wakeQueuePath: null,
      wakeLimit: 20,
    });

    expect(md).toContain("## Anchor re-pin");
    expect(md).toContain("knowledge/doc.md");
  });
});
