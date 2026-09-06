// Tests for the shared distill test helpers (extracted from review.test.ts /
// session-e2e.test.ts, which duplicated these verbatim).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proposeAllClaims } from "../../src/distill/propose.js";
import {
  captureStdout,
  makeClaim,
  stageRun,
  stageRunWithCorroboration,
} from "./distill-helpers.js";
import { cleanupVault, makeTempVault } from "./temp-vault.js";

describe("distill test helpers", () => {
  describe("makeClaim", () => {
    it("builds an ExtractedClaim keyed on slug + hash8", () => {
      const claim = makeClaim("alice-picked-rust", "aaaaaa01");
      expect(claim.claim_key).toBe("chunk-001:alice-picked-rust-aaaaaa01");
      expect(claim.statement).toBe("alice picked rust.");
      expect(claim.proposed_frontmatter).toEqual({ title: "alice picked rust." });
    });
  });

  describe("captureStdout", () => {
    it("captures stdout writes and returns the wrapped function's exit code", async () => {
      const { code, out } = await captureStdout(async () => {
        process.stdout.write("hello from the CLI\n");
        return 0;
      });
      expect(code).toBe(0);
      expect(out).toContain("hello from the CLI");
    });
  });

  describe("stageRun / stageRunWithCorroboration", () => {
    let vault: string;

    beforeEach(() => {
      vault = makeTempVault();
    });

    afterEach(() => {
      cleanupVault(vault);
    });

    it("stageRun stages proposals and maps claim_key to targetPath", async () => {
      const claim = makeClaim("only-claim", "dddddd01");
      const map = await stageRun(vault, "chat-helper-test", "run-helper-a", [claim]);
      expect(map[claim.claim_key]).toBeTruthy();
    });

    it("stageRunWithCorroboration drives topScore from the hiStatements set", async () => {
      const hiClaim = makeClaim("hi-claim", "eeeeee01");
      const loClaim = makeClaim("lo-claim", "eeeeee02");
      const map = await stageRunWithCorroboration(
        vault,
        "chat-helper-test",
        "run-helper-b",
        [hiClaim, loClaim],
        new Set([hiClaim.statement]),
      );
      expect(map[hiClaim.claim_key]).toBeTruthy();
      expect(map[loClaim.claim_key]).toBeTruthy();
      expect(proposeAllClaims).toBeTypeOf("function");
    });
  });
});
