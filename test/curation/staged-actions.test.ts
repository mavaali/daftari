import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getStagedActionById,
  listStagedActions,
  materializeStagedActions,
  rebuildStagedActionsIndex,
  recordDecision,
  type StageActionInput,
  stageAction,
  stagedActionsPath,
  sweepExpiredActions,
} from "../../src/curation/staged-actions.js";
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
});
