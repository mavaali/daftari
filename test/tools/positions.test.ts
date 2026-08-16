import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, openLockDb, releaseLock } from "../../src/access/locks.js";
import { readProvenanceLog } from "../../src/curation/provenance.js";
import {
  getStagedActionById,
  stageActionWithConflictCheck,
} from "../../src/curation/staged-actions.js";
import { listTensions, TENSIONS_LOCK_KEY } from "../../src/curation/tension.js";
import { registeredToolNames } from "../../src/server.js";
import { vaultAssert, vaultConsolidate, vaultPositions } from "../../src/tools/positions.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultRatify } from "../../src/tools/staged-actions.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const ALICE = {
  user: "alice",
  roleName: "writer",
  role: { read: ["*"], write: ["*"], promote: false, ratify: false },
};
const BOB = { ...ALICE, user: "bob" };
const PROPOSER = {
  user: "carol",
  roleName: "agent-proposer",
  role: { read: ["*"], write: ["*"], promote: false, ratify: false, proposeOnly: true },
};
const GUEST = { user: "eve", roleName: "guest", role: null };
const CAROL_RATIFIER = {
  user: "carol",
  roleName: "ratifier",
  role: { read: ["*"], write: ["*"], promote: false, ratify: true },
};
const PROPOSER_RATIFIER = {
  user: "dave",
  roleName: "agent-proposer",
  role: { read: ["*"], write: ["*"], promote: false, ratify: true, proposeOnly: true },
};

const DOC = "pricing/retry-storms.md";

async function seedDoc(vault: string, path = DOC): Promise<void> {
  const r = await vaultWrite(vault, {
    path,
    body: "# Retry storms\n\nThe claim.\n",
    frontmatter: {
      title: "Retry storms",
      domain: "accumulation",
      collection: path.split("/")[0],
      status: "canonical",
      confidence: "high",
      created: "2026-08-01",
      provenance: "direct",
    },
    agent: "agent:seed",
  });
  if (!r.ok) throw r.error;
}

// Task-2 fixture recipe (plan Step 2.2): legacy doc -> alice assert -> bob
// dispute -> contested doc with pos-000 (legacy snapshot), pos-001 (alice
// assert), pos-002 (bob dispute), confidence low, two open positional
// tensions (pos-000 x pos-002, pos-001 x pos-002).
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

