// test/distill/idempotency.test.ts
//
// U5 — claim-level idempotency. Re-distilling a source upserts by claim-key
// instead of minting duplicate siblings (R4).
//
// Strategy: real assertions against a temp vault + the durable staged-actions
// queue (listStagedActions reads the jsonl back). Claims are constructed
// directly — no LLM. Ratification is simulated via recordLandedClaim, the
// hook the batch-ratify path (U9) will call after a proposal lands.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listStagedActions } from "../../src/curation/staged-actions.js";
import type { ExtractedClaim } from "../../src/distill/extract.js";
import type { ProposeOutcome } from "../../src/distill/propose.js";
import {
  type DistillUpsertOutcome,
  distillUpsert,
  readDistillState,
  recordLandedClaim,
} from "../../src/distill/state.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOURCE_ID = "team-chat-export";

// claim_key format is `<anchor>:<slug>-<hash8>` (U3 contract). An edited
// statement keeps the anchor+slug prefix but changes the trailing hash8.
const CLAIM_A: ExtractedClaim = {
  claim_key: "msg-001:alice-prefers-tea-aaaa1111",
  statement: "Alice prefers tea for the morning sync.",
  proposed_frontmatter: { title: "Alice prefers tea for the morning sync" },
};

const CLAIM_A_EDITED: ExtractedClaim = {
  claim_key: "msg-001:alice-prefers-tea-bbbb2222",
  statement: "Alice prefers tea for the afternoon sync.",
  proposed_frontmatter: { title: "Alice prefers tea for the afternoon sync" },
};

const CLAIM_B: ExtractedClaim = {
  claim_key: "msg-002:bob-owns-the-deploy-checklist-cccc3333",
  statement: "Bob owns the deploy checklist.",
  proposed_frontmatter: { title: "Bob owns the deploy checklist" },
};

const CLAIM_C: ExtractedClaim = {
  claim_key: "msg-003:standup-moves-to-nine-dddd4444",
  statement: "Standup moves to nine.",
  proposed_frontmatter: { title: "Standup moves to nine" },
};

const CONTENT_V1 = "alice: tea for the morning sync please\nbob: I own the deploy checklist\n";
const CONTENT_V2 = "alice: tea for the afternoon sync please\nbob: I own the deploy checklist\n";
const CONTENT_V3 =
  "alice: tea for the morning sync please\nbob: I own the deploy checklist\ncarol: standup moves to nine\n";

async function run(
  vault: string,
  content: string,
  claims: ExtractedClaim[],
  runId: string,
): Promise<DistillUpsertOutcome> {
  const res = await distillUpsert(vault, {
    sourceId: SOURCE_ID,
    sourceContent: content,
    claims,
    runId,
  });
  expect(res.ok).toBe(true);
  if (!res.ok) throw res.error;
  return res.value;
}

// Simulate vault_ratify landing every proposal from this run: record each
// claim's landed path into the distill state (mark-after-land).
function ratifyAll(vault: string, propose: ProposeOutcome | null): void {
  if (!propose) throw new Error("expected proposals to ratify");
  for (const r of propose.results) {
    const rec = recordLandedClaim(vault, SOURCE_ID, r.claim_key, r.targetPath);
    expect(rec.ok).toBe(true);
  }
}

