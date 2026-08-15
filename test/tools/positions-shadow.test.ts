// Shadow mode (spec §11.5) says: log what would have happened, mutate
// nothing. performWrite's shadow branch (src/tools/write.ts) honors that for
// the doc write itself — no lock, no file write, no commit, no provenance.
// But vault_assert and vault_consolidate (src/tools/positions.ts) never
// inspected `written.shadow`: the post-write tension mint loop in
// vaultAssert, and the resolve_tension / resolve_tensions batch loop in
// vaultConsolidate, ran for real regardless — minting and resolving REAL
// tensions in .daftari/tensions.md for a position that was never actually
// written to the doc. These tests pin the fix: any tension mutation is
// skipped when the write result is shadowed.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listTensions } from "../../src/curation/tension.js";
import { vaultAssert, vaultConsolidate } from "../../src/tools/positions.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultWrite } from "../../src/tools/write.js";
import { configPath } from "../../src/utils/config.js";
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

// Flips the vault into shadow mode. Written AFTER any live seeding a test
// needs, since the config applies to every write that follows — matches
// test/curation/shadow.test.ts's enableShadowMode convention.
function enableShadowMode(vault: string): void {
  mkdirSync(dirname(configPath(vault)), { recursive: true });
  writeFileSync(configPath(vault), "version: 1\nshadow_mode: true\n");
}

describe("shadow mode: vault_assert mints no real tension", () => {
  let vault: string;
  beforeEach(async () => {
    vault = makeTempVault();
    await seedDoc(vault);
  });
  afterEach(() => cleanupVault(vault));

  it("two principals' conflicting asserts leave .daftari/tensions.md empty and the doc untouched", async () => {
    enableShadowMode(vault);

    const a = await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "a" },
      ALICE,
    );
    expect(a.ok).toBe(true);
    if (!a.ok) throw a.error;
    expect(a.value.tension_ids).toEqual([]);
    expect(a.value.shadow).toBe(true);
    expect(a.value.commit).toBeNull();
    expect(a.value.committed).toBe(false);

    // Bob's dispute conflicts with the legacy pos-000 snapshot (stance
    // "assert") — in live mode this mints a real positional tension. Under
    // shadow mode nothing was actually written for either assert, so no
    // tension should be minted for either.
    const b = await vaultAssert(
      vault,
      { path: DOC, stance: "dispute", confidence: "medium", agent: "b" },
      BOB,
    );
    expect(b.ok).toBe(true);
    if (!b.ok) throw b.error;
    expect(b.value.tension_ids).toEqual([]);
    expect(b.value.shadow).toBe(true);

    const tensions = await listTensions(vault);
    if (!tensions.ok) throw tensions.error;
    expect(tensions.value).toEqual([]);

    // Nothing landed on disk either — both shadowed asserts were pure no-ops.
    const read = await vaultRead(vault, DOC);
    if (!read.ok) throw read.error;
    expect(read.value.frontmatter.positions).toBeNull();
  });
});

describe("shadow mode: vault_consolidate resolves no real tension", () => {
  let vault: string;
  let tensionId: string;

  beforeEach(async () => {
    vault = makeTempVault();
    await seedDoc(vault);
    // Mint a REAL open positional tension while the vault is still live.
    const a = await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "a" },
      ALICE,
    );
    if (!a.ok) throw a.error;
    const b = await vaultAssert(
      vault,
      { path: DOC, stance: "dispute", confidence: "medium", agent: "b" },
      BOB,
    );
    if (!b.ok) throw b.error;
    const tensions = await listTensions(vault);
    if (!tensions.ok) throw tensions.error;
    const open = tensions.value.find((t) => t.kind === "positional" && !t.resolved);
    if (!open?.id) throw new Error("fixture: expected an open positional tension");
    tensionId = open.id;
    // NOW flip into shadow mode — the consolidate call under test must not
    // touch the tension minted above.
    enableShadowMode(vault);
  });
  afterEach(() => cleanupVault(vault));

  it("resolve_tension: the named tension stays open on disk", async () => {
    const r = await vaultConsolidate(
      vault,
      {
        path: DOC,
        stance: "assert",
        confidence: "medium",
        agent: "c",
        resolve_tension: { id: tensionId, kind: "accepted" },
      },
      CAROL_RATIFIER,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.resolved_tension_id).toBeNull();
    expect(r.value.shadow).toBe(true);
    expect(r.value.commit).toBeNull();
    expect(r.value.committed).toBe(false);

    const tensions = await listTensions(vault);
    if (!tensions.ok) throw tensions.error;
    const still = tensions.value.find((t) => t.id === tensionId);
    expect(still?.resolved).toBe(false);
  });

  it("resolve_tensions: 'dissent' batch resolves nothing — the tension stays open", async () => {
    const r = await vaultConsolidate(
      vault,
      {
        path: DOC,
        stance: "assert",
        confidence: "medium",
        agent: "c",
        resolve_tensions: "dissent",
      },
      CAROL_RATIFIER,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.resolved_tension_ids).toEqual([]);
    expect(r.value.shadow).toBe(true);

    const tensions = await listTensions(vault);
    if (!tensions.ok) throw tensions.error;
    const still = tensions.value.find((t) => t.id === tensionId);
    expect(still?.resolved).toBe(false);
  });
});
