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
    expect(read.ok && read.value.frontmatter.positions).toHaveLength(1);
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
    expect(r.value.tension_ids).toHaveLength(1);

    const read = await vaultRead(vault, DOC);
    expect(read.ok && read.value.frontmatter.confidence).toBe("low"); // R-9 cap
    expect(read.ok && read.value.frontmatter.contested).toBe(true);

    const tensions = await listTensions(vault);
    if (!tensions.ok) throw tensions.error;
    const t = tensions.value.filter((x) => x.kind === "positional");
    expect(t).toHaveLength(1);
    expect(t[0]?.sourceA).toBe(DOC);
    expect(t[0]?.sourceB).toBe(DOC);
    expect(t[0]?.positionA).toBe("pos-001");
    expect(t[0]?.positionB).toBe("pos-002");
    expect(t[0]?.loggedBy).toBe("bob"); // DN-3
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
    // (pos-001,pos-002) already tensioned; (pos-002,pos-003) is the one NEW live pair.
    const tensions = await listTensions(vault);
    if (!tensions.ok) throw tensions.error;
    const pairs = tensions.value
      .filter((x) => x.kind === "positional")
      .map((x) => `${x.positionA}/${x.positionB}`)
      .sort();
    expect(pairs).toEqual(["pos-001/pos-002", "pos-002/pos-003"]);

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
    expect(diff.frontmatter.positions).toHaveLength(1);

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