describe("vault_assert (U-4)", () => {
  let vault: string;
  beforeEach(async () => {
    vault = makeTempVault();
    await seedDoc(vault);
  });
  afterEach(() => cleanupVault(vault));

  it("registers vault_assert and vault_positions", () => {
    expect(registeredToolNames()).toContain("vault_assert");
    expect(registeredToolNames()).toContain("vault_positions");
  });

  it("happy path: alice asserts on a legacy doc — pos-001, provenance principal, no tension", async () => {
    const r = await vaultAssert(
      vault,
      {
        path: DOC,
        stance: "assert",
        statement: "floor causes storms",
        confidence: "high",
        agent: "agent:alice-cli",
      },
      ALICE,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.action).toBe("assert");
    expect(r.value.position?.id).toBe("pos-001");
    expect(r.value.position?.principal).toBe("alice");
    expect(r.value.contested).toBe(false);
    expect(r.value.tension_ids).toEqual([]);
    expect(r.value.commit).toBeTruthy();

    const read = await vaultRead(vault, DOC);
    // LD-24: pos-000 (legacy snapshot, U-12) is minted first, so length is 2.
    expect(read.ok && read.value.frontmatter.positions).toHaveLength(2);
    expect(read.ok && read.value.frontmatter.confidence).toBe("high"); // uncontested: untouched

    const log = await readProvenanceLog(vault);
    if (!log.ok) throw log.error;
    const entry = log.value.find((e) => e.tool === "vault_assert");
    expect(entry?.principal).toBe("alice");
    expect(entry?.action).toBe("assert");
  });

  it("bob disputes → contested, confidence capped low, one positional tension (mandated)", async () => {
    await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "a" },
      ALICE,
    );
    const r = await vaultAssert(
      vault,
      {
        path: DOC,
        stance: "dispute",
        statement: "storms predate the floor",
        confidence: "medium",
        agent: "b",
      },
      BOB,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.contested).toBe(true);
    // LD-24: bob's dispute (pos-002) now conflicts with BOTH pos-000 (the
    // legacy snapshot, U-12) and pos-001 (alice) — two positional tensions.
    expect(r.value.tension_ids).toHaveLength(2);

    const read = await vaultRead(vault, DOC);
    expect(read.ok && read.value.frontmatter.confidence).toBe("low"); // R-9 cap
    expect(read.ok && read.value.frontmatter.contested).toBe(true);

    const tensions = await listTensions(vault);
    if (!tensions.ok) throw tensions.error;
    const t = tensions.value.filter((x) => x.kind === "positional");
    expect(t).toHaveLength(2);
    for (const tension of t) {
      expect(tension.sourceA).toBe(DOC);
      expect(tension.sourceB).toBe(DOC);
      expect(tension.loggedBy).toBe("bob"); // DN-3
      expect(tension.positionB).toBe("pos-002");
    }
    expect(t.map((x) => x.positionA).sort()).toEqual(["pos-000", "pos-001"]);
  });

  it("alice re-asserts → pos-003 supersedes pos-001, bob untouched, no duplicate tension (mandated)", async () => {
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
    const r = await vaultAssert(
      vault,
      {
        path: DOC,
        stance: "assert",
        statement: "updated wording",
        confidence: "medium",
        agent: "a",
      },
      ALICE,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.position?.id).toBe("pos-003");
    expect(r.value.superseded_position_id).toBe("pos-001");
    // LD-24: (pos-000,pos-002) and (pos-001,pos-002) already tensioned from
    // bob's dispute against BOTH live asserts (pos-000 = legacy snapshot,
    // U-12); (pos-002,pos-003) is the one NEW live pair from alice's re-assert.
    const tensions = await listTensions(vault);
    if (!tensions.ok) throw tensions.error;
    const pairs = tensions.value
      .filter((x) => x.kind === "positional")
      .map((x) => `${x.positionA}/${x.positionB}`)
      .sort();
    expect(pairs).toEqual(["pos-000/pos-002", "pos-001/pos-002", "pos-002/pos-003"]);

    const read = await vaultRead(vault, DOC);
    if (!read.ok) throw read.error;
    const bobPos = read.value.frontmatter.positions?.find((p) => p.id === "pos-002");
    expect(bobPos?.superseded_by).toBeNull();
    expect(bobPos?.principal).toBe("bob");
  });

  it("qualify never conflicts", async () => {
    await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "a" },
      ALICE,
    );
    const r = await vaultAssert(
      vault,
      { path: DOC, stance: "qualify", confidence: "low", agent: "b" },
      BOB,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.contested).toBe(false);
    expect(r.value.tension_ids).toEqual([]);
  });

  it("propose-only role: lands as a staged write, file untouched, no tension (mandated)", async () => {
    const r = await vaultAssert(
      vault,
      { path: DOC, stance: "dispute", confidence: "medium", agent: "c" },
      PROPOSER,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.action).toBe("staged");
    expect(r.value.staged_id).toMatch(/^stage-/);
    expect(r.value.commit).toBeNull();

    const read = await vaultRead(vault, DOC);
    expect(read.ok && read.value.frontmatter.positions).toBeNull(); // nothing written

    const action = await getStagedActionById(vault, r.value.staged_id as string);
    if (!action.ok) throw action.error;
    expect(action.value?.actionType).toBe("write");
    const diff = action.value?.proposedDiff as { frontmatter: { positions: unknown[] } };
    // LD-24: pos-000 (legacy snapshot, U-12) is included in the staged
    // payload alongside carol's pos-001.
    expect(diff.frontmatter.positions).toHaveLength(2);

    const tensions = await listTensions(vault);
    expect(tensions.ok && tensions.value.filter((x) => x.kind === "positional")).toEqual([]);
  });

  it("impersonation: alice passing principal 'bob' is rejected, nothing written (mandated)", async () => {
    const r = await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "a", principal: "bob" },
      ALICE,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("another principal");
    const read = await vaultRead(vault, DOC);
    expect(read.ok && read.value.frontmatter.positions).toBeNull();
  });

  it("guest (null role) is denied", async () => {
    const r = await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "e" },
      GUEST,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("access denied");
  });

  it("operator mode (no access): principal argument required, then recorded verbatim", async () => {
    const missing = await vaultAssert(vault, {
      path: DOC,
      stance: "assert",
      confidence: "high",
      agent: "op",
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.message).toContain("principal");

    const r = await vaultAssert(vault, {
      path: DOC,
      stance: "assert",
      confidence: "high",
      agent: "op",
      principal: "carol",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.position?.principal).toBe("carol");
  });

  it("nonexistent path errs; alias path resolves to one canonical position set (#127/#128)", async () => {
    const missing = await vaultAssert(
      vault,
      { path: "pricing/nope.md", stance: "assert", confidence: "low", agent: "a" },
      ALICE,
    );
    expect(missing.ok).toBe(false);

    await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "a" },
      ALICE,
    );
    const aliased = await vaultAssert(
      vault,
      {
        path: "pricing/../pricing/retry-storms.md",
        stance: "assert",
        confidence: "medium",
        agent: "a",
      },
      ALICE,
    );
    expect(aliased.ok).toBe(true);
    if (!aliased.ok) throw aliased.error;
    expect(aliased.value.path).toBe(DOC);
    expect(aliased.value.superseded_position_id).toBe("pos-001"); // same set, not a second one
  });
});

