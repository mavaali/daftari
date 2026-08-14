// test/distill/propose.test.ts
//
// Unit tests for the distill proposal emitter (U4).
//
// Strategy: use a temp vault dir for real staging assertions (the jsonl queue
// is the ground truth). LLM extraction is NOT exercised here — claims are
// constructed directly to keep tests deterministic.
//
// The tier-0 canonical gate fires at RATIFY time (vault_ratify), not at
// stage time. The emitter never emits status:canonical — it hardcodes
// draft/low/synthesized. The test below asserts that invariant directly on
// the emitted frontmatter. The tier-0 ratify gate is covered by the
// existing ratify tests.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listStagedActions } from "../../src/curation/staged-actions.js";
import type { ExtractedClaim } from "../../src/distill/extract.js";
import {
  DISTILL_COLLECTION,
  type ProposeOutcome,
  proposeAllClaims,
} from "../../src/distill/propose.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeClaim(overrides: Partial<ExtractedClaim> = {}): ExtractedClaim {
  return {
    claim_key: "chunk-001:the-team-chose-postgres-a1b2c3d4",
    statement: "The team chose Postgres for the new service.",
    proposed_frontmatter: { title: "The team chose Postgres for the new service." },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("proposeAllClaims (U4)", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-propose-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Scenario 1: one claim → one staged write action, correct frontmatter
  // -------------------------------------------------------------------------

  it("stages one write proposal per claim with draft/low/synthesized defaults and run_id", async () => {
    const claim = makeClaim();
    const runId = "run-test-abc123";

    const outcome: ProposeOutcome = await proposeAllClaims(vault, [claim], {
      sourceId: "chat-export-1",
      runId,
    });

    expect(outcome.proposed).toBe(1);
    expect(outcome.errors).toHaveLength(0);

    // Verify the action is durably in the queue.
    const listed = await listStagedActions(vault, "pending");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);

    const action = listed.value[0];
    if (!action) throw new Error("expected a staged action");
    expect(action.actionType).toBe("write");
    expect(action.proposedBy).toBe("agent:distill");
    expect(action.runId).toBe(runId);

    // The proposed_diff must have frontmatter + body.
    const diff = action.proposedDiff as Record<string, unknown>;
    const fm = diff.frontmatter as Record<string, unknown>;

    // Hardcoded distill defaults — the non-negotiable R3 invariants.
    expect(fm.status).toBe("draft");
    expect(fm.confidence).toBe("low");
    expect(fm.provenance).toBe("synthesized");
    expect(fm.proposed_by).toBe("agent:distill");
    expect(fm.collection).toBe(DISTILL_COLLECTION);
    expect(fm.domain).toBe("accumulation");

    // The title comes from the claim's proposed_frontmatter.
    expect(fm.title).toBe(claim.proposed_frontmatter.title);

    // Body must be a non-empty string containing the claim statement.
    expect(typeof diff.body).toBe("string");
    expect((diff.body as string).length).toBeGreaterThan(0);
    expect(diff.body as string).toContain(claim.statement);

    // Target path must be under the distill collection and end in the claim's
    // 8-char hash (the last segment of claim_key after the last "-").
    const hash8 = claim.claim_key.slice(-8);
    expect(action.targetPath).toMatch(new RegExp(`^${DISTILL_COLLECTION}/`));
    expect(action.targetPath).toMatch(new RegExp(`${hash8}\\.md$`));
  });

  // -------------------------------------------------------------------------
  // Scenario 2: emitter NEVER emits status:canonical — hardcodes draft
  // -------------------------------------------------------------------------

  it("always emits status:draft regardless of any caller expectation (R3 invariant)", async () => {
    // Simulate a caller that has crafted a claim with a title that says
    // "canonical" — the emitter must still produce status:draft.
    const claim = makeClaim({
      claim_key: "chunk-002:canonical-sounding-title-deadbeef",
      statement: "This claim sounds canonical but must be staged as draft.",
      proposed_frontmatter: { title: "Canonical sounding title" },
    });

    const outcome = await proposeAllClaims(vault, [claim], {
      sourceId: "chat-export-1",
      runId: "run-canonical-test",
    });
    expect(outcome.proposed).toBe(1);

    const listed = await listStagedActions(vault, "pending");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    const first = listed.value[0];
    if (!first) throw new Error("expected a staged action");
    const diff = first.proposedDiff as Record<string, unknown>;
    const fm = diff.frontmatter as Record<string, unknown>;

    // The emitter MUST NOT produce canonical — this is the R3 gate.
    expect(fm.status).toBe("draft");
    expect(fm.status).not.toBe("canonical");
    expect(fm.confidence).toBe("low");
    expect(fm.provenance).toBe("synthesized");
  });

  // -------------------------------------------------------------------------
  // Scenario 3: two claims targeting the same path → conflict surfaced
  // -------------------------------------------------------------------------

  it("surfaces a conflict when two claims derive the same target path", async () => {
    // Two claims that produce the same target path: same claim_key (same hash8
    // suffix) AND the same title (same slug prefix) → identical derived path.
    const sharedKey = "chunk-003:duplicate-path-claim-cafebabe";
    const sharedTitle = "The system uses an append-only log";
    const claim1 = makeClaim({
      claim_key: sharedKey,
      statement: "The system uses an append-only log for durability.",
      proposed_frontmatter: { title: sharedTitle },
    });
    const claim2 = makeClaim({
      claim_key: sharedKey,
      statement: "The system uses an append-only log for auditability.",
      proposed_frontmatter: { title: sharedTitle },
    });

    const outcome = await proposeAllClaims(vault, [claim1, claim2], {
      sourceId: "chat-export-1",
      runId: "run-conflict-test",
    });

    // Both proposals must land (neither wins last-write-wins).
    expect(outcome.proposed).toBe(2);
    expect(outcome.errors).toHaveLength(0);

    // At least one must report a conflict.
    const conflicted = outcome.results.filter((r) => r.conflicts_with.length > 0);
    expect(conflicted.length).toBeGreaterThanOrEqual(1);

    // Both proposals are pending in the queue.
    const listed = await listStagedActions(vault, "pending");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Scenario 4: performWrite is never called during distill (staging only)
  // -------------------------------------------------------------------------

  it("never calls performWrite — distill is staging-only, no direct writes", async () => {
    // Spy on the write module to confirm no direct write happens.
    const writeMod = await import("../../src/tools/write.js");
    const vaultWriteSpy = vi.spyOn(writeMod, "vaultWrite");

    const claim = makeClaim({
      claim_key: "chunk-004:no-direct-write-00facade",
      statement: "Distill must never write directly.",
      proposed_frontmatter: { title: "Distill must never write directly" },
    });

    await proposeAllClaims(vault, [claim], { sourceId: "chat-export-1", runId: "run-spy-test" });

    expect(vaultWriteSpy).not.toHaveBeenCalled();

    vaultWriteSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Scenario 5: empty title → claim_key slug used, never "memory" sentinel
  // -------------------------------------------------------------------------

  it("derives a non-'memory' path segment from claim_key when title is empty", async () => {
    const claim = makeClaim({
      claim_key: "chunk-005:service-uses-grpc-f1e2d3c4",
      statement: "The service exposes its API over gRPC.",
      proposed_frontmatter: { title: "" },
    });

    const outcome = await proposeAllClaims(vault, [claim], {
      sourceId: "chat-export-1",
      runId: "run-empty-title",
    });
    expect(outcome.proposed).toBe(1);
    expect(outcome.errors).toHaveLength(0);

    const [result] = outcome.results;
    if (!result) throw new Error("expected a result");

    // Must not contain the langgraph "memory" sentinel segment.
    expect(result.targetPath).not.toMatch(/\/memory--/);
    // Must contain a slug derived from the claim_key (the hash8 suffix is a
    // substring of claim_key and must appear in the path).
    const hash8 = claim.claim_key.slice(-8);
    expect(result.targetPath).toMatch(new RegExp(`${hash8}\\.md$`));
    // Path must be under the distill collection.
    expect(result.targetPath).toMatch(new RegExp(`^${DISTILL_COLLECTION}/`));
  });

  // -------------------------------------------------------------------------
  // Empty input: no proposals, no errors
  // -------------------------------------------------------------------------

  it("returns zero proposed and no errors for an empty claim list", async () => {
    const outcome = await proposeAllClaims(vault, [], {
      sourceId: "chat-export-1",
      runId: "run-empty",
    });
    expect(outcome.proposed).toBe(0);
    expect(outcome.errors).toHaveLength(0);
    expect(outcome.results).toHaveLength(0);
  });
});