async function pendingActions(vault: string) {
  const listed = await listStagedActions(vault, "pending");
  expect(listed.ok).toBe(true);
  if (!listed.ok) throw listed.error;
  return listed.value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("distillUpsert (U5 idempotency)", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-idem-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Scenario 1: distill twice unchanged → run 2 stages 0 proposals
  // -------------------------------------------------------------------------

  it("stages zero proposals on a second run over unchanged content", async () => {
    const run1 = await run(vault, CONTENT_V1, [CLAIM_A, CLAIM_B], "run-001");
    expect(run1.noop).toBe(false);
    expect(run1.propose?.proposed).toBe(2);
    expect(await pendingActions(vault)).toHaveLength(2);

    // The durable source ref is keyed on the stable source-id, not the run-id.
    const [first] = await pendingActions(vault);
    if (!first) throw new Error("expected a staged action");
    const fm = (first.proposedDiff as { frontmatter: Record<string, unknown> }).frontmatter;
    expect(fm.sources).toEqual([`distill:${SOURCE_ID}#${CLAIM_A.claim_key}`]);

    const run2 = await run(vault, CONTENT_V1, [CLAIM_A, CLAIM_B], "run-002");
    expect(run2.noop).toBe(true);
    expect(run2.propose).toBeNull();

    // The durable queue gained nothing.
    expect(await pendingActions(vault)).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Scenario 2: one claim edited → exactly one update-in-place proposal
  // -------------------------------------------------------------------------

  it("stages exactly one update-in-place proposal for an edited claim", async () => {
    const run1 = await run(vault, CONTENT_V1, [CLAIM_A, CLAIM_B], "run-001");
    ratifyAll(vault, run1.propose);
    const landedA = run1.propose?.results.find((r) => r.claim_key === CLAIM_A.claim_key);
    if (!landedA) throw new Error("expected claim A to be proposed");

    const before = await pendingActions(vault);

    const run2 = await run(vault, CONTENT_V2, [CLAIM_A_EDITED, CLAIM_B], "run-002");
    expect(run2.noop).toBe(false);

    // Exactly one proposal: the edited claim, targeting the SAME landed path.
    expect(run2.updated).toEqual([
      { claim_key: CLAIM_A_EDITED.claim_key, landedPath: landedA.targetPath },
    ]);
    expect(run2.skipped).toEqual([CLAIM_B.claim_key]);
    expect(run2.created).toHaveLength(0);
    expect(run2.propose?.proposed).toBe(1);

    const after = await pendingActions(vault);
    expect(after).toHaveLength(before.length + 1);
    const fresh = after.filter((a) => !before.some((b) => b.id === a.id));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.targetPath).toBe(landedA.targetPath);
  });

  // -------------------------------------------------------------------------
  // Scenario 3: a new claim appears → one new-write proposal, rest untouched
  // -------------------------------------------------------------------------

  it("stages one new-write proposal for a brand-new claim and skips the rest", async () => {
    const run1 = await run(vault, CONTENT_V1, [CLAIM_A, CLAIM_B], "run-001");
    ratifyAll(vault, run1.propose);
    const landedPaths = run1.propose?.results.map((r) => r.targetPath) ?? [];
    const before = await pendingActions(vault);

    const run2 = await run(vault, CONTENT_V3, [CLAIM_A, CLAIM_B, CLAIM_C], "run-002");
    expect(run2.noop).toBe(false);
    expect(run2.created).toEqual([CLAIM_C.claim_key]);
    expect(run2.skipped.sort()).toEqual([CLAIM_A.claim_key, CLAIM_B.claim_key].sort());
    expect(run2.updated).toHaveLength(0);
    expect(run2.propose?.proposed).toBe(1);

    const after = await pendingActions(vault);
    const fresh = after.filter((a) => !before.some((b) => b.id === a.id));
    expect(fresh).toHaveLength(1);
    // The new claim gets a NEW path — never a landed sibling's.
    expect(landedPaths).not.toContain(fresh[0]?.targetPath);
  });

  // -------------------------------------------------------------------------
  // Scenario 4: mark-after-land — processed only after ratify, not at emit
  // -------------------------------------------------------------------------

  it("marks a claim processed only after its proposal lands, not at emit time", async () => {
    const run1 = await run(vault, CONTENT_V1, [CLAIM_A], "run-001");
    const landed = run1.propose?.results.find((r) => r.claim_key === CLAIM_A.claim_key);
    if (!landed) throw new Error("expected claim A to be proposed");

    // After emit: the content hash is recorded (staging is durable) but the
    // claim is NOT in the processed map — it has not landed yet.
    const afterEmit = readDistillState(vault);
    const src = afterEmit.sources[SOURCE_ID];
    expect(src).toBeDefined();
    expect(src?.content_hash).not.toBe("");
    expect(src?.claims).toEqual({});

    // Simulate ratify: NOW the claim appears in the processed map.
    const rec = recordLandedClaim(vault, SOURCE_ID, CLAIM_A.claim_key, landed.targetPath);
    expect(rec.ok).toBe(true);
    const afterLand = readDistillState(vault);
    expect(afterLand.sources[SOURCE_ID]?.claims).toEqual({
      [CLAIM_A.claim_key]: landed.targetPath,
    });
  });

  // -------------------------------------------------------------------------
  // State file hygiene: absent or corrupt ⇒ empty default
  // -------------------------------------------------------------------------

  it("treats an absent or corrupt state file as the empty default", async () => {
    expect(readDistillState(vault)).toEqual({ sources: {} });

    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(join(vault, ".daftari", "distill-state.json"), "not json {{{");
    expect(readDistillState(vault)).toEqual({ sources: {} });
  });
});
