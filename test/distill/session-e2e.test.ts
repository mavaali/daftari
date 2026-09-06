// test/distill/session-e2e.test.ts
//
// End-to-end integration test for the R9 distill Claude-session
// confidence-gate flow. This proves the GATE WIRING (not the LLM): a session
// distilled in two sender-partitioned passes lands user-sourced knowledge
// wholesale, while assistant-inferred knowledge is gated by corroboration.
//
// The two passes are modelled by STAGING proposals directly via
// proposeAllClaims with two distinct runIds and sourceIds (s-user,
// s-assistant), mirroring review.test.ts. The real LLM extraction stage is not
// involved — corroboration is controlled deterministically by an injected
// overlapSearch stub keyed on the claim statement. The flow:
//   1. USER pass  → auto-ratified wholesale via `--review <user-run> --yes`.
//   2. ASSISTANT pass → gated via `--review <asst-run> --auto-safe
//      --corroboration-threshold 0.8`: corroborated (0.9) auto-ratifies, novel
//      (0.1) stays queued for a human.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listStagedActions } from "../../src/curation/staged-actions.js";
import { runDistill } from "../../src/distill/cli.js";
import {
  captureStdout,
  makeClaim,
  stageRun,
  stageRunWithCorroboration,
} from "../helpers/distill-helpers.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("daftari distill session E2E — sender-partitioned + corroboration gate (R9)", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("lands the user pass wholesale and gates the assistant pass by corroboration", async () => {
    // --- Pass 1: USER run. Two claims; corroboration irrelevant (--yes). -----
    const userRun = "run-user";
    const userMap = await stageRun(vault, "s-user", userRun, [
      makeClaim("mihir-prefers-vitest", "11111101"),
      makeClaim("mihir-uses-biome", "11111102"),
    ]);

    // --- Pass 2: ASSISTANT run. One HI (0.9), one LO/novel (0.1). -----------
    const asstRun = "run-asst";
    const hiClaim = makeClaim("assistant-corroborated-inference", "22222201");
    const loClaim = makeClaim("assistant-novel-inference", "22222202");
    const asstMap = await stageRunWithCorroboration(
      vault,
      "s-assistant",
      asstRun,
      [hiClaim, loClaim],
      new Set([hiClaim.statement]),
    );
    const hiPath = asstMap[hiClaim.claim_key];
    const loPath = asstMap[loClaim.claim_key];

    // R9 provenance intent: the two passes are independent. Distinct sourceIds
    // → distinct source-group folders → disjoint target-path sets.
    const userPaths = new Set(Object.values(userMap));
    const asstPaths = new Set(Object.values(asstMap));
    for (const p of userPaths) expect(asstPaths.has(p)).toBe(false);
    for (const p of asstPaths) expect(userPaths.has(p)).toBe(false);

    // --- Step 3: user pass ratified wholesale via --yes. --------------------
    const user = await captureStdout(() =>
      runDistill(["--vault", vault, "--review", userRun, "--yes"]),
    );
    expect(user.code).toBe(0);

    // --- Step 4: assistant pass gated by --auto-safe + threshold. -----------
    const asst = await captureStdout(() =>
      runDistill([
        "--vault",
        vault,
        "--review",
        asstRun,
        "--auto-safe",
        "--corroboration-threshold",
        "0.8",
      ]),
    );
    expect(asst.code).toBe(0);

    // --- Step 5: assert the gate outcomes via pending state. ----------------
    const pending = await listStagedActions(vault, "pending");
    expect(pending.ok).toBe(true);
    if (!pending.ok) return; // narrows the Result type for pending.value below
    const stillPending = pending.value;
    const pendingPaths = stillPending.map((a) => a.targetPath);

    // None of the user run's proposals remain pending (all ratified by --yes).
    expect(stillPending.filter((a) => a.runId === userRun)).toHaveLength(0);

    // Assistant HI claim (0.9 ≥ 0.8) ratified → no longer pending.
    expect(pendingPaths).not.toContain(hiPath);

    // Assistant LO/novel claim (0.1 < 0.8) still queued for a human — and it is
    // the ONLY assistant proposal left pending. Order-independent assertions.
    const asstPending = stillPending.filter((a) => a.runId === asstRun);
    expect(asstPending).toHaveLength(1);
    expect(asstPending.map((a) => a.targetPath)).toContain(loPath);

    // Ratified docs landed on disk: both user docs + the corroborated assistant doc.
    for (const path of Object.values(userMap)) {
      expect(existsSync(join(vault, path))).toBe(true);
    }
    expect(existsSync(join(vault, hiPath))).toBe(true);

    // The queued (novel) claim must NOT have been written to the vault — "still
    // pending" must map cleanly to "not yet on disk".
    expect(existsSync(join(vault, loPath))).toBe(false);
  }, 60_000);
});
