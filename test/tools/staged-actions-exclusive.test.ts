// Decision exclusivity and interruption safety for vault_ratify (8i1l).
//
// The Stage-1 T02 run showed that two concurrent decisions on one staged
// action both succeeded: approve-vs-reject left a contradictory
// `[rejected, ratified]` log in 120/120 trials, approve-vs-approve applied a
// write twice when the second approve landed after the first one's file lease
// was released, and an approve interrupted between the write and its decision
// record left the action pending, so the next approve applied it again.
//
// These tests pin the fixed contract:
//   - one disposition per action, however the decisions interleave;
//   - one application per action;
//   - an interrupted approval is detectable (`applying`) and is never
//     re-applied blindly — it must be resolved explicitly;
//   - the decision is exclusive across processes too (locks.db lease).

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, leaseHostTag, openLockDb, releaseLock } from "../../src/access/locks.js";
import {
  getStagedActionById,
  stagedActionLockKey,
  stagedActionsPath,
  sweepExpiredActions,
} from "../../src/curation/staged-actions.js";
import { vaultRatify, vaultStageAction } from "../../src/tools/staged-actions.js";
import { vaultWrite } from "../../src/tools/write.js";
import { log as gitLog, statusPorcelain } from "../../src/utils/git.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:curation-loop";
const HUMAN = "human:mihir";

function frontmatter(title: string): Record<string, unknown> {
  return {
    title,
    domain: "accumulation",
    collection: "pricing",
    status: "draft",
    confidence: "medium",
    created: "2026-05-01",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: 90,
    tags: ["spec"],
  };
}

async function stageWrite(vault: string, path: string): Promise<string> {
  const staged = await vaultStageAction(vault, {
    action_type: "write",
    target_path: path,
    proposed_by: AGENT,
    rationale: "Race fixture.",
    proposed_diff: { frontmatter: frontmatter(path), body: `# ${path}\n\nBody.\n` },
  });
  if (!staged.ok) throw staged.error;
  return staged.value.id;
}

interface RawDecision {
  id: string;
  status?: string;
  action_type?: string;
}

