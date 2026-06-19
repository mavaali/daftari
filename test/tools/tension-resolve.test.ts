// vault_tension_resolve tool — Phase 1 of the tension graph plan (2026-05-31).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { CONSOLIDATE_AGENT } from "../../src/consolidate/constants.js";
import { addTension, listTensions } from "../../src/curation/tension.js";
import { vaultTensionResolve } from "../../src/tools/curation.js";

function curatorAccess(user = "mihir"): AccessContext {
  return {
    user,
    roleName: "curator",
    role: { read: ["*"], write: ["*"], promote: true, ratify: false },
  };
}

function ratifyAccess(user = "senior"): AccessContext {
  return {
    user,
    roleName: "senior-curator",
    role: { read: ["*"], write: ["*"], promote: true, ratify: true },
  };
}

function readerAccess(user = "reader"): AccessContext {
  return {
    user,
    roleName: "reader",
    role: { read: ["*"], write: [], promote: false, ratify: false },
  };
}

async function seedTension(vault: string) {
  const seeded = await addTension(vault, {
    title: "Helios credit multiplier disagreement",
    sourceA: "pricing/helios-consumption-pricing.md",
    claimA: "1.5x for GPU",
    sourceB: "competitive-intel/helios-pricing-update.md",
    claimB: "2.0x for GPU",
    loggedBy: "agent:claude-code",
    kind: "factual",
  });
  if (!seeded.ok) throw seeded.error;
  return seeded.value;
}

