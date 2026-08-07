import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listTensions } from "../../src/curation/tension.js";
import { vaultAssert, vaultConsolidate } from "../../src/tools/positions.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const ALICE = {
  user: "alice",
  roleName: "writer",
  role: { read: ["*"], write: ["*"], promote: false, ratify: false },
};
const BOB = { ...ALICE, user: "bob" };
const CAROL_RATIFIER = {
  user: "carol",
  roleName: "ratifier",
  role: { read: ["*"], write: ["*"], promote: false, ratify: true },
};
const DOC = "pricing/retry-storms.md";

async function seedDoc(vault: string): Promise<void> {
  const r = await vaultWrite(vault, {
    path: DOC,
    body: "# Retry storms\n\nThe claim.\n",
    frontmatter: {
      title: "Retry storms",
      domain: "accumulation",
      collection: "pricing",
      status: "canonical",
      confidence: "high",
      created: "2026-08-01",
      provenance: "direct",
    },
    agent: "agent:seed",
  });
  if (!r.ok) throw r.error;
}

// Alice asserts, bob disputes: contested doc with pos-000 (legacy snapshot,
// assert), pos-001 (alice, assert), pos-002 (bob, dispute) and two open
// positional tensions (pos-000 x pos-002, pos-001 x pos-002).
async function contestedFixture(
  vault: string,
): Promise<{ snapshotPairId: string; alicePairId: string }> {
  await vaultAssert(vault, { path: DOC, stance: "assert", confidence: "high", agent: "a" }, ALICE);
  const r = await vaultAssert(
    vault,
    { path: DOC, stance: "dispute", confidence: "medium", agent: "b" },
    BOB,
  );
  if (!r.ok) throw r.error;
  const tensions = await listTensions(vault);
  if (!tensions.ok) throw tensions.error;
  const positional = tensions.value.filter((t) => t.kind === "positional");
  const withA = (a: string) => positional.find((t) => t.positionA === a);
  const t000 = withA("pos-000");
  const t001 = withA("pos-001");
  if (!t000?.id || !t001?.id) throw new Error("fixture: expected two positional tensions");
  return { snapshotPairId: t000.id, alicePairId: t001.id };
}

describe("vault_read contested_positions (U-7)", () => {
  let vault: string;
  beforeEach(async () => {
    vault = makeTempVault();
    await seedDoc(vault);
  });
  afterEach(() => cleanupVault(vault));

  it("contested-unratified doc: CONTESTED flag, LD-11 order, open tension ids, low confidence (mandated)", async () => {
    await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "a" },
      ALICE,
    );
    await vaultAssert(
      vault,
      { path: DOC, stance: "dispute", confidence: "medium", agent: "b" },
      BOB,
    );
    const read = await vaultRead(vault, DOC, ALICE);
    expect(read.ok).toBe(true);
    if (!read.ok) throw read.error;
    const block = read.value.contested_positions;
    expect(block?.flag).toBe("CONTESTED");
    // U-12: pos-000 (legacy snapshot) is minted by the first assert on this
    // legacy doc; high confidence (pos-000, pos-001) before medium (pos-002).
    expect(block?.positions.map((p) => p.id)).toEqual(["pos-000", "pos-001", "pos-002"]);
    // bob's dispute conflicts with BOTH live asserts (pos-000 and pos-001).
    expect(block?.open_tension_ids).toHaveLength(2);
    expect(block?.note).toContain("no consolidated view");
    expect(read.value.frontmatter.confidence).toBe("low"); // R-9 cap visible
  });

  it("legacy doc: no contested_positions key at all (mandated: byte-identical absence)", async () => {
    const read = await vaultRead(vault, DOC, ALICE);
    expect(read.ok).toBe(true);
    if (!read.ok) throw read.error;
    expect("contested_positions" in read.value).toBe(false);
  });

  it("doc whose only dispute was superseded: no key", async () => {
    await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "a" },
      ALICE,
    );
    await vaultAssert(vault, { path: DOC, stance: "dispute", confidence: "low", agent: "b" }, BOB);
    await vaultAssert(vault, { path: DOC, stance: "qualify", confidence: "low", agent: "b" }, BOB);
    const read = await vaultRead(vault, DOC, ALICE);
    if (!read.ok) throw read.error;
    expect("contested_positions" in read.value).toBe(false);
  });
});

