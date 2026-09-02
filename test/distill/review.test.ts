// test/distill/review.test.ts
//
// Tests for `daftari distill --review <run_id>` (U9): batch-review and approve
// the pending proposals from a prior --propose run through the existing ratify
// path. Covers the three plan scenarios:
//   1. --review lists exactly that run's proposals (run_id filter) and, without
//      --yes, ratifies nothing (dry-run).
//   2. --review --yes approves every matched proposal via vault_ratify, lands
//      each doc, and advances U5's distill-state landed map.
//   3. An unknown run_id lists nothing and exits 0.
//
// A real staging → ratify round-trip is exercised on a copied sample vault
// (makeTempVault). proposals are staged directly via proposeAllClaims with a
// known run_id; the LLM extraction stage is not involved.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listStagedActions } from "../../src/curation/staged-actions.js";
import { runDistill } from "../../src/distill/cli.js";
import { readDistillState } from "../../src/distill/state.js";
import {
  captureStdout,
  makeClaim,
  stageRun,
  stageRunWithCorroboration,
} from "../helpers/distill-helpers.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("daftari distill --review (U9)", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  // -------------------------------------------------------------------------
  // Scenario 1: run_id filter + dry-run (no --yes ratifies nothing)
  // -------------------------------------------------------------------------

  it("lists exactly the run's pending proposals and ratifies nothing without --yes", async () => {
    const runA = "distill-run-aaaa";
    const runB = "distill-run-bbbb";
    const aMap = await stageRun(vault, "chat-a", runA, [
      makeClaim("alice-picked-rust", "aaaaaa01"),
      makeClaim("bob-picked-go", "aaaaaa02"),
    ]);
    const bMap = await stageRun(vault, "chat-b", runB, [makeClaim("carol-picked-zig", "bbbbbb01")]);

    const { code, out } = await captureStdout(() =>
      runDistill(["--vault", vault, "--review", runA]),
    );

    expect(code).toBe(0);
    // Lists exactly run A's two proposals...
    for (const path of Object.values(aMap)) expect(out).toContain(path);
    // ...and none of run B's.
    for (const path of Object.values(bMap)) expect(out).not.toContain(path);
    expect(out).toContain("2 pending proposal(s)");
    expect(out.toLowerCase()).toContain("dry-run");

    // Nothing was ratified — all three proposals are still pending.
    const pending = await listStagedActions(vault, "pending");
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value).toHaveLength(3);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Scenario 2: --yes approves every matched proposal + advances landed map
  // -------------------------------------------------------------------------

  it("approves all of a run via the ratify path and advances the distill landed map", async () => {
    const runA = "distill-run-cccc";
    const aMap = await stageRun(vault, "chat-c", runA, [
      makeClaim("db-is-postgres", "cccccc01"),
      makeClaim("cache-is-redis", "cccccc02"),
    ]);

    const { code, out } = await captureStdout(() =>
      runDistill(["--vault", vault, "--review", runA, "--yes", "--by", "human:tester"]),
    );

    expect(code).toBe(0);
    expect(out).toContain("approved:   2");
    expect(out).toContain("failed:     0");

    // Every matched proposal is no longer pending (ratified/applied).
    const pending = await listStagedActions(vault, "pending");
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value.filter((a) => a.runId === runA)).toHaveLength(0);

    // Each proposal's doc landed on disk at its target path.
    for (const path of Object.values(aMap)) {
      expect(existsSync(join(vault, path))).toBe(true);
    }

    // U5's landed map advanced: each claim_key maps to its landed path under
    // the STABLE source-id, so a later re-distill treats them as already-landed.
    const state = readDistillState(vault);
    const claims = state.sources["chat-c"]?.claims ?? {};
    for (const [claimKey, path] of Object.entries(aMap)) {
      expect(claims[claimKey]).toBe(path);
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Scenario 3: unknown run_id → empty list, exit 0
  // -------------------------------------------------------------------------

  it("reports no pending proposals and exits 0 for an unknown run_id", async () => {
    await stageRun(vault, "chat-d", "distill-run-dddd", [makeClaim("only-claim", "dddddd01")]);

    const { code, out } = await captureStdout(() =>
      runDistill(["--vault", vault, "--review", "distill-run-nope", "--yes"]),
    );

    expect(code).toBe(0);
    expect(out.toLowerCase()).toContain("no pending proposals");

    // The unrelated run's proposal is untouched.
    const pending = await listStagedActions(vault, "pending");
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value).toHaveLength(1);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Scenario 4 (R8): --auto-safe ratifies only the corroborated subset
  // -------------------------------------------------------------------------

  it("--auto-safe ratifies only proposals at/above the corroboration threshold", async () => {
    const runA = "distill-run-eeee";
    const hiClaim = makeClaim("hi-corroborated-claim", "eeeeee01");
    const loClaim = makeClaim("lo-corroborated-claim", "eeeeee02");
    const map = await stageRunWithCorroboration(
      vault,
      "chat-e",
      runA,
      [hiClaim, loClaim],
      new Set([hiClaim.statement]),
    );
    const hiPath = map[hiClaim.claim_key];
    const loPath = map[loClaim.claim_key];

    const { code } = await captureStdout(() =>
      runDistill([
        "--vault",
        vault,
        "--review",
        runA,
        "--auto-safe",
        "--corroboration-threshold",
        "0.8",
      ]),
    );

    expect(code).toBe(0);

    // The HI proposal ratified (no longer pending); the LO one stays queued.
    const pending = await listStagedActions(vault, "pending");
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    const stillPending = pending.value.filter((a) => a.runId === runA).map((a) => a.targetPath);
    expect(stillPending).toContain(loPath);
    expect(stillPending).not.toContain(hiPath);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Scenario 5 (R8): plain --yes ratifies everything, threshold ignored
  // -------------------------------------------------------------------------

  it("--yes ratifies all proposals regardless of corroboration", async () => {
    const runB = "distill-run-ffff";
    const hiClaim = makeClaim("another-hi-claim", "ffffff01");
    const loClaim = makeClaim("another-lo-claim", "ffffff02");
    await stageRunWithCorroboration(
      vault,
      "chat-f",
      runB,
      [hiClaim, loClaim],
      new Set([hiClaim.statement]),
    );

    const { code } = await captureStdout(() =>
      runDistill(["--vault", vault, "--review", runB, "--yes"]),
    );

    expect(code).toBe(0);

    // Both gone from pending — plain --yes ignores the corroboration gate.
    const pending = await listStagedActions(vault, "pending");
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value.filter((a) => a.runId === runB)).toHaveLength(0);
  }, 60_000);
});