function decisionStatuses(vault: string, id: string): string[] {
  let raw = "";
  try {
    raw = readFileSync(stagedActionsPath(vault), "utf-8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RawDecision)
    .filter((r) => r.id === id && r.action_type === undefined)
    .map((r) => r.status ?? "");
}

const TERMINAL = new Set(["ratified", "rejected", "expired"]);

async function commitsFor(vault: string, path: string): Promise<number> {
  const commits = await gitLog(vault, { path, limit: 50 });
  return commits.ok ? commits.value.length : 0;
}

describe("vault_ratify — decision exclusivity (8i1l)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("approve vs reject at the same instant: exactly one disposition, applied iff approve won", async () => {
    for (let i = 0; i < 12; i++) {
      const path = `pricing/ar-${i}.md`;
      const id = await stageWrite(vault, path);
      const [a, r] = await Promise.all([
        vaultRatify(vault, { id, decision: "approve", principal: "human:a" }),
        vaultRatify(vault, { id, decision: "reject", principal: "human:r" }),
      ]);
      // Exactly one caller is told it decided the action.
      expect([a.ok, r.ok].filter(Boolean)).toHaveLength(1);

      const terminal = decisionStatuses(vault, id).filter((s) => TERMINAL.has(s));
      expect(terminal).toHaveLength(1);

      const final = await getStagedActionById(vault, id);
      expect(final.ok).toBe(true);
      if (!final.ok) return;
      const commits = await commitsFor(vault, path);
      if (a.ok) {
        expect(final.value?.status).toBe("ratified");
        expect(commits).toBe(1);
      } else {
        expect(final.value?.status).toBe("rejected");
        expect(commits).toBe(0);
      }
    }
  }, 120_000);

  it("approve vs approve across the post-lease window: applied exactly once", async () => {
    // T02 measured double application when the second approve started 60-76ms
    // after the first (after the file lease was released, before the decision
    // was recorded). Sweep the stagger across and around that window.
    const staggers = [0, 0, 20, 40, 55, 60, 65, 70, 72, 76, 80, 100];
    for (const [i, d] of staggers.entries()) {
      const path = `pricing/aa-${i}.md`;
      const id = await stageWrite(vault, path);
      const [first, second] = await Promise.all([
        vaultRatify(vault, { id, decision: "approve", principal: "human:a" }),
        sleep(d).then(() => vaultRatify(vault, { id, decision: "approve", principal: "human:b" })),
      ]);
      expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
      expect(decisionStatuses(vault, id).filter((s) => s === "ratified")).toHaveLength(1);
      expect(await commitsFor(vault, path)).toBe(1);
    }
  }, 120_000);

  it("approve vs reject on a confidence-up: one disposition, no contradictory log", async () => {
    const seeded = await vaultWrite(vault, {
      path: "pricing/conf.md",
      frontmatter: { ...frontmatter("Conf"), confidence: "low" },
      body: "# Conf\n\nBody.\n",
      agent: "agent:seed",
    });
    if (!seeded.ok) throw seeded.error;
    for (let i = 0; i < 6; i++) {
      const staged = await vaultStageAction(vault, {
        action_type: "confidence-up",
        target_path: "pricing/conf.md",
        proposed_by: AGENT,
        rationale: "Corroborated.",
        proposed_diff: { confidence: i % 2 === 0 ? "medium" : "low" },
      });
      if (!staged.ok) throw staged.error;
      const id = staged.value.id;
      const [a, r] = await Promise.all([
        vaultRatify(vault, { id, decision: "approve", principal: "human:a" }),
        vaultRatify(vault, { id, decision: "reject", principal: "human:r" }),
      ]);
      expect([a.ok, r.ok].filter(Boolean)).toHaveLength(1);
      expect(decisionStatuses(vault, id).filter((s) => TERMINAL.has(s))).toHaveLength(1);
    }
  }, 120_000);

  it("a decision held by another process (locks.db lease) is refused, not raced", async () => {
    const id = await stageWrite(vault, "pricing/xproc.md");
    const db = openLockDb(vault);
    if (!db.ok) throw db.error;
    const foreign = "424242:foreign-holder:human:other";
    const held = acquireLock(db.value, stagedActionLockKey(id), foreign);
    expect(held.ok).toBe(true);
    try {
      const r = await vaultRatify(vault, { id, decision: "reject", principal: HUMAN });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.message).toMatch(/being decided/);
      const a = await vaultRatify(vault, { id, decision: "approve", principal: HUMAN });
      expect(a.ok).toBe(false);
      expect(await commitsFor(vault, "pricing/xproc.md")).toBe(0);
      const still = await getStagedActionById(vault, id);
      expect(still.ok && still.value?.status).toBe("pending");
    } finally {
      releaseLock(db.value, stagedActionLockKey(id), foreign);
      db.value.close();
    }
    // Once the other decider lets go, the action is decidable again.
    const after = await vaultRatify(vault, { id, decision: "approve", principal: HUMAN });
    expect(after.ok).toBe(true);
  }, 60_000);

  it("a decision lease left by a crashed decider on this host does not block the retry (54pq)", async () => {
    const id = await stageWrite(vault, "pricing/xproc-dead.md");
    const db = openLockDb(vault);
    if (!db.ok) throw db.error;
    const child = spawnSync(process.execPath, ["-e", ""]);
    const crashed = `${child.pid}@${leaseHostTag()}:00000000-dead:human:crashed`;
    try {
      expect(acquireLock(db.value, stagedActionLockKey(id), crashed).ok).toBe(true);
      const r = await vaultRatify(vault, { id, decision: "approve", principal: HUMAN });
      expect(r.ok).toBe(true);
      expect(await commitsFor(vault, "pricing/xproc-dead.md")).toBe(1);
    } finally {
      db.value.close();
    }
  }, 60_000);

  it("the expiry sweep skips an action whose decision is in flight elsewhere", async () => {
    const id = await stageWrite(vault, "pricing/sweep-held.md");
    const db = openLockDb(vault);
    if (!db.ok) throw db.error;
    const foreign = "424242:foreign-holder:human:other";
    acquireLock(db.value, stagedActionLockKey(id), foreign);
    try {
      const far = new Date(Date.now() + 365 * 86_400_000);
      const swept = await sweepExpiredActions(vault, far);
      expect(swept.ok && swept.value.expired).not.toContain(id);
    } finally {
      releaseLock(db.value, stagedActionLockKey(id), foreign);
      db.value.close();
    }
    const far = new Date(Date.now() + 365 * 86_400_000);
    const swept = await sweepExpiredActions(vault, far);
    expect(swept.ok && swept.value.expired).toContain(id);
  }, 60_000);

  it("a failed dispatch returns the action to pending (the applying marker is released)", async () => {
    // A supersede onto a missing successor fails inside the dispatch, after
    // the applying marker is written.
    const seeded = await vaultWrite(vault, {
      path: "pricing/stale.md",
      frontmatter: frontmatter("Stale"),
      body: "# Stale\n\nv1\n",
      agent: "agent:seed",
    });
    if (!seeded.ok) throw seeded.error;
    const staged = await vaultStageAction(vault, {
      action_type: "supersede",
      target_path: "pricing/stale.md",
      proposed_by: AGENT,
      rationale: "Malformed on purpose.",
      proposed_diff: { superseded_by: "pricing/does-not-exist.md" },
    });
    if (!staged.ok) throw staged.error;
    const r = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(r.ok).toBe(false);
    const after = await getStagedActionById(vault, staged.value.id);
    expect(after.ok && after.value?.status).toBe("pending");
    // And it is still decidable.
    const rej = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "reject",
      principal: HUMAN,
    });
    expect(rej.ok).toBe(true);
  }, 60_000);
});