describe("vault_assert pos-000 legacy snapshot (U-12, C-2)", () => {
  let vault: string;
  beforeEach(async () => {
    vault = makeTempVault();
    await seedDoc(vault);
  });
  afterEach(() => cleanupVault(vault));

  it("first assert on a legacy doc snapshots pos-000 (unknown, prior confidence/created)", async () => {
    const before = await vaultRead(vault, DOC);
    if (!before.ok) throw before.error;
    const priorUpdated = before.value.frontmatter.updated;

    const r = await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "medium", agent: "op", principal: "carol" },
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.contested).toBe(false);
    expect(r.value.tension_ids).toEqual([]);

    const read = await vaultRead(vault, DOC);
    if (!read.ok) throw read.error;
    const positions = read.value.frontmatter.positions;
    expect(positions).toHaveLength(2);
    expect(positions?.[0]).toMatchObject({
      id: "pos-000",
      principal: "unknown",
      stance: "assert",
      confidence: "high", // the doc's prior authored confidence
      created: priorUpdated, // the doc's prior updated date
    });
    expect(positions?.[1]).toMatchObject({ id: "pos-001", principal: "carol" });
  });

  it("first dispute on a legacy doc: contested, capped low, exactly ONE positional tension naming pos-000/pos-001", async () => {
    const r = await vaultAssert(
      vault,
      { path: DOC, stance: "dispute", confidence: "medium", agent: "op", principal: "carol" },
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.contested).toBe(true);
    expect(r.value.tension_ids).toHaveLength(1);

    const read = await vaultRead(vault, DOC);
    if (!read.ok) throw read.error;
    expect(read.value.frontmatter.confidence).toBe("low");

    const tensions = await listTensions(vault);
    if (!tensions.ok) throw tensions.error;
    const t = tensions.value.filter((x) => x.kind === "positional");
    expect(t).toHaveLength(1);
    expect(t[0]?.positionA).toBe("pos-000");
    expect(t[0]?.positionB).toBe("pos-001");
    // statement null → claim falls back to "<title> — assert (<confidence>)"
    expect(t[0]?.claimA).toBe("Retry storms — assert (high)");
  });

  it("assert on a doc with explicit positions: [] (already opted in) → NO pos-000", async () => {
    const opted = "pricing/opted-in.md";
    const seeded = await vaultWrite(
      vault,
      {
        path: opted,
        body: "# Opted\n\nx.\n",
        frontmatter: {
          title: "Opted",
          domain: "accumulation",
          collection: "pricing",
          status: "canonical",
          confidence: "high",
          created: "2026-08-01",
          provenance: "direct",
          positions: [],
        },
        agent: "agent:seed",
      },
      undefined,
    );
    if (!seeded.ok) throw seeded.error;

    const r = await vaultAssert(
      vault,
      { path: opted, stance: "assert", confidence: "high", agent: "op", principal: "carol" },
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;

    const read = await vaultRead(vault, opted);
    if (!read.ok) throw read.error;
    expect(read.value.frontmatter.positions).toHaveLength(1);
    expect(read.value.frontmatter.positions?.[0]?.id).toBe("pos-001");
  });

  it("reserved principal, operator mode: principal 'unknown' is rejected, nothing written", async () => {
    const r = await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "op", principal: "unknown" },
      undefined,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("reserved");

    const read = await vaultRead(vault, DOC);
    expect(read.ok && read.value.frontmatter.positions).toBeNull();
  });

  it("reserved principal, authenticated: access.user 'unknown' is rejected", async () => {
    const UNKNOWN_USER = {
      user: "unknown",
      roleName: "writer",
      role: { read: ["*"], write: ["*"], promote: false, ratify: false },
    };
    const r = await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "op" },
      UNKNOWN_USER,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("reserved");
  });

  it("second principal's assert on the now-positioned doc mints NO second snapshot", async () => {
    await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "op", principal: "carol" },
      undefined,
    );
    const r = await vaultAssert(
      vault,
      { path: DOC, stance: "dispute", confidence: "medium", agent: "op", principal: "dave" },
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;

    const read = await vaultRead(vault, DOC);
    if (!read.ok) throw read.error;
    const ids = (read.value.frontmatter.positions ?? []).map((p) => p.id);
    expect(ids.filter((id) => id === "pos-000")).toHaveLength(1);
    expect(ids).toEqual(["pos-000", "pos-001", "pos-002"]);
  });

  it("propose-only role's first assert on a legacy doc: staged payload carries BOTH pos-000 and the proposer's pos-001", async () => {
    const r = await vaultAssert(
      vault,
      { path: DOC, stance: "dispute", confidence: "medium", agent: "c" },
      PROPOSER,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.action).toBe("staged");

    const read = await vaultRead(vault, DOC);
    expect(read.ok && read.value.frontmatter.positions).toBeNull(); // file untouched

    const action = await getStagedActionById(vault, r.value.staged_id as string);
    if (!action.ok) throw action.error;
    const diff = action.value?.proposedDiff as {
      frontmatter: { positions: Array<{ id: string; principal: string }> };
    };
    expect(diff.frontmatter.positions).toHaveLength(2);
    expect(diff.frontmatter.positions[0]).toMatchObject({ id: "pos-000", principal: "unknown" });
    expect(diff.frontmatter.positions[1]).toMatchObject({ id: "pos-001", principal: "carol" });
  });
});

