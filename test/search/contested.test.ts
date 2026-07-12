import { rmSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { addTension, resolveTension, tensionsPath } from "../../src/curation/tension.js";
import { clearContestedCache, contestedFor } from "../../src/search/contested.js";
import { openIndexForActiveProvider, vaultReindex } from "../../src/tools/search.js";
import type { IndexDb } from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

// Two real fixture docs to hang tensions on.
const DOC_A = "pricing/helios-consumption-pricing.md";
const DOC_B = "competitive-intel/vega-insight-positioning.md";

async function logTension(
  vault: string,
  overrides: Partial<Parameters<typeof addTension>[1]> = {},
) {
  const result = await addTension(vault, {
    title: "pricing vs positioning",
    kind: "factual",
    sourceA: DOC_A,
    claimA: "credits are consumption-priced",
    sourceB: DOC_B,
    claimB: "Vega undercuts on flat pricing",
    loggedBy: "test",
    ...overrides,
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe("contested", () => {
  let vault: string;
  let db: IndexDb;

  beforeAll(async () => {
    vault = makeTempVault();
    const reindexed = await vaultReindex(vault);
    if (!reindexed.ok) throw reindexed.error;
    const opened = openIndexForActiveProvider(vault);
    if (!opened.ok) throw opened.error;
    db = opened.value;
  }, 60_000);

  afterAll(() => {
    db.close();
    cleanupVault(vault);
  });

  afterEach(() => {
    // Each test manages its own log; wipe both file and cache between cases.
    rmSync(tensionsPath(vault), { force: true });
    clearContestedCache();
  });

  it("joins a tension logged under an alias path to the canonical hit", async () => {
    await logTension(vault, { sourceA: "pricing/../pricing/helios-consumption-pricing.md" });
    const hit = contestedFor(vault, db, DOC_A);
    expect(hit).not.toBeNull();
    expect(hit?.contested[0]?.counterpart).toBe(DOC_B);
  });

  it("annotates both sides, with claimSelf/claimOther oriented per side", async () => {
    await logTension(vault);
    const a = contestedFor(vault, db, DOC_A);
    const b = contestedFor(vault, db, DOC_B);
    expect(a?.contested[0]).toMatchObject({
      counterpart: DOC_B,
      claimSelf: "credits are consumption-priced",
      claimOther: "Vega undercuts on flat pricing",
      kind: "factual",
    });
    expect(b?.contested[0]).toMatchObject({
      counterpart: DOC_A,
      claimSelf: "Vega undercuts on flat pricing",
      claimOther: "credits are consumption-priced",
    });
    expect(a?.contested[0]?.id).toBe(b?.contested[0]?.id);
  });

  it("does not annotate resolved tensions", async () => {
    const entry = await logTension(vault);
    clearContestedCache();
    const resolved = await resolveTension(vault, entry.id as string, {
      resolved_at: new Date().toISOString(),
      resolved_by: "test",
      kind: "accepted",
    });
    expect(resolved.ok).toBe(true);
    expect(contestedFor(vault, db, DOC_A)).toBeNull();
  });

  it("returns null when the log is absent and for uninvolved paths", async () => {
    expect(contestedFor(vault, db, DOC_A)).toBeNull();
    await logTension(vault);
    expect(contestedFor(vault, db, "pricing/no-such-doc.md")).toBeNull();
  });

  it("caps at 3 (date desc, then logged order desc) and reports the true total", async () => {
    // Four same-day tensions on DOC_A: the tiebreak is logged order.
    for (const n of [1, 2, 3, 4]) {
      await logTension(vault, { title: `t${n}`, claimB: `counter-claim ${n}` });
    }
    const hit = contestedFor(vault, db, DOC_A);
    expect(hit?.contestedCount).toBe(4);
    expect(hit?.contested).toHaveLength(3);
    // Most recently logged first.
    expect(hit?.contested.map((c) => c.claimOther)).toEqual([
      "counter-claim 4",
      "counter-claim 3",
      "counter-claim 2",
    ]);
  });

  it("orders by date desc before logged order", async () => {
    await logTension(vault, { date: "2026-07-12", claimB: "newer" });
    await logTension(vault, { date: "2026-07-01", claimB: "older" });
    const hit = contestedFor(vault, db, DOC_A);
    expect(hit?.contested.map((c) => c.claimOther)).toEqual(["newer", "older"]);
  });
});