describe("vault_ratify — interrupted approval (8i1l)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  // Reproduces "crash after the write, before the decision": the approve's
  // applying marker is in the log and the write landed, but no terminal
  // record followed.
  async function interruptedAfterWrite(path: string): Promise<string> {
    const id = await stageWrite(vault, path);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      stagedActionsPath(vault),
      `${JSON.stringify({
        id,
        status: "applying",
        ratified_at: "2026-11-16T00:00:00Z",
        ratified_by: "human:crashed",
      })}\n`,
    );
    const landed = await vaultWrite(vault, {
      path,
      frontmatter: frontmatter(path),
      body: `# ${path}\n\nBody.\n`,
      agent: "human:crashed",
    });
    if (!landed.ok) throw landed.error;
    return id;
  }

  it("collapses to `applying`, and a re-approve refuses instead of applying twice", async () => {
    const path = "pricing/int-a.md";
    const id = await interruptedAfterWrite(path);
    const state = await getStagedActionById(vault, id);
    expect(state.ok && state.value?.status).toBe("applying");

    const again = await vaultRatify(vault, { id, decision: "approve", principal: HUMAN });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.message).toMatch(/interrupted/);
    expect(again.error.message).toContain("resolve_interrupted");
    expect(await commitsFor(vault, path)).toBe(1);
  }, 60_000);

  it("a reject on an interrupted approval refuses too (it would contradict a landed write)", async () => {
    const id = await interruptedAfterWrite("pricing/int-r.md");
    const r = await vaultRatify(vault, { id, decision: "reject", principal: HUMAN });
    expect(r.ok).toBe(false);
    const state = await getStagedActionById(vault, id);
    expect(state.ok && state.value?.status).toBe("applying");
  }, 60_000);

  it("the expiry sweep leaves an interrupted approval for a human", async () => {
    const id = await interruptedAfterWrite("pricing/int-s.md");
    const swept = await sweepExpiredActions(vault, new Date(Date.now() + 365 * 86_400_000));
    expect(swept.ok && swept.value.expired).not.toContain(id);
  }, 60_000);

  it("resolve_interrupted: 'landed' records ratified without re-applying", async () => {
    const path = "pricing/int-landed.md";
    const id = await interruptedAfterWrite(path);
    const r = await vaultRatify(vault, { id, resolve_interrupted: "landed", principal: HUMAN });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.applied).toBe(false);
    const state = await getStagedActionById(vault, id);
    expect(state.ok && state.value?.status).toBe("ratified");
    expect(await commitsFor(vault, path)).toBe(1);
    expect(decisionStatuses(vault, id).filter((s) => TERMINAL.has(s))).toEqual(["ratified"]);
  }, 60_000);

  it("resolve_interrupted: 'not-landed' reopens the action; the next approve applies once", async () => {
    const path = "pricing/int-nl.md";
    const id = await stageWrite(vault, path);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      stagedActionsPath(vault),
      `${JSON.stringify({ id, status: "applying", ratified_by: "human:crashed" })}\n`,
    );
    const reopened = await vaultRatify(vault, {
      id,
      resolve_interrupted: "not-landed",
      principal: HUMAN,
    });
    expect(reopened.ok).toBe(true);
    const state = await getStagedActionById(vault, id);
    expect(state.ok && state.value?.status).toBe("pending");
    const approved = await vaultRatify(vault, { id, decision: "approve", principal: HUMAN });
    expect(approved.ok).toBe(true);
    expect(await commitsFor(vault, path)).toBe(1);
  }, 60_000);

  // 54pq: the crash window between the file write and its git commit. The
  // applying marker is logged and the file is on disk, but HEAD never saw it.
  async function interruptedBeforeCommit(path: string, body: string): Promise<string> {
    const id = await stageWrite(vault, path);
    appendFileSync(
      stagedActionsPath(vault),
      `${JSON.stringify({
        id,
        status: "applying",
        ratified_at: "2026-11-16T00:00:00Z",
        ratified_by: "human:crashed",
      })}\n`,
    );
    mkdirSync(join(vault, dirname(path)), { recursive: true });
    const fm = frontmatter(path);
    writeFileSync(
      join(vault, path),
      `---\ntitle: ${String(fm.title)}\ndomain: accumulation\ncollection: pricing\n` +
        `status: draft\nconfidence: medium\ncreated: 2026-05-01\nupdated: 2026-11-16\n` +
        `provenance: direct\nsources: []\nsuperseded_by: null\nttl_days: 90\ntags: [spec]\n---\n` +
        body,
    );
    return id;
  }

  // Not in HEAD: untracked or modified (or no repository yet at all).
  async function dirty(path: string): Promise<boolean> {
    const st = await statusPorcelain(vault, [path]);
    return !st.ok || st.value.length > 0;
  }

  it("resolve_interrupted: 'landed' commits a written-but-uncommitted file with the approver's attribution", async () => {
    const path = "pricing/int-uncommitted.md";
    const id = await interruptedBeforeCommit(path, `# ${path}\n\nBody.\n`);
    expect(await commitsFor(vault, path)).toBe(0);
    expect(await dirty(path)).toBe(true);

    const r = await vaultRatify(vault, { id, resolve_interrupted: "landed", principal: HUMAN });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.applied).toBe(false);
    expect(r.value.commit).toBeTruthy();

    const commits = await gitLog(vault, { path, limit: 5 });
    expect(commits.ok && commits.value).toHaveLength(1);
    if (!commits.ok) return;
    // Authored by the approver whose interrupted write it was, not the resolver.
    expect(commits.value[0]?.author).toContain("crashed");
    expect(commits.value[0]?.subject).toMatch(/^vault_ratify: /);
    expect(commits.value[0]?.subject).toContain(id);
    expect(await dirty(path)).toBe(false);
    const state = await getStagedActionById(vault, id);
    expect(state.ok && state.value?.status).toBe("ratified");
  }, 60_000);

  it("resolve_interrupted: 'landed' is refused when the target is not on disk", async () => {
    const path = "pricing/int-missing.md";
    const id = await stageWrite(vault, path);
    appendFileSync(
      stagedActionsPath(vault),
      `${JSON.stringify({ id, status: "applying", ratified_by: "human:crashed" })}\n`,
    );
    const r = await vaultRatify(vault, { id, resolve_interrupted: "landed", principal: HUMAN });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("not-landed");
    expect(r.error.message).toContain(path);
    const state = await getStagedActionById(vault, id);
    expect(state.ok && state.value?.status).toBe("applying");
  }, 60_000);

  it("resolve_interrupted: 'landed' is refused when the file differs from the action's payload", async () => {
    const path = "pricing/int-differs.md";
    const id = await interruptedBeforeCommit(path, "# Someone else's edit\n\nNot the proposal.\n");
    const r = await vaultRatify(vault, { id, resolve_interrupted: "landed", principal: HUMAN });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("not-landed");
    expect(r.error.message).toMatch(/differs|does not match/);
    // Nothing committed, nothing decided.
    expect(await commitsFor(vault, path)).toBe(0);
    expect(await dirty(path)).toBe(true);
    const state = await getStagedActionById(vault, id);
    expect(state.ok && state.value?.status).toBe("applying");
  }, 60_000);

  it("resolve_interrupted is refused on an action that is not interrupted", async () => {
    const id = await stageWrite(vault, "pricing/int-none.md");
    const r = await vaultRatify(vault, { id, resolve_interrupted: "landed", principal: HUMAN });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/not interrupted|'pending'/);
    const bad = await vaultRatify(vault, { id, resolve_interrupted: "maybe", principal: HUMAN });
    expect(bad.ok).toBe(false);
  }, 60_000);
});
