import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wrap the real index-db module so we can count how many times openIndexDb is
// called. Everything else passes through unchanged. reindex.ts imports
// openIndexDb from this module, so the counter observes its real usage.
const openIndexDbCalls = { count: 0 };
vi.mock("../../src/storage/index-db.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/storage/index-db.js")>(
    "../../src/storage/index-db.js",
  );
  return {
    ...actual,
    openIndexDb: (...args: Parameters<typeof actual.openIndexDb>) => {
      openIndexDbCalls.count++;
      return actual.openIndexDb(...args);
    },
  };
});

import { indexDocument, reindexVault } from "../../src/search/reindex.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

describe("indexDocument DB open count (finding E5)", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("opens the index DB exactly once per incremental indexDocument", async () => {
    // Build the index first so indexDocument takes the incremental path
    // (not the empty-index full-reindex fallback).
    const built = await reindexVault(vault);
    expect(built.ok).toBe(true);

    const target = join(vault, "pricing/cirrus-capacity-tiers.md");
    await writeFile(
      target,
      "---\ntitle: Cirrus Capacity Tiers\ndomain: pricing\nstatus: draft\nconfidence: low\nupdated: 2026-05-20\ntags: []\n---\n\nfresh body text for the incremental index path.\n",
    );

    openIndexDbCalls.count = 0;
    const updated = await indexDocument(vault, "pricing/cirrus-capacity-tiers.md");
    expect(updated.ok).toBe(true);

    // The incremental write must open the index DB exactly once — not the
    // open -> count-check -> close -> reopen that finding E5 flagged.
    expect(openIndexDbCalls.count).toBe(1);
  }, 120_000);
});