describe("vault_consolidate (U-10)", () => {
  let vault: string;
  beforeEach(async () => {
    vault = makeTempVault();
    await seedDoc(vault);
  });
  afterEach(() => cleanupVault(vault));

  it("registers vault_consolidate", () => {
    expect(registeredToolNames()).toContain("vault_consolidate");
  });

  it("mandated: ratifier consolidates with resolve_tension — org_position, mirrored confidence, tension resolved (mandated)", async () => {
    const { alicePairId, snapshotPairId } = await contestedFixture(vault);
    const r = await vaultConsolidate(
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
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.action).toBe("consolidate");
    expect(r.value.org_position).toMatchObject({
      stance: "assert",
      confidence: "medium",
      ratified_by: "carol",
      dissent: ["pos-002"],
    });
    expect(r.value.org_position.ratified_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.value.confidence).toBe("medium");
    expect(r.value.contested).toBe(true); // LD-21: live set unchanged
    expect(r.value.resolved_tension_id).toBe(alicePairId);
    expect(r.value.resolve_error).toBeUndefined();
    expect(r.value.commit).toBeTruthy();

    const read = await vaultRead(vault, DOC);
    if (!read.ok) throw read.error;
    expect(read.value.frontmatter.confidence).toBe("medium"); // R-9 cap CLEARED by the mirror
    expect(read.value.frontmatter.org_position).toMatchObject({
      stance: "assert",
      confidence: "medium",
      ratified_by: "carol",
    });

    const tensions = await listTensions(vault);
    if (!tensions.ok) throw tensions.error;
    const resolved = tensions.value.find((t) => t.id === alicePairId);
    expect(resolved?.resolved).toBe(true);
    expect(resolved?.resolution?.kind).toBe("accepted");
    expect(resolved?.resolution?.resolved_by).toBe("carol");
    const other = tensions.value.find((t) => t.id === snapshotPairId);
    expect(other?.resolved).toBe(false); // the OTHER tension stays open

    const log = await readProvenanceLog(vault);
    if (!log.ok) throw log.error;
    const entry = log.value.find((e) => e.tool === "vault_consolidate");
    expect(entry?.action).toBe("consolidate");
    expect(entry?.principal).toBe("carol");
  });

  it("dissent derivation is server-owned: assert-side dissent excludes pos-000; dispute-side includes it", async () => {
    await contestedFixture(vault);
    const asAssert = await vaultConsolidate(
      vault,
      { path: DOC, stance: "assert", confidence: "medium", agent: "c" },
      CAROL_RATIFIER,
    );
    expect(asAssert.ok).toBe(true);
    if (!asAssert.ok) throw asAssert.error;
    expect(asAssert.value.dissent).toEqual(["pos-002"]);

    const asDispute = await vaultConsolidate(
      vault,
      { path: DOC, stance: "dispute", confidence: "medium", agent: "c" },
      CAROL_RATIFIER,
    );
    expect(asDispute.ok).toBe(true);
    if (!asDispute.ok) throw asDispute.error;
    expect(asDispute.value.dissent).toEqual(["pos-000", "pos-001"]);
  });

  it("mandated: non-ratifier is denied, file unchanged", async () => {
    await contestedFixture(vault);
    const r = await vaultConsolidate(
      vault,
      { path: DOC, stance: "assert", confidence: "medium", agent: "c" },
      ALICE,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("cannot consolidate");

    const read = await vaultRead(vault, DOC);
    if (!read.ok) throw read.error;
    expect(read.value.frontmatter.org_position).toBeNull();
  });

  it("mandated: 'accepted' with empty dissent errs, nothing written (LD-19)", async () => {
    const { alicePairId } = await contestedFixture(vault);
    // Bob re-asserts (supersedes his own live dispute) — the tension stays
    // open, but the live set has no dispute left, so dissent is now empty.
    await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "medium", agent: "b" },
      BOB,
    );
    const r = await vaultConsolidate(
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
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("standing dissent");

    const read = await vaultRead(vault, DOC);
    if (!read.ok) throw read.error;
    expect(read.value.frontmatter.org_position).toBeNull();
  });

  it("DN-4: consolidate on an uncontested doc is allowed, dissent []; same on a fully legacy doc", async () => {
    await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "a" },
      ALICE,
    );
    const r = await vaultConsolidate(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "c" },
      CAROL_RATIFIER,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.dissent).toEqual([]);
    expect(r.value.confidence).toBe("high");

    const legacyPath = "pricing/legacy-doc.md";
    await seedDoc(vault, legacyPath);
    const legacy = await vaultConsolidate(
      vault,
      { path: legacyPath, stance: "assert", confidence: "high", agent: "c" },
      CAROL_RATIFIER,
    );
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw legacy.error;
    expect(legacy.value.dissent).toEqual([]);
    expect(legacy.value.contested).toBeNull(); // LD-21: positions stays null

    const read = await vaultRead(vault, legacyPath);
    if (!read.ok) throw read.error;
    expect(read.value.frontmatter.org_position).toMatchObject({ stance: "assert" });
  });

  it("resolve_tension scoping: non-positional/different-doc/already-resolved/invalid-kind all err, nothing written", async () => {
    const { alicePairId } = await contestedFixture(vault);

    const otherDocErr = await vaultConsolidate(
      vault,
      {
        path: DOC,
        stance: "assert",
        confidence: "medium",
        agent: "c",
        resolve_tension: { id: "tns-nonexistent", kind: "accepted" },
      },
      CAROL_RATIFIER,
    );
    expect(otherDocErr.ok).toBe(false);

    const invalidKind = await vaultConsolidate(
      vault,
      {
        path: DOC,
        stance: "assert",
        confidence: "medium",
        agent: "c",
        resolve_tension: { id: alicePairId, kind: "invalid" },
      },
      CAROL_RATIFIER,
    );
    expect(invalidKind.ok).toBe(false);

    // Resolve it once via a legitimate call...
    const first = await vaultConsolidate(
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
    expect(first.ok).toBe(true);

    // ...then a second attempt to resolve the SAME (now-resolved) id errs.
    const alreadyResolved = await vaultConsolidate(
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
    expect(alreadyResolved.ok).toBe(false);

    const read = await vaultRead(vault, DOC);
    if (!read.ok) throw read.error;
    expect(read.value.frontmatter.org_position).toMatchObject({ ratified_by: "carol" }); // from `first`
  });

  it("impersonation/identity: differing principal rejected; operator mode requires/records principal; 'unknown' reserved", async () => {
    await contestedFixture(vault);

    const impersonation = await vaultConsolidate(
      vault,
      { path: DOC, stance: "assert", confidence: "medium", agent: "c", principal: "dave" },
      CAROL_RATIFIER,
    );
    expect(impersonation.ok).toBe(false);
    if (!impersonation.ok) expect(impersonation.error.message).toContain("another principal");

    const missingPrincipal = await vaultConsolidate(vault, {
      path: DOC,
      stance: "assert",
      confidence: "medium",
      agent: "c",
    });
    expect(missingPrincipal.ok).toBe(false);
    if (!missingPrincipal.ok) expect(missingPrincipal.error.message).toContain("principal");

    const operatorOk = await vaultConsolidate(vault, {
      path: DOC,
      stance: "assert",
      confidence: "medium",
      agent: "c",
      principal: "carol",
    });
    expect(operatorOk.ok).toBe(true);
    if (operatorOk.ok) expect(operatorOk.value.org_position.ratified_by).toBe("carol");

    const reserved = await vaultConsolidate(vault, {
      path: DOC,
      stance: "assert",
      confidence: "medium",
      agent: "c",
      principal: "unknown",
    });
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.error.message).toContain("reserved");
  });

  it("LD-20: propose-only role is denied even with ratify: true, nothing staged", async () => {
    await contestedFixture(vault);
    const r = await vaultConsolidate(
      vault,
      { path: DOC, stance: "assert", confidence: "medium", agent: "c" },
      PROPOSER_RATIFIER,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("propose-only");

    const staged = await listTensions(vault); // no side effects at all
    if (!staged.ok) throw staged.error;
    const read = await vaultRead(vault, DOC);
    if (!read.ok) throw read.error;
    expect(read.value.frontmatter.org_position).toBeNull();
  });

  it("re-consolidation overwrites org_position with a new ratified_at, provenance diff records before/after", async () => {
    await contestedFixture(vault);
    const first = await vaultConsolidate(
      vault,
      { path: DOC, stance: "assert", confidence: "medium", agent: "c" },
      CAROL_RATIFIER,
    );
    expect(first.ok).toBe(true);

    const second = await vaultConsolidate(
      vault,
      { path: DOC, stance: "dispute", confidence: "high", agent: "c" },
      CAROL_RATIFIER,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw second.error;
    expect(second.value.org_position.stance).toBe("dispute");
    expect(second.value.org_position.confidence).toBe("high");

    const log = await readProvenanceLog(vault);
    if (!log.ok) throw log.error;
    const entries = log.value.filter((e) => e.tool === "vault_consolidate");
    expect(entries).toHaveLength(2);
    const diff = entries[1]?.frontmatter_diff as
      | Record<string, { before: unknown; after: unknown }>
      | undefined;
    expect(diff?.org_position).toBeDefined();
  });

  it("C-1 regression (write half): after consolidation, a new dispute never re-caps the mirrored confidence", async () => {
    await contestedFixture(vault);
    await vaultConsolidate(
      vault,
      { path: DOC, stance: "assert", confidence: "medium", agent: "c" },
      CAROL_RATIFIER,
    );
    const dave = { ...ALICE, user: "dave" };
    const r = await vaultAssert(
      vault,
      { path: DOC, stance: "dispute", confidence: "low", agent: "d" },
      dave,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.contested).toBe(true);
    expect(r.value.tension_ids.length).toBeGreaterThan(0);

    const read = await vaultRead(vault, DOC);
    if (!read.ok) throw read.error;
    expect(read.value.frontmatter.confidence).toBe("medium"); // cap does NOT re-apply
  });
});

describe("vault_positions (U-5)", () => {
  let vault: string;
  beforeEach(async () => {
    vault = makeTempVault();
    await seedDoc(vault);
  });
  afterEach(() => cleanupVault(vault));

  it("by path: live only by default; include_superseded returns all", async () => {
    await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "a" },
      ALICE,
    );
    await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "medium", agent: "a" },
      ALICE,
    );
    const live = await vaultPositions(vault, { path: DOC }, ALICE);
    expect(live.ok).toBe(true);
    if (!live.ok) throw live.error;
    // pos-000 (legacy snapshot, U-12) is also live — it is never superseded
    // by a different principal's assert.
    expect(live.value.positions.map((p) => p.position.id)).toEqual(["pos-000", "pos-002"]);
    const all = await vaultPositions(vault, { path: DOC, include_superseded: true }, ALICE);
    if (!all.ok) throw all.error;
    expect(all.value.positions).toHaveLength(3);
    const pos001 = all.value.positions.find((p) => p.position.id === "pos-001");
    expect(pos001?.position.superseded_by).toBe("pos-002");
    const pos000 = all.value.positions.find((p) => p.position.id === "pos-000");
    expect(pos000?.position.superseded_by).toBeNull();
  });

  it("by path on a legacy doc: empty list, not an error", async () => {
    const r = await vaultPositions(vault, { path: DOC }, ALICE);
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.positions).toEqual([]);
  });

  it("unreadable doc is 'not found'-shaped (no existence leak)", async () => {
    const scoped = {
      user: "sam",
      roleName: "scoped",
      role: { read: ["decisions"], write: [], promote: false, ratify: false },
    };
    const denied = await vaultPositions(vault, { path: DOC }, scoped);
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.message).toContain("not found");
    expect(denied.error.message).not.toContain("pricing");
  });

  it("by principal: unreadable docs silently omitted; no read grants denied", async () => {
    await seedDoc(vault, "decisions/other-claim.md");
    await vaultAssert(vault, { path: DOC, stance: "assert", confidence: "high", agent: "b" }, BOB);
    await vaultAssert(
      vault,
      { path: "decisions/other-claim.md", stance: "dispute", confidence: "low", agent: "b" },
      BOB,
    );

    const scoped = {
      user: "sam",
      roleName: "scoped",
      role: { read: ["decisions"], write: [], promote: false, ratify: false },
    };
    const r = await vaultPositions(vault, { principal: "bob" }, scoped);
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.positions.map((p) => p.path)).toEqual(["decisions/other-claim.md"]);

    const guest = await vaultPositions(vault, { principal: "bob" }, GUEST);
    expect(guest.ok).toBe(false);
  });

  it("exactly one of path|principal is required", async () => {
    expect((await vaultPositions(vault, {}, ALICE)).ok).toBe(false);
    expect((await vaultPositions(vault, { path: DOC, principal: "bob" }, ALICE)).ok).toBe(false);
  });
});

