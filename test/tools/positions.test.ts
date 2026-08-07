import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProvenanceLog } from "../../src/curation/provenance.js";
import { getStagedActionById } from "../../src/curation/staged-actions.js";
import { listTensions } from "../../src/curation/tension.js";
import { registeredToolNames } from "../../src/server.js";
import { vaultAssert, vaultPositions } from "../../src/tools/positions.js";
import { vaultRead } from "../../src/tools/read.js";
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
