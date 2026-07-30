// Orchestrator integration tests.
//
// 1. RBAC blind-spot flag — when one tension side is unreadable, the tension
//    is hidden from the resolved canon but partial_visibility is flagged.
// 2. Unindexed flag — a visible candidate doc with no tension and no edge
//    gets flags.unindexed === true and its path in flags.unindexed_paths.
// 3. Holders default — two visible docs from different holders, tensioned
//    together, called without an explicit holders arg → the contested
//    trajectory surfaces (default holder-set derived from visible candidates).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { computeCanon } from "../../src/canon/index.js";
import { addTension } from "../../src/curation/tension.js";
import type { RoleConfig } from "../../src/utils/config.js";

function makeDoc(collection: string, name: string, updatedBy: string, vaultRoot: string): void {
  const dir = join(vaultRoot, collection);
  mkdirSync(dir, { recursive: true });
  const fm = [
    "---",
    `title: ${name}`,
    `collection: ${collection}`,
    "status: canonical",
    "confidence: high",
    "provenance: primary",
    "created: 2026-01-01",
    "updated: 2026-01-01",
    `updated_by: ${updatedBy}`,
    "valid_from: 2026-01-01",
    "sources: []",
    "---",
    "",
    `Body of ${name}.`,
  ].join("\n");
  writeFileSync(join(dir, `${name}.md`), fm, "utf-8");
}

describe("computeCanon — RBAC blind-spot flag", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-canon-orch-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("sets partial_visibility=true and hidden_tension_count=1 when one tension side is unreadable", async () => {
    // Create two docs in different collections.
    makeDoc("open", "a", "human:alice", vault);
    makeDoc("secret", "b", "human:bob", vault);

    // Log a tension between them.
    const tensionRes = await addTension(vault, {
      title: "Open vs Secret conflict",
      kind: "factual",
      sourceA: "open/a.md",
      claimA: "open claim",
      sourceB: "secret/b.md",
      claimB: "secret claim",
      loggedBy: "test",
    });
    expect(tensionRes.ok).toBe(true);

    // Construct an AccessContext whose role can read "open" but NOT "secret".
    const restrictedRole: RoleConfig = {
      read: ["open"],
      write: [],
      promote: false,
      ratify: false,
    };
    const access: AccessContext = {
      user: "test-user",
      roleName: "restricted",
      role: restrictedRole,
    };

    const result = await computeCanon(vault, { seed: "open/a.md", asOf: "2026-07-01" }, access);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { settled, contested, flags } = result.value;

    // open/a.md should be settled (not contested — the tension partner is hidden).
    expect(contested).toHaveLength(0);
    const paths = settled.flatMap((s) => s.citations);
    expect(paths).toContain("open/a.md");

    // The blind-spot flags must be set.
    expect(flags.partial_visibility).toBe(true);
    expect(flags.hidden_tension_count).toBe(1);
  });
});

describe("computeCanon — both-sides-hidden tension", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-canon-both-hidden-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("counts both one-side-hidden and both-sides-hidden tensions in hidden_tension_count", async () => {
    // Three docs: open/a.md (readable), secret/b.md (unreadable), secret/c.md (unreadable).
    // Tension a–b: one-side-hidden (a is readable, b is not).
    // Tension b–c: both-sides-hidden (neither b nor c is readable).
    // Seed: open/a.md, depth 2 → topic {a, b, c} (a–b–c chain).
    //
    // Pre-fix: touchingTensions filtered on visiblePaths = {open/a.md} only.
    //   - a–b touches (a ∈ visiblePaths) → classified hidden (b unreadable) → count 1
    //   - b–c does NOT touch (neither b nor c ∈ visiblePaths) → skipped
    //   Result: hidden_tension_count = 1, partial_visibility = true (correct but incomplete).
    //
    // Post-fix: touchingTensions filtered on existingCandidatePaths = {a, b, c}.
    //   - a–b touches → hidden (b unreadable) → count 1
    //   - b–c touches (b ∈ existingCandidatePaths) → hidden (both unreadable) → count 2
    //   Result: hidden_tension_count = 2, partial_visibility = true.

    makeDoc("open", "a", "human:alice", vault);
    makeDoc("secret", "b", "human:bob", vault);
    makeDoc("secret", "c", "human:carol", vault);

    const t1 = await addTension(vault, {
      title: "a vs b",
      kind: "factual",
      sourceA: "open/a.md",
      claimA: "open claim",
      sourceB: "secret/b.md",
      claimB: "secret claim b",
      loggedBy: "test",
    });
    expect(t1.ok).toBe(true);

    const t2 = await addTension(vault, {
      title: "b vs c",
      kind: "factual",
      sourceA: "secret/b.md",
      claimA: "secret claim b2",
      sourceB: "secret/c.md",
      claimB: "secret claim c",
      loggedBy: "test",
    });
    expect(t2.ok).toBe(true);

    // Role reads "open" only — cannot read "secret".
    const restrictedRole: RoleConfig = {
      read: ["open"],
      write: [],
      promote: false,
      ratify: false,
    };
    const access: AccessContext = {
      user: "test-user",
      roleName: "restricted",
      role: restrictedRole,
    };

    const result = await computeCanon(
      vault,
      { seed: "open/a.md", depth: 2, asOf: "2026-07-01" },
      access,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { flags } = result.value;

    // Both the one-side-hidden (a–b) and the both-sides-hidden (b–c) tension
    // must be counted — hidden_tension_count must be 2.
    expect(flags.partial_visibility).toBe(true);
    expect(flags.hidden_tension_count).toBe(2);
  });
});

describe("computeCanon — unindexed flag", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-canon-unindexed-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("sets flags.unindexed=true for a visible seed doc with no tension and no edge", async () => {
    // A single doc with no tensions and no derives_from edges. It is its own
    // topic (trivial one-node graph), visible, and unindexed by definition.
    makeDoc("open", "solo", "human:alice", vault);

    const result = await computeCanon(vault, { seed: "open/solo.md", asOf: "2026-07-01" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { flags } = result.value;

    expect(flags.unindexed).toBe(true);
    expect(flags.unindexed_paths).toContain("open/solo.md");
  });
});

describe("computeCanon — holders default", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-canon-holders-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("derives holder-set from visible candidates and surfaces contested trajectory", async () => {
    // Two docs in the same collection, owned by different holders, tensioned
    // together so they form one topic. Called without explicit holders arg —
    // the orchestrator must derive both holders from the visible candidates.
    makeDoc("open", "alpha", "human:alice", vault);
    makeDoc("open", "beta", "human:bob", vault);

    const tensionRes = await addTension(vault, {
      title: "alice vs bob",
      kind: "factual",
      sourceA: "open/alpha.md",
      claimA: "alice claim",
      sourceB: "open/beta.md",
      claimB: "bob claim",
      loggedBy: "test",
    });
    expect(tensionRes.ok).toBe(true);

    // No explicit holders argument — orchestrator derives them.
    const result = await computeCanon(vault, { seed: "open/alpha.md", asOf: "2026-07-01" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { contested } = result.value;

    // Both docs have no valid_from restriction, are in-scope for both derived
    // holders, and are tensioned — so they must appear in a contested trajectory.
    expect(contested.length).toBeGreaterThan(0);
    const trajectoryPaths = contested.flatMap((c) => c.trajectory.map((n) => n.path));
    expect(trajectoryPaths).toContain("open/alpha.md");
    expect(trajectoryPaths).toContain("open/beta.md");
  });
});