// Item 5: batch resolve within a ratified consolidation. The caller supplies
// no ids and no kind — both are server-derived from the ratification, and the
// recorded kind is the system-only `consolidated` (the disagreement persists,
// carried as dissent in org_position — neither superseded nor corrected nor
// blanket-accepted would be honest).
describe("vault_consolidate resolve_tensions: 'dissent' (batch)", () => {
  let vault: string;
  beforeEach(async () => {
    vault = makeTempVault();
    await seedDoc(vault);
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("one ratification resolves every open positional tension adjudicated by its dissent", async () => {
    const { snapshotPairId, alicePairId } = await contestedFixture(vault);

    const r = await vaultConsolidate(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "c", resolve_tensions: "dissent" },
      CAROL_RATIFIER,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.resolved_tension_ids.sort()).toEqual([snapshotPairId, alicePairId].sort());
    expect(r.value.resolve_errors).toEqual([]);

    const tensions = await listTensions(vault);
    expect(tensions.ok).toBe(true);
    if (!tensions.ok) return;
    for (const id of [snapshotPairId, alicePairId]) {
      const t = tensions.value.find((x) => x.id === id);
      expect(t?.resolved).toBe(true);
      expect(t?.resolution?.kind).toBe("consolidated");
      expect(t?.resolution?.resolved_by).toBe("carol");
      expect(t?.resolution?.rationale).toContain("dissent carried");
    }
  });

  it("chain-follows superseded dissent: same-stance re-mints qualify, stance flips stay open", async () => {
    await contestedFixture(vault);
    // bob re-mints the same dispute: pos-002 superseded by pos-003 (dispute).
    // The old tensions name pos-002 — their live chain end is pos-003, still
    // opposed and in dissent, so they qualify.
    const remint = await vaultAssert(
      vault,
      { path: DOC, stance: "dispute", confidence: "high", agent: "b" },
      BOB,
    );
    expect(remint.ok).toBe(true);

    const r = await vaultConsolidate(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "c", resolve_tensions: "dissent" },
      CAROL_RATIFIER,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const tensions = await listTensions(vault);
    expect(tensions.ok).toBe(true);
    if (!tensions.ok) return;
    const positional = tensions.value.filter((t) => t.kind === "positional");
    // Every positional tension on the doc was adjudicated by this dissent.
    expect(positional.every((t) => t.resolved)).toBe(true);
    expect(positional.every((t) => t.resolution?.kind === "consolidated")).toBe(true);
  });

  it("a stance flip makes the old pair moot — left open, not swept", async () => {
    await contestedFixture(vault);
    // bob flips to qualify: his dispute chain END is no longer opposed.
    const flip = await vaultAssert(
      vault,
      { path: DOC, stance: "qualify", confidence: "medium", agent: "b" },
      BOB,
    );
    expect(flip.ok).toBe(true);

    const r = await vaultConsolidate(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "c", resolve_tensions: "dissent" },
      CAROL_RATIFIER,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // No live dispute → empty dissent → nothing qualifies; the moot pairs
    // stay open for lint, because this ratification did not adjudicate them.
    expect(r.value.resolved_tension_ids).toEqual([]);

    const tensions = await listTensions(vault);
    expect(tensions.ok).toBe(true);
    if (!tensions.ok) return;
    expect(tensions.value.filter((t) => t.kind === "positional" && !t.resolved).length).toBe(2);
  });

  it("rejects resolve_tensions when ratifying 'qualify' — nothing is written", async () => {
    await contestedFixture(vault);
    const r = await vaultConsolidate(
      vault,
      { path: DOC, stance: "qualify", confidence: "low", agent: "c", resolve_tensions: "dissent" },
      CAROL_RATIFIER,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("qualify");

    const doc = await vaultRead(vault, DOC);
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    expect(doc.value.frontmatter.org_position ?? null).toBeNull();
  });

  it("composes with the single resolve_tension: the named id keeps its deliberate kind", async () => {
    const { snapshotPairId, alicePairId } = await contestedFixture(vault);

    const r = await vaultConsolidate(
      vault,
      {
        path: DOC,
        stance: "assert",
        confidence: "high",
        agent: "c",
        resolve_tension: { id: alicePairId, kind: "accepted" },
        resolve_tensions: "dissent",
      },
      CAROL_RATIFIER,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.resolved_tension_id).toBe(alicePairId);
    expect(r.value.resolved_tension_ids).toEqual([snapshotPairId]);

    const tensions = await listTensions(vault);
    expect(tensions.ok).toBe(true);
    if (!tensions.ok) return;
    expect(tensions.value.find((t) => t.id === alicePairId)?.resolution?.kind).toBe("accepted");
    expect(tensions.value.find((t) => t.id === snapshotPairId)?.resolution?.kind).toBe(
      "consolidated",
    );
  });

  it("reports per-id failures without unwinding the ratification", async () => {
    const { snapshotPairId, alicePairId } = await contestedFixture(vault);

    // A foreign holder pins the `__tensions__` lease; the injected sleep
    // does NOT release it, so each batch resolve fails after its bounded
    // retry — but the org_position write stands.
    const lockDbResult = openLockDb(vault);
    expect(lockDbResult.ok).toBe(true);
    if (!lockDbResult.ok) return;
    const lockDb = lockDbResult.value;
    const held = acquireLock(lockDb, TENSIONS_LOCK_KEY, "foreign-holder");
    expect(held.ok).toBe(true);

    const r = await vaultConsolidate(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "c", resolve_tensions: "dissent" },
      CAROL_RATIFIER,
      { sleep: async () => {}, jitterMs: () => 100 },
    );
    releaseLock(lockDb, TENSIONS_LOCK_KEY, "foreign-holder");
    lockDb.close();

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.resolved_tension_ids).toEqual([]);
    expect(r.value.resolve_errors.map((e) => e.id).sort()).toEqual(
      [snapshotPairId, alicePairId].sort(),
    );
    expect(r.value.org_position.stance).toBe("assert");
  });
});

