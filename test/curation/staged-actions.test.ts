import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getStagedActionById,
  listStagedActions,
  materializeStagedActions,
  nowISO,
  proposalTallies,
  rebuildStagedActionsIndex,
  recordDecision,
  type StageActionInput,
  type StagedAction,
  stageAction,
  stageActionWithConflictCheck,
  stagedActionsPath,
  sweepExpiredActions,
} from "../../src/curation/staged-actions.js";
import { listTensions, tensionsPath } from "../../src/curation/tension.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import {
  getAllStagedActions,
  getStagedAction,
  getStagedActionsByStatus,
  openIndexDb,
} from "../../src/storage/index-db.js";

const sampleInput: StageActionInput = {
  actionType: "promote",
  targetPath: "specs/cross-workspace-federation.md",
  proposedBy: "agent:curation-loop",
  rationale: "Doc has matured beyond draft. Strength threshold cleared.",
  proposedDiff: { status: { from: "draft", to: "canonical" } },
};

describe("staged-actions", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-staged-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("returns an empty list when nothing has been staged", async () => {
    const result = await listStagedActions(vault);
    expect(result.ok && result.value).toEqual([]);
  });

  it("stages an action with a default 14-day ttl and pending status", async () => {
    const staged = await stageAction(vault, { ...sampleInput, proposedAt: "2026-06-07T15:30:00Z" });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.value.id).toBe("stage-001");
    expect(staged.value.expires_at).toBe("2026-06-21T15:30:00Z");

    const list = await listStagedActions(vault);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(1);
    const a = list.value[0];
    expect(a?.status).toBe("pending");
    expect(a?.actionType).toBe("promote");
    expect(a?.proposedDiff).toEqual({ status: { from: "draft", to: "canonical" } });
  });

  it("writes an append-only jsonl record per stage", async () => {
    await stageAction(vault, sampleInput);
    const raw = readFileSync(stagedActionsPath(vault), "utf-8").trim();
    expect(raw.split("\n")).toHaveLength(1);
    const rec = JSON.parse(raw) as Record<string, unknown>;
    expect(rec.id).toBe("stage-001");
    expect(rec.action_type).toBe("promote");
    expect(rec.status).toBe("pending");
    // proposed_diff is stored JSON-encoded.
    expect(JSON.parse(rec.proposed_diff as string)).toEqual(sampleInput.proposedDiff);
  });

  it("rejects an unknown action_type", async () => {
    const bad = await stageAction(vault, {
      ...sampleInput,
      actionType: "frobnicate" as unknown as StageActionInput["actionType"],
    });
    expect(bad.ok).toBe(false);
  });

  it("assigns monotonically increasing ids even when staged in the same instant", async () => {
    const results = await Promise.all([
      stageAction(vault, sampleInput),
      stageAction(vault, sampleInput),
      stageAction(vault, sampleInput),
    ]);
    const ids = results.map((r) => (r.ok ? r.value.id : "ERR")).sort();
    expect(ids).toEqual(["stage-001", "stage-002", "stage-003"]);
  });

  it("records a ratification as a second append-only record collapsing to current status", async () => {
    const staged = await stageAction(vault, sampleInput);
    if (!staged.ok) return;
    const decided = await recordDecision(vault, staged.value.id, {
      status: "ratified",
      ratifiedAt: "2026-06-08T09:15:00Z",
      ratifiedBy: "human:mihir",
      reason: "Confirmed — analysis is settled",
    });
    expect(decided.ok).toBe(true);

    // Two physical records, one logical action.
    const raw = readFileSync(stagedActionsPath(vault), "utf-8").trim();
    expect(raw.split("\n")).toHaveLength(2);

    const fetched = await getStagedActionById(vault, staged.value.id);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok || !fetched.value) return;
    expect(fetched.value.status).toBe("ratified");
    expect(fetched.value.ratifiedBy).toBe("human:mihir");
    expect(fetched.value.ratificationReason).toBe("Confirmed — analysis is settled");
  });

  it("returns the collapsed post-decision row without re-reading the whole log", async () => {
    // recordDecision collapses the pre-existing log once and applies the new
    // decision to that map in memory (rather than re-reading + re-collapsing
    // the file a second time). The returned row must still reflect the decision
    // exactly, even with many unrelated prior actions in the log.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await stageAction(vault, { ...sampleInput, targetPath: `specs/doc-${i}.md` });
      if (!s.ok) return;
      ids.push(s.value.id);
    }
    const target = ids[2] as string;
    const decided = await recordDecision(vault, target, {
      status: "ratified",
      ratifiedAt: "2026-06-08T09:15:00Z",
      ratifiedBy: "human:mihir",
      reason: "Confirmed",
      decidedByPrincipal: "human:mihir",
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    // The returned row is the collapsed CURRENT state for that id.
    expect(decided.value.id).toBe(target);
    expect(decided.value.status).toBe("ratified");
    expect(decided.value.ratifiedBy).toBe("human:mihir");
    expect(decided.value.ratificationReason).toBe("Confirmed");
    expect(decided.value.decidedByPrincipal).toBe("human:mihir");
    // The other actions are untouched and still pending on re-read.
    const still = await getStagedActionById(vault, ids[0] as string);
    expect(still.ok && still.value?.status).toBe("pending");

    // A subsequent decision on the SAME id collapses on top of the first —
    // proving the in-memory apply used the freshly-appended decision, not a
    // stale pre-decision snapshot.
    const again = await recordDecision(vault, target, {
      status: "rejected",
      ratifiedAt: "2026-06-09T09:15:00Z",
      ratifiedBy: "human:mihir",
    });
    expect(again.ok && again.value.status).toBe("rejected");
    const reread = await getStagedActionById(vault, target);
    expect(reread.ok && reread.value?.status).toBe("rejected");
  });

  it("sweeps pending actions past their expiry into expired status", async () => {
    // Staged 30 days before "now": well past the 14-day ttl.
    await stageAction(vault, { ...sampleInput, proposedAt: "2026-05-01T00:00:00Z" });
    const fresh = await stageAction(vault, { ...sampleInput, proposedAt: "2026-06-07T00:00:00Z" });
    if (!fresh.ok) return;

    const now = new Date("2026-06-07T12:00:00Z");
    const swept = await sweepExpiredActions(vault, now);
    expect(swept.ok).toBe(true);
    if (!swept.ok) return;
    expect(swept.value.expired).toEqual(["stage-001"]);

    const pending = await listStagedActions(vault, "pending");
    expect(pending.ok && pending.value.map((a) => a.id)).toEqual(["stage-002"]);
    const expired = await listStagedActions(vault, "expired");
    expect(expired.ok && expired.value.map((a) => a.id)).toEqual(["stage-001"]);
  });

  it("rebuilds the sqlite index from the jsonl, collapsing to current state", async () => {
    const a = await stageAction(vault, sampleInput);
    const b = await stageAction(vault, { ...sampleInput, targetPath: "specs/other.md" });
    if (!a.ok || !b.ok) return;
    await recordDecision(vault, a.value.id, {
      status: "ratified",
      ratifiedAt: "2026-06-08T09:15:00Z",
      ratifiedBy: "human:mihir",
    });

    const opened = openIndexDb(vault, LOCAL_MINILM_DIM, "float32");
    if (!opened.ok) throw opened.error;
    const db = opened.value;
    try {
      const rebuilt = rebuildStagedActionsIndex(db, vault);
      expect(rebuilt.ok).toBe(true);
      // One row per logical action — the decision collapsed into the proposal.
      expect(getAllStagedActions(db)).toHaveLength(2);
      expect(getStagedAction(db, a.value.id)?.status).toBe("ratified");
      expect(getStagedAction(db, b.value.id)?.status).toBe("pending");
      expect(getStagedActionsByStatus(db, "pending").map((r) => r.id)).toEqual([b.value.id]);
    } finally {
      db.close();
    }
  });

  it("materializes the index against the active provider without an open db handle", async () => {
    await stageAction(vault, sampleInput);
    const result = materializeStagedActions(vault);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(1);

    const opened = openIndexDb(vault, LOCAL_MINILM_DIM, "float32");
    if (!opened.ok) throw opened.error;
    try {
      expect(getAllStagedActions(opened.value)).toHaveLength(1);
    } finally {
      opened.value.close();
    }
  });

  it("records decided_by_principal on a reject decision and round-trips it", async () => {
    const staged = await stageAction(vault, sampleInput);
    if (!staged.ok) return;
    const decided = await recordDecision(vault, staged.value.id, {
      status: "rejected",
      ratifiedAt: nowISO(),
      ratifiedBy: "agent:curation-loop",
      decidedByPrincipal: "agent:curation-loop",
    });
    expect(decided.ok).toBe(true);

    const fetched = await getStagedActionById(vault, staged.value.id);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok || !fetched.value) return;
    expect(fetched.value.decidedByPrincipal).toBe("agent:curation-loop");
  });

  it("omits decided_by_principal when not supplied", async () => {
    const staged = await stageAction(vault, sampleInput);
    if (!staged.ok) return;
    const decided = await recordDecision(vault, staged.value.id, {
      status: "rejected",
      ratifiedAt: nowISO(),
      ratifiedBy: "agent:curation-loop",
    });
    expect(decided.ok).toBe(true);

    const fetched = await getStagedActionById(vault, staged.value.id);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok || !fetched.value) return;
    expect(fetched.value.decidedByPrincipal).toBeNull();
  });

  describe("stageActionWithConflictCheck (#235)", () => {
    it("stages with no conflict surface when the target is uncontested", async () => {
      const result = await stageActionWithConflictCheck(vault, sampleInput);
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      expect(result.value.conflicts_with).toEqual([]);
      expect(result.value.tension_id).toBeNull();

      const tensions = await listTensions(vault);
      expect(tensions.ok && tensions.value).toEqual([]);
    });

    it("logs one inter-proposal self-tension naming all pending contenders", async () => {
      const a = await stageActionWithConflictCheck(vault, sampleInput);
      const b = await stageActionWithConflictCheck(vault, {
        ...sampleInput,
        actionType: "deprecate",
        rationale: "Retire it instead.",
      });
      const c = await stageActionWithConflictCheck(vault, {
        ...sampleInput,
        actionType: "confidence-up",
        rationale: "Third opinion.",
        proposedDiff: { confidence: "high" },
      });
      if (!a.ok || !b.ok || !c.ok) throw new Error("staging failed");

      expect(b.value.conflicts_with).toEqual([a.value.id]);
      // The third arrival contests BOTH earlier pending proposals.
      expect(c.value.conflicts_with.sort()).toEqual([a.value.id, b.value.id].sort());

      const tensions = await listTensions(vault);
      expect(tensions.ok).toBe(true);
      if (!tensions.ok) throw tensions.error;
      expect(tensions.value).toHaveLength(2);
      const last = tensions.value.find((t) => t.id === c.value.tension_id);
      expect(last?.kind).toBe("inter-proposal");
      expect(last?.sourceA).toBe(sampleInput.targetPath);
      expect(last?.sourceB).toBe(sampleInput.targetPath);
      expect(last?.claimA).toContain(a.value.id);
      expect(last?.claimA).toContain(b.value.id);
      expect(last?.claimB).toContain(c.value.id);
    });

    it("decided proposals are not contenders", async () => {
      const a = await stageActionWithConflictCheck(vault, sampleInput);
      if (!a.ok) throw a.error;
      const decided = await recordDecision(vault, a.value.id, {
        status: "rejected",
        ratifiedAt: nowISO(),
        ratifiedBy: "human:mihir",
      });
      if (!decided.ok) throw decided.error;

      const b = await stageActionWithConflictCheck(vault, sampleInput);
      expect(b.ok).toBe(true);
      if (!b.ok) throw b.error;
      expect(b.value.conflicts_with).toEqual([]);
      expect(b.value.tension_id).toBeNull();
    });

    it("surfaces a structured tension_error when the tension log cannot be written", async () => {
      const a = await stageActionWithConflictCheck(vault, sampleInput);
      if (!a.ok) throw a.error;
      // Make tensions.md unwritable by occupying its path with a directory —
      // the conflict on the SECOND staging then cannot log its tension.
      mkdirSync(tensionsPath(vault), { recursive: true });

      // The append is durable, so this is an ok with a structured error field
      // — an err would invite a retry that duplicates the proposal, with the
      // staged id recoverable only by parsing message text.
      const b = await stageActionWithConflictCheck(vault, sampleInput);
      expect(b.ok).toBe(true);
      if (!b.ok) return;
      expect(b.value.id).toBe("stage-002");
      expect(b.value.conflicts_with).toEqual([a.value.id]);
      expect(b.value.tension_id).toBeNull();
      expect(b.value.tension_error).toContain("tension log");

      // The proposal itself landed — only the tension write failed.
      const staged = await getStagedActionById(vault, "stage-002");
      expect(staged.ok && staged.value?.status).toBe("pending");
    });
  });

  // 2026-07-26 risk-triaged-ratification spec, Decision 3 (Phase 1): the
  // decision-record extensions (decision_kind, reason_category, amended_diff,
  // staged_by_principal) and Mihir's 2026-07-27 risk_at_decision addendum.
  describe("Decision 3 fields (decision_kind, reason_category, amended_diff, staged_by_principal)", () => {
    it("round-trips decision_kind, reason_category, amended_diff, and risk_at_decision through collapse", async () => {
      const staged = await stageAction(vault, sampleInput);
      if (!staged.ok) return;
      const decided = await recordDecision(vault, staged.value.id, {
        status: "ratified",
        ratifiedAt: nowISO(),
        ratifiedBy: "human:mihir",
        decisionKind: "edit-then-approve",
        reasonCategory: "overbroad",
        amendedDiff: { status: { from: "draft", to: "canonical" }, note: "edited" },
        riskAtDecision: 0.42,
      });
      expect(decided.ok).toBe(true);
      if (!decided.ok) return;
      expect(decided.value.decisionKind).toBe("edit-then-approve");
      expect(decided.value.reasonCategory).toBe("overbroad");
      expect(decided.value.amendedDiff).toEqual({
        status: { from: "draft", to: "canonical" },
        note: "edited",
      });
      expect(decided.value.riskAtDecision).toBe(0.42);

      // Re-read from a fresh collapse (not the in-memory mirror) — the two
      // sites the module warns about must not drift.
      const reread = await getStagedActionById(vault, staged.value.id);
      expect(reread.ok).toBe(true);
      if (!reread.ok || !reread.value) return;
      expect(reread.value.decisionKind).toBe("edit-then-approve");
      expect(reread.value.reasonCategory).toBe("overbroad");
      expect(reread.value.amendedDiff).toEqual({
        status: { from: "draft", to: "canonical" },
        note: "edited",
      });
      expect(reread.value.riskAtDecision).toBe(0.42);
    });

    it("an old-shaped decision record (no Decision-3 fields) still collapses, yielding nulls", async () => {
      const staged = await stageAction(vault, sampleInput);
      if (!staged.ok) return;
      const decided = await recordDecision(vault, staged.value.id, {
        status: "ratified",
        ratifiedAt: nowISO(),
        ratifiedBy: "human:mihir",
      });
      expect(decided.ok).toBe(true);
      if (!decided.ok) return;
      expect(decided.value.decisionKind).toBeNull();
      expect(decided.value.reasonCategory).toBeNull();
      expect(decided.value.amendedDiff).toBeNull();
      expect(decided.value.riskAtDecision).toBeNull();
      expect(decided.value.stagedByPrincipal).toBeNull();
    });

    it("records staged_by_principal on the proposal and round-trips it", async () => {
      const staged = await stageAction(vault, { ...sampleInput, stagedByPrincipal: "human:mihir" });
      if (!staged.ok) return;
      const fetched = await getStagedActionById(vault, staged.value.id);
      expect(fetched.ok).toBe(true);
      if (!fetched.ok || !fetched.value) return;
      expect(fetched.value.stagedByPrincipal).toBe("human:mihir");
    });

    it("recordDecision validates decisionKind and reasonCategory enum membership", async () => {
      const staged = await stageAction(vault, sampleInput);
      if (!staged.ok) return;
      const badKind = await recordDecision(vault, staged.value.id, {
        status: "ratified",
        ratifiedAt: nowISO(),
        ratifiedBy: "human:mihir",
        decisionKind: "not-a-real-kind" as never,
      });
      expect(badKind.ok).toBe(false);
      const badCategory = await recordDecision(vault, staged.value.id, {
        status: "rejected",
        ratifiedAt: nowISO(),
        ratifiedBy: "human:mihir",
        reasonCategory: "not-a-real-category" as never,
      });
      expect(badCategory.ok).toBe(false);
    });

    it("the sweep's expiry decisions stay bare — no Decision-3 fields, no risk_at_decision", async () => {
      await stageAction(vault, { ...sampleInput, proposedAt: "2026-01-01T00:00:00Z" });
      const swept = await sweepExpiredActions(vault, new Date("2026-06-01T00:00:00Z"));
      expect(swept.ok).toBe(true);
      const expired = await getStagedActionById(vault, "stage-001");
      expect(expired.ok).toBe(true);
      if (!expired.ok || !expired.value) return;
      expect(expired.value.status).toBe("expired");
      expect(expired.value.decisionKind).toBeNull();
      expect(expired.value.reasonCategory).toBeNull();
      expect(expired.value.riskAtDecision).toBeNull();
    });
  });

  describe("proposalTallies", () => {
    function action(overrides: Partial<StagedAction> = {}): StagedAction {
      return {
        id: "stage-001",
        actionType: "promote",
        targetPath: "a.md",
        proposedBy: "agent:x",
        proposedAt: "2026-06-01T00:00:00Z",
        expiresAt: "2026-06-15T00:00:00Z",
        status: "pending",
        rationale: "r",
        proposedDiff: {},
        ratifiedAt: null,
        ratifiedBy: null,
        ratificationReason: null,
        decidedByPrincipal: null,
        runId: null,
        decisionKind: null,
        reasonCategory: null,
        amendedDiff: null,
        stagedByPrincipal: null,
        riskAtDecision: null,
        ...overrides,
      };
    }

    it("counts edited (a subset of ratified) and byCategory over decided rows", () => {
      const actions: StagedAction[] = [
        action({
          id: "1",
          status: "ratified",
          decisionKind: "edit-then-approve",
          reasonCategory: "overbroad",
        }),
        action({ id: "2", status: "ratified" }),
        action({ id: "3", status: "rejected", reasonCategory: "duplicate" }),
        action({ id: "4", status: "pending" }),
      ];
      const tallies = proposalTallies(actions);
      const t = tallies.get("agent:x");
      expect(t).toEqual({
        total: 4,
        ratified: 2,
        rejected: 1,
        expired: 0,
        pending: 1,
        edited: 1,
        byCategory: { overbroad: 1, duplicate: 1 },
      });
    });

    it("keys by stagedByPrincipal, falling back to proposedBy (anti-laundering, C4)", () => {
      const actions: StagedAction[] = [
        action({
          id: "1",
          proposedBy: "agent:rival-name-1",
          stagedByPrincipal: "human:mihir",
          status: "rejected",
        }),
        action({
          id: "2",
          proposedBy: "agent:rival-name-2",
          stagedByPrincipal: "human:mihir",
          status: "rejected",
        }),
      ];
      const tallies = proposalTallies(actions);
      // Rotating the unauthenticated proposed_by string does NOT fragment the
      // tally — both land under the one authenticated stager.
      expect(tallies.size).toBe(1);
      expect(tallies.get("human:mihir")?.rejected).toBe(2);
      expect(tallies.has("agent:rival-name-1")).toBe(false);
      expect(tallies.has("agent:rival-name-2")).toBe(false);
    });

    it("junk staged under a rival's claimed name counts against the actual stager (anti-poisoning, C4)", () => {
      const actions: StagedAction[] = [
        action({
          id: "1",
          proposedBy: "agent:rival",
          stagedByPrincipal: "human:attacker",
          status: "rejected",
        }),
      ];
      const tallies = proposalTallies(actions);
      expect(tallies.get("human:attacker")?.rejected).toBe(1);
      expect(tallies.has("agent:rival")).toBe(false);
    });

    it("falls back to proposedBy for legacy records with no stagedByPrincipal", () => {
      const actions: StagedAction[] = [action({ id: "1", proposedBy: "agent:legacy" })];
      const tallies = proposalTallies(actions);
      expect(tallies.get("agent:legacy")?.total).toBe(1);
    });
  });
});