describe("vault_tension_resolve", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-resolve-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("resolves with kind=superseded and stamps resolved_at + resolved_by", async () => {
    const entry = await seedTension(vault);

    const result = await vaultTensionResolve(
      vault,
      { id: entry.id, kind: "superseded", rationale: "Newer doc is canonical" },
      curatorAccess(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resolved).toBe(true);
    expect(result.value.resolution?.kind).toBe("superseded");
    expect(result.value.resolution?.resolved_by).toBe("mihir");
    expect(result.value.resolution?.resolved_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(result.value.resolution?.rationale).toBe("Newer doc is canonical");
  });

  it("resolves with kind=corrected including references", async () => {
    const entry = await seedTension(vault);
    const result = await vaultTensionResolve(
      vault,
      {
        id: entry.id,
        kind: "corrected",
        rationale: "Vendor portal confirmed multiplier",
        references: ["pricing/helios-consumption-pricing.md"],
      },
      curatorAccess(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resolution?.kind).toBe("corrected");
    expect(result.value.resolution?.references).toEqual(["pricing/helios-consumption-pricing.md"]);
  });

  it("resolves with kind=accepted (stable acknowledged disagreement)", async () => {
    const entry = await seedTension(vault);
    const result = await vaultTensionResolve(
      vault,
      { id: entry.id, kind: "accepted", rationale: "Both views stand" },
      curatorAccess(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resolution?.kind).toBe("accepted");
  });

  it("resolves with kind=invalid (false alarm)", async () => {
    const entry = await seedTension(vault);
    const result = await vaultTensionResolve(
      vault,
      { id: entry.id, kind: "invalid" },
      curatorAccess(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resolution?.kind).toBe("invalid");
    expect(result.value.resolution?.rationale).toBeUndefined();
    expect(result.value.resolution?.references).toBeUndefined();
  });

  it("errors when the id is missing", async () => {
    const result = await vaultTensionResolve(vault, { kind: "corrected" }, curatorAccess());
    expect(result.ok).toBe(false);
  });

  it("errors when the id is unknown", async () => {
    await seedTension(vault);
    const result = await vaultTensionResolve(
      vault,
      { id: "tension-999", kind: "corrected" },
      curatorAccess(),
    );
    expect(result.ok).toBe(false);
  });

  it("errors when the tension is already resolved", async () => {
    const entry = await seedTension(vault);
    await vaultTensionResolve(vault, { id: entry.id, kind: "corrected" }, curatorAccess());
    const second = await vaultTensionResolve(
      vault,
      { id: entry.id, kind: "accepted" },
      curatorAccess(),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toMatch(/already resolved/);
  });

  it("errors when kind is not one of the four resolution kinds", async () => {
    const entry = await seedTension(vault);
    const result = await vaultTensionResolve(
      vault,
      { id: entry.id, kind: "made-up" },
      curatorAccess(),
    );
    expect(result.ok).toBe(false);
  });

  it("errors when references is not an array of non-empty strings", async () => {
    const entry = await seedTension(vault);
    const result = await vaultTensionResolve(
      vault,
      { id: entry.id, kind: "corrected", references: [""] },
      curatorAccess(),
    );
    expect(result.ok).toBe(false);
  });

  it("denies a role with no read grants (guest-equivalent)", async () => {
    const entry = await seedTension(vault);
    const guest: AccessContext = { user: "guest", roleName: "guest", role: null };
    const result = await vaultTensionResolve(vault, { id: entry.id, kind: "corrected" }, guest);
    expect(result.ok).toBe(false);
  });

  it("round-trips through listTensions: resolution survives a reload", async () => {
    const entry = await seedTension(vault);
    await vaultTensionResolve(
      vault,
      {
        id: entry.id,
        kind: "corrected",
        rationale: "Confirmed",
        references: ["pricing/canonical.md"],
      },
      curatorAccess("mihir.wagle"),
    );

    const list = await listTensions(vault);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const [first] = list.value;
    expect(first?.resolved).toBe(true);
    expect(first?.resolution?.kind).toBe("corrected");
    expect(first?.resolution?.resolved_by).toBe("mihir.wagle");
    expect(first?.resolution?.references).toEqual(["pricing/canonical.md"]);
  });

  describe("loop-authored tension guard (Stage 3 §5.4)", () => {
    async function seedLoopTension(vaultRoot: string) {
      const seeded = await addTension(vaultRoot, {
        title: "Loop-authored tension",
        sourceA: "a.md",
        claimA: "claim A",
        sourceB: "b.md",
        claimB: "claim B",
        loggedBy: CONSOLIDATE_AGENT,
        kind: "interpretive",
      });
      if (!seeded.ok) throw seeded.error;
      return seeded.value;
    }

    it("denies a non-ratify role from resolving a loop-authored tension", async () => {
      const entry = await seedLoopTension(vault);
      const res = await vaultTensionResolve(
        vault,
        { id: entry.id, kind: "superseded", rationale: "Overriding loop" },
        readerAccess(),
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.message).toMatch(/cannot resolve/i);
    });

    it("allows a ratify role to resolve a loop-authored tension", async () => {
      const entry = await seedLoopTension(vault);
      const res = await vaultTensionResolve(
        vault,
        { id: entry.id, kind: "superseded", rationale: "Senior curator sign-off" },
        ratifyAccess(),
      );
      expect(res.ok).toBe(true);
    });

    it("allows any-read role to resolve a human-authored tension", async () => {
      // Human-logged tensions stay resolvable by anyone with read access.
      const seeded = await addTension(vault, {
        title: "Human tension",
        sourceA: "c.md",
        claimA: "human claim A",
        sourceB: "d.md",
        claimB: "human claim B",
        loggedBy: "human:mihir",
        kind: "factual",
      });
      if (!seeded.ok) throw seeded.error;
      const entry = seeded.value;

      const res = await vaultTensionResolve(
        vault,
        { id: entry.id, kind: "accepted", rationale: "Both stand" },
        readerAccess(),
      );
      expect(res.ok).toBe(true);
    });

    it("bypasses the gate when no access context is supplied (loop-authored tension)", async () => {
      // Direct/in-process calls with no access context must not be blocked.
      const entry = await seedLoopTension(vault);
      const res = await vaultTensionResolve(vault, { id: entry.id, kind: "invalid" }, undefined);
      expect(res.ok).toBe(true);
    });
  });
});