// Item 5: the slice-3 §3.5 bounded jittered retry on `__tensions__` lease
// contention, applied to vault_assert's system-generated tension mints.
describe("vault_assert mint retry on tension-lease contention", () => {
  let vault: string;
  beforeEach(async () => {
    vault = makeTempVault();
    await seedDoc(vault);
    await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "a" },
      ALICE,
    );
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("retries a contended mint once after a jittered sleep and succeeds", async () => {
    const lockDbResult = openLockDb(vault);
    expect(lockDbResult.ok).toBe(true);
    if (!lockDbResult.ok) return;
    const lockDb = lockDbResult.value;
    const held = acquireLock(lockDb, TENSIONS_LOCK_KEY, "foreign-holder");
    expect(held.ok).toBe(true);

    const sleeps: number[] = [];
    const r = await vaultAssert(
      vault,
      { path: DOC, stance: "dispute", confidence: "medium", agent: "b" },
      BOB,
      {
        sleep: async (ms: number) => {
          sleeps.push(ms);
          releaseLock(lockDb, TENSIONS_LOCK_KEY, "foreign-holder");
        },
        jitterMs: () => 175,
      },
    );
    lockDb.close();

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tension_error).toBeUndefined();
    expect(r.value.tension_ids.length).toBeGreaterThan(0);
    expect(sleeps).toEqual([175]);
  });
});

