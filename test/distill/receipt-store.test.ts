import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DistillReceipt } from "../../src/distill/cost.js";
import { appendDistillReceipt, distillReceiptsPath } from "../../src/distill/receipt-store.js";
import { requireDefined } from "../../src/test-utils/require-defined.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

function receipt(runId: string): DistillReceipt {
  return {
    runId,
    model: "claude-haiku-4-5",
    provider: "openrouter",
    zdr: false,
    llmCalls: 3,
    claimsProduced: 5,
    truncated: false,
    approxCostUSD: 0.004,
    completedAt: "2026-08-17T00:00:00.000Z",
  };
}

describe("appendDistillReceipt", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => cleanupVault(vault));

  it("appends one JSON line per receipt, joinable by runId", async () => {
    const r1 = await appendDistillReceipt(vault, receipt("distill-A"));
    const r2 = await appendDistillReceipt(vault, receipt("distill-B"));
    expect(r1.ok && r2.ok).toBe(true);
    const lines = readFileSync(distillReceiptsPath(vault), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(requireDefined(lines[0])).runId).toBe("distill-A");
    expect(JSON.parse(requireDefined(lines[1])).runId).toBe("distill-B");
  });
});
