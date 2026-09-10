// test/distill/overlap-hint.integration.test.ts
//
// U8 follow-up (distill epic a28) — makeOverlapHinter's real search behavior
// over a live sqlite-vec+fastembed index. The unit test file
// (overlap-hint.test.ts) only covers the public shape by spying on
// vaultSearch; this file seeds an actual vault, reindexes it, and drives
// makeOverlapHinter(vaultRoot) end to end.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeOverlapHinter } from "../../src/distill/propose.js";
import { reindexVault } from "../../src/search/reindex.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const CREDIT_DOC = "pricing/helios-consumption-pricing.md";

describe("makeOverlapHinter (integration) — real seeded vault index", () => {
  let vault: string;

  beforeAll(async () => {
    vault = makeTempVault();
    const reindexed = await reindexVault(vault);
    if (!reindexed.ok) throw reindexed.error;
  }, 60_000);

  afterAll(() => {
    cleanupVault(vault);
  });

  it("returns the expected neighbor path for a statement matching an indexed doc", async () => {
    const hinter = makeOverlapHinter(vault);
    const hint = await hinter("Helios compute credit consumption pricing");

    expect(hint.paths).toContain(CREDIT_DOC);
    expect(hint.topScore).toBeGreaterThan(0);
  });

  it("does not surface the pricing doc for a statement unrelated to pricing", async () => {
    const hinter = makeOverlapHinter(vault);
    const hint = await hinter(
      "xyzzy quibbledorf nonsense statement about nothing in this vault at all",
    );

    // The vector ranker always surfaces its nearest neighbors, even for a
    // query with no real match — so we assert on what's absent (the pricing
    // doc, which has no semantic relation) rather than an empty result.
    expect(hint.paths).not.toContain(CREDIT_DOC);
  });
});