// The multi-user sovereignty invariant under serve-style concurrency: however
// two racing asserts interleave, no position is EVER silently lost. Each call
// either succeeds — and its position is live on disk afterward — or fails
// LOUDLY (lease contention or a stale rejection that survived the one retry).
// The deterministic stale-window case is pinned in write.test.ts ("rejects a
// performFrontmatterWrite composed against a replaced TargetDocument"); this
// test pins the invariant across whatever interleaving the scheduler picks.
describe("concurrent asserts — no silent lost update", () => {
  let vault: string;
  beforeEach(async () => {
    vault = makeTempVault();
    await seedDoc(vault);
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("two racing asserts never silently drop a position", async () => {
    const [a, b] = await Promise.all([
      vaultAssert(vault, { path: DOC, stance: "assert", confidence: "high", agent: "a" }, ALICE),
      vaultAssert(vault, { path: DOC, stance: "dispute", confidence: "medium", agent: "b" }, BOB),
    ]);

    // At least one side must land.
    expect(a.ok || b.ok).toBe(true);

    const onDisk = await vaultPositions(vault, { path: DOC }, ALICE);
    expect(onDisk.ok).toBe(true);
    if (!onDisk.ok) return;
    const principals = onDisk.value.positions.map((p) => p.position.principal);

    for (const [result, principal] of [
      [a, "alice"],
      [b, "bob"],
    ] as const) {
      if (result.ok) {
        // A reported success whose position is not on disk is the silent
        // lost-update bug this slice fixes.
        expect(principals).toContain(principal);
      } else {
        // A loser must fail loudly — lease contention or a stale rejection —
        // never a generic swallow.
        expect(result.error.message).toMatch(/locked|stale/);
      }
    }
  }, 60_000);

  it("the forced delayed-writer race: assert's stale first attempt retries and both positions survive", async () => {
    // The deterministic end-to-end test #399 shipped without (in-process
    // racing lease windows always overlap, so Promise.all only exercises the
    // loud lock-contention path): bob's assert lands INSIDE alice's first
    // load, so alice's write is composed against pre-bob bytes with the
    // lease free — the exact silent-clobber window. The contentHash wire +
    // retryOnStale must reload and recompute, never erase bob.
    const { join } = await import("node:path");
    const { withInjectedRace } = await import("../helpers/inject-race.js");
    const result = await withInjectedRace(
      join(vault, DOC),
      async () => {
        const bob = await vaultAssert(
          vault,
          { path: DOC, stance: "dispute", confidence: "medium", agent: "b" },
          BOB,
        );
        if (!bob.ok) throw bob.error;
      },
      () =>
        vaultAssert(vault, { path: DOC, stance: "assert", confidence: "high", agent: "a" }, ALICE),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const onDisk = await vaultPositions(vault, { path: DOC }, ALICE);
    expect(onDisk.ok).toBe(true);
    if (!onDisk.ok) return;
    const principals = onDisk.value.positions.map((p) => p.position.principal).sort();
    // Both live — bob's interleaved dispute was never clobbered — and the
    // recomputed second attempt saw it: contested, with the tension minted.
    expect(principals).toEqual(["alice", "bob", "unknown"]);
    expect(result.value.contested).toBe(true);
    expect(result.value.tension_ids.length).toBeGreaterThan(0);
  }, 60_000);
});

// LD-13 ratify staleness guard (#recall-review): a propose-only assert stages
// proposedDiff.frontmatter.positions as a FULL array snapshotted at stage
// time. Without an anchor, vault_ratify replaying that snapshot through
// vaultWrite with no base_version silently overwrites whatever landed on the
// document between staging and ratification — deterministic, no concurrency
// needed. vault_ratify here is deliberately called WITHOUT an AccessContext
// (operator/stdio mode): that is the exact carve-out the LD-13
// foreign-position guard in write.ts does not cover ("Operator servers (no
// access) bypass"), and is also how every other vault_ratify test in
// test/tools/staged-actions.test.ts calls it — the default, not an edge case.
describe("vault_ratify — LD-13 base_version staleness guard", () => {
  let vault: string;
  beforeEach(async () => {
    vault = makeTempVault();
    await seedDoc(vault);
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("stale ratify is rejected loudly and never overwrites the intervening direct assert", async () => {
    // Monday: carol (propose-only) proposes. The snapshot she stages carries
    // pos-000 (legacy) + her own pos-001 — computed against the doc as it
    // stands right now, before bob ever touches it.
    const staged = await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "a" },
      PROPOSER,
    );
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw staged.error;

    const stagedAction = await getStagedActionById(vault, staged.value.staged_id as string);
    expect(stagedAction.ok).toBe(true);
    if (!stagedAction.ok) throw stagedAction.error;
    // The proposal is anchored to the doc's contentHash at stage time.
    expect(stagedAction.value?.baseVersion).toEqual(expect.any(String));

    // Tuesday: bob asserts directly. The doc has no proposals applied to it
    // yet, so bob's write lands at the same slot (pos-001) carol's stage-time
    // snapshot claimed — this is the collision that makes the clobber silent
    // rather than merely a length mismatch.
    const direct = await vaultAssert(
      vault,
      { path: DOC, stance: "dispute", confidence: "medium", agent: "b" },
      BOB,
    );
    expect(direct.ok).toBe(true);
    if (!direct.ok) throw direct.error;

    const beforeRatify = await vaultRead(vault, DOC);
    expect(beforeRatify.ok).toBe(true);
    if (!beforeRatify.ok) throw beforeRatify.error;
    expect(beforeRatify.value.frontmatter.positions).toEqual(
      expect.arrayContaining([expect.objectContaining({ principal: "bob", stance: "dispute" })]),
    );

    // Wednesday: a ratifier (operator mode, no access) approves carol's stale
    // Monday proposal.
    const ratified = await vaultRatify(vault, {
      id: staged.value.staged_id,
      decision: "approve",
      principal: "dave",
    });
    expect(ratified.ok).toBe(false);
    if (ratified.ok) return;
    expect(ratified.error.message).toContain("stale");
    // Actionable: names the proposal id and says the doc changed since staging.
    expect(ratified.error.message).toContain(staged.value.staged_id as string);
    expect(ratified.error.message).toMatch(/changed since/);

    // The action stays pending — no decision was recorded.
    const afterAction = await getStagedActionById(vault, staged.value.staged_id as string);
    expect(afterAction.ok && afterAction.value?.status).toBe("pending");

    // Bob's position is still live on disk — this is the actual regression
    // check: on main (no base_version), this same sequence silently replaces
    // it with carol's stale snapshot instead of rejecting.
    const after = await vaultRead(vault, DOC);
    expect(after.ok).toBe(true);
    if (!after.ok) throw after.error;
    expect(after.value.frontmatter.positions).toEqual(
      expect.arrayContaining([expect.objectContaining({ principal: "bob", stance: "dispute" })]),
    );
  }, 60_000);

  it("ratify of an unchanged doc still applies cleanly with base_version present", async () => {
    const staged = await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "a" },
      PROPOSER,
    );
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw staged.error;

    // Nothing else touches the document between staging and ratification.
    const ratified = await vaultRatify(vault, {
      id: staged.value.staged_id,
      decision: "approve",
      principal: "dave",
    });
    expect(ratified.ok).toBe(true);
    if (!ratified.ok) throw ratified.error;
    expect(ratified.value.applied).toBe(true);

    const after = await vaultRead(vault, DOC);
    expect(after.ok).toBe(true);
    if (!after.ok) throw after.error;
    expect(after.value.frontmatter.positions).toEqual(
      expect.arrayContaining([expect.objectContaining({ principal: "carol", stance: "assert" })]),
    );
  }, 60_000);

  it("a legacy staged action without base_version still ratifies (backward compat)", async () => {
    const before = await vaultRead(vault, DOC);
    expect(before.ok).toBe(true);
    if (!before.ok) throw before.error;

    // Simulate a proposal staged before this field existed: no baseVersion in
    // the input, so the durable record carries none (append-only — old jsonl
    // lines never gain one retroactively).
    const staged = await stageActionWithConflictCheck(vault, {
      actionType: "write",
      targetPath: DOC,
      proposedBy: "agent:legacy",
      rationale: "legacy proposal predating the base_version field",
      proposedDiff: { frontmatter: { tags: ["legacy-update"] }, body: before.value.content },
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw staged.error;

    const stagedAction = await getStagedActionById(vault, staged.value.id);
    expect(stagedAction.ok).toBe(true);
    if (!stagedAction.ok) throw stagedAction.error;
    expect(stagedAction.value?.baseVersion).toBeNull();

    // The document changes AFTER staging (same shape as the clobber
    // scenario) — with no base_version captured, today's last-write-wins
    // behavior must be preserved: ratify still applies instead of rejecting.
    const drift = await vaultWrite(vault, {
      path: DOC,
      body: "# Retry storms\n\nA drifted claim.\n",
      frontmatter: { title: "Retry storms (drifted)" },
      agent: "agent:drift",
    });
    expect(drift.ok).toBe(true);

    const ratified = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: "dave",
    });
    expect(ratified.ok).toBe(true);
    if (!ratified.ok) throw ratified.error;
    expect(ratified.value.applied).toBe(true);

    const after = await vaultRead(vault, DOC);
    expect(after.ok).toBe(true);
    if (!after.ok) throw after.error;
    expect(after.value.frontmatter.tags).toEqual(["legacy-update"]);
  }, 60_000);
});