describe("vault_read ratified_view (U-10, R-17)", () => {
  let vault: string;
  beforeEach(async () => {
    vault = makeTempVault();
    await seedDoc(vault);
  });
  afterEach(() => cleanupVault(vault));

  it("read after consolidation: RATIFIED flag, resolved dissent positions, note names dissent, contested_positions absent (mandated)", async () => {
    const { alicePairId } = await contestedFixture(vault);
    const c = await vaultConsolidate(
      vault,
      {
        path: DOC,
        stance: "assert",
        confidence: "medium",
        agent: "c",
        resolve_tension: { id: alicePairId, kind: "accepted", rationale: "standing dissent" },
      },
      CAROL_RATIFIER,
    );
    expect(c.ok).toBe(true);

    const read = await vaultRead(vault, DOC, ALICE);
    if (!read.ok) throw read.error;
    const rv = read.value.ratified_view;
    expect(rv?.flag).toBe("RATIFIED");
    expect(rv?.stance).toBe("assert");
    expect(rv?.confidence).toBe("medium");
    expect(rv?.ratified_by).toBe("carol");
    expect(rv?.ratified_at).toBeTruthy();
    expect(rv?.dissent.map((p) => p.id)).toEqual(["pos-002"]);
    expect(rv?.note).toContain("standing dissent");
    expect("contested_positions" in read.value).toBe(false);
    expect(read.value.frontmatter.confidence).toBe("medium");
  });

  it("dissent-empty ratified doc: dissent: [], no dissent clause in note", async () => {
    const c = await vaultConsolidate(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "c" },
      CAROL_RATIFIER,
    );
    expect(c.ok).toBe(true);

    const read = await vaultRead(vault, DOC, ALICE);
    if (!read.ok) throw read.error;
    const rv = read.value.ratified_view;
    expect(rv?.dissent).toEqual([]);
    expect(rv?.note).not.toContain("dissent");
  });

  it("C-1 re-contest honesty: new dispute after consolidation surfaces open_tension_ids + re-contest note; mirror confidence holds", async () => {
    await contestedFixture(vault);
    const c = await vaultConsolidate(
      vault,
      { path: DOC, stance: "assert", confidence: "medium", agent: "c" },
      CAROL_RATIFIER,
    );
    expect(c.ok).toBe(true);
    const dave = {
      user: "dave",
      roleName: "writer",
      role: { read: ["*"], write: ["*"], promote: false, ratify: false },
    };
    const disputeAgain = await vaultAssert(
      vault,
      { path: DOC, stance: "dispute", confidence: "low", agent: "d" },
      dave,
    );
    expect(disputeAgain.ok).toBe(true);

    const read = await vaultRead(vault, DOC, ALICE);
    if (!read.ok) throw read.error;
    const rv = read.value.ratified_view;
    expect(rv?.open_tension_ids.length).toBeGreaterThan(0);
    expect(rv?.note).toContain("re-contested");
    expect(read.value.frontmatter.confidence).toBe("medium"); // mirror unchanged (C-1)
  });

  it("fully-resolved ratified doc: open_tension_ids limited to genuinely open entries", async () => {
    const { snapshotPairId, alicePairId } = await contestedFixture(vault);
    const c = await vaultConsolidate(
      vault,
      {
        path: DOC,
        stance: "assert",
        confidence: "medium",
        agent: "c",
        resolve_tension: { id: alicePairId, kind: "accepted" },
      },
      CAROL_RATIFIER,
    );
    expect(c.ok).toBe(true);

    const read = await vaultRead(vault, DOC, ALICE);
    if (!read.ok) throw read.error;
    expect(read.value.ratified_view?.open_tension_ids).toEqual([snapshotPairId]);
  });

  it("legacy doc and unratified contested doc: no ratified_view key", async () => {
    const readLegacy = await vaultRead(vault, DOC, ALICE);
    if (!readLegacy.ok) throw readLegacy.error;
    expect("ratified_view" in readLegacy.value).toBe(false);

    await contestedFixture(vault);
    const readContested = await vaultRead(vault, DOC, ALICE);
    if (!readContested.ok) throw readContested.error;
    expect("ratified_view" in readContested.value).toBe(false);
    expect(readContested.value.contested_positions?.flag).toBe("CONTESTED");
  });

  it("hand-written dangling dissent id is omitted from the resolved list (raw frontmatter still carries it)", async () => {
    const w = await vaultWrite(vault, {
      path: DOC,
      body: "# Retry storms\n\nThe claim.\n",
      frontmatter: {
        positions: [],
        org_position: {
          stance: "assert",
          confidence: "medium",
          ratified_by: "carol",
          ratified_at: "2026-08-01",
          dissent: ["pos-999"],
        },
      },
      agent: "op",
    });
    expect(w.ok).toBe(true);

    const read = await vaultRead(vault, DOC, ALICE);
    if (!read.ok) throw read.error;
    expect(read.value.ratified_view?.dissent).toEqual([]);
    expect(read.value.raw.org_position).toMatchObject({ dissent: ["pos-999"] });
  });
});
