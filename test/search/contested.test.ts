import { rmSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { addTension, resolveTension, tensionsPath } from "../../src/curation/tension.js";
import { clearContestedCache, contestedFor } from "../../src/search/contested.js";
import type { IndexDb } from "../../src/storage/index-db.js";
import { openIndexForActiveProvider, vaultReindex } from "../../src/tools/search.js";
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

  const readsOnlyPricing: AccessContext = {
    user: "t",
    roleName: "analyst",
    role: { read: ["pricing"], write: [], promote: false, ratify: false },
  };
  const readsBoth: AccessContext = {
    user: "t",
    roleName: "lead",
    role: {
      read: ["pricing", "competitive-intel"],
      write: [],
      promote: false,
      ratify: false,
    },
  };

  it("omits the annotation entirely when the counterpart's collection is unreadable", async () => {
    await logTension(vault);
    // DOC_A's counterpart is DOC_B (competitive-intel): unreadable ⇒ omit.
    expect(contestedFor(vault, db, DOC_A, readsOnlyPricing)).toBeNull();
    // Same role, hit on the readable counterpart of an unreadable doc:
    // DOC_B's counterpart is DOC_A (pricing): readable ⇒ annotate.
    expect(contestedFor(vault, db, DOC_B, readsOnlyPricing)).not.toBeNull();
    // A role reading both sees it from both sides.
    expect(contestedFor(vault, db, DOC_A, readsBoth)).not.toBeNull();
  });

  it("contestedCount counts only visible tensions", async () => {
    await logTension(vault); // counterpart competitive-intel (hidden)
    await logTension(vault, {
      sourceB: "pricing/enterprise-tier-launch.md",
      claimB: "tier launch contradicts credit pricing",
    }); // counterpart pricing (visible)
    const hit = contestedFor(vault, db, DOC_A, readsOnlyPricing);
    expect(hit?.contestedCount).toBe(1);
    expect(hit?.contested[0]?.counterpart).toBe("pricing/enterprise-tier-launch.md");
  });

  it("falls back to the first path segment when the counterpart is not indexed", async () => {
    await logTension(vault, {
      sourceB: "competitive-intel/deleted-since-logging.md",
      claimB: "gone but logged",
    });
    // Segment says competitive-intel: hidden from pricing-only, visible to both-reader.
    expect(contestedFor(vault, db, DOC_A, readsOnlyPricing)).toBeNull();
    expect(contestedFor(vault, db, DOC_A, readsBoth)).not.toBeNull();
  });

  it("sees a tension appended after a cached empty read (mtime bust, no manual clear)", async () => {
    expect(contestedFor(vault, db, DOC_A)).toBeNull(); // caches the absent log
    await logTension(vault); // creates the file — mtime state changes
    expect(contestedFor(vault, db, DOC_A)).not.toBeNull();
  });

  it("skips whole entries with a missing source and ignores non-entry garbage", () => {
    // Degraded-log contract: a hand-edited log with junk text and an entry
    // missing its Source A line must never annotate — not even the valid
    // side (Source B), which would otherwise join under a "." counterpart.
    writeFileSync(
      tensionsPath(vault),
      "this is not a tension entry, just stray prose\n" +
        "random - **Bold:** noise that matches no block format\n" +
        "\n" +
        "## 2026-07-12 — broken\n" +
        "- **Kind:** factual\n" +
        `- **Source B:** ${DOC_B} says something\n` +
        "- **Status:** unresolved\n",
    );
    expect(contestedFor(vault, db, DOC_B)).toBeNull();
    expect(contestedFor(vault, db, DOC_A)).toBeNull();
  });

  it("sees a resolution appended after a cached read", async () => {
    const entry = await logTension(vault);
    expect(contestedFor(vault, db, DOC_A)).not.toBeNull(); // caches the live entry
    await resolveTension(vault, entry.id as string, {
      resolved_at: new Date().toISOString(),
      resolved_by: "test",
      kind: "accepted",
    });
    expect(contestedFor(vault, db, DOC_A)).toBeNull();
  });

  it("indexes a self-tension once, not as two records", async () => {
    // An intra-document contradiction is a legitimate advisory record; it
    // must not double-count the hit it names twice.
    await logTension(vault, {
      sourceB: DOC_A,
      claimB: "the same doc also promises flat-rate credits",
    });
    const hit = contestedFor(vault, db, DOC_A);
    expect(hit?.contestedCount).toBe(1);
    expect(hit?.contested).toHaveLength(1);
    expect(hit?.contested[0]).toMatchObject({
      counterpart: DOC_A,
      claimSelf: "credits are consumption-priced",
      claimOther: "the same doc also promises flat-rate credits",
    });
  });

  it("fails closed on case-variant and unicode-variant logged paths", async () => {
    // Canonicalization is byte-exact: no case folding, no NFC normalization.
    // A variant path must never join the canonical hit (no annotation), and a
    // variant counterpart must hide, not disclose (segment fallback gates on
    // the variant string, which matches no role's read list exactly or at
    // worst the same collection — either way nothing new is revealed).
    await logTension(vault, { sourceA: "PRICING/Helios-Consumption-Pricing.md" });
    expect(contestedFor(vault, db, DOC_A)).toBeNull();

    rmSync(tensionsPath(vault), { force: true });
    clearContestedCache();

    // Unicode: a tension logged under the NFD form ("e" + combining acute)
    // never joins a hit whose canonical index path is the NFC form — the two
    // are different byte strings and canonicalRel does not normalize.
    const NFD = "pricing/de\u0301tail.md";
    const NFC = "pricing/d\u00e9tail.md";
    await logTension(vault, { sourceA: NFD });
    expect(contestedFor(vault, db, NFC)).toBeNull();
    expect(contestedFor(vault, db, DOC_A)).toBeNull();
  });
});
