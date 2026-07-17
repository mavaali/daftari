import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getStagedActionById,
  listStagedActions,
  materializeStagedActions,
  nowISO,
  rebuildStagedActionsIndex,
  recordDecision,
  type StageActionInput,
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

    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
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

    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
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

    it("fails loud, naming the staged id, when the tension log cannot be written", async () => {
      const a = await stageActionWithConflictCheck(vault, sampleInput);
      if (!a.ok) throw a.error;
      // Make tensions.md unwritable by occupying its path with a directory —
      // the conflict on the SECOND staging then cannot log its tension.
      mkdirSync(tensionsPath(vault), { recursive: true });

      const b = await stageActionWithConflictCheck(vault, sampleInput);
      expect(b.ok).toBe(false);
      if (b.ok) return;
      // Loud, not silent: the error names the action that DID get staged.
      expect(b.error.message).toContain("staged as stage-002");
      expect(b.error.message).toContain("inter-proposal");

      // The proposal itself landed — only the tension write failed.
      const staged = await getStagedActionById(vault, "stage-002");
      expect(staged.ok && staged.value?.status).toBe("pending");
    });
  });
});
