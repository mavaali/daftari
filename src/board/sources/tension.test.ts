// tension.test.ts — TDD test suite for U8: tension source adapter.
//
// The tensionAdapter wraps listTensions (src/curation/tension.ts) and emits
// one Finding per UNRESOLVED tension entry that has a native id AND is visible
// to the caller (both-sides RBAC via canSeeTension).
//
// Identity: native-id path — deriveIdentity("tension", check, target) where
//   target = { kind:"tension", tensionId: entry.id } → "tension:<id>"
//   This is the native-id fast-path in identity.ts (ignores source/check).
//
// RBAC: canSeeTension(db, access, sourceA, sourceB) — the canonical both-sides
//   visibility gate. If EITHER side is in a denied collection the entry is
//   OMITTED ENTIRELY — no placeholder, no count (R19). Never hand-roll.
//
// Fingerprint: fingerprint({ claimA, claimB, status, kind }) — so an edited
//   claim drifts the fingerprint (re-triage) while identity stays (R21).
//
// Legacy tensions (no id field): EXCLUDED — cannot be safely dispositioned.
//   Documented behaviour; tested below.
//
// Resolved tensions: EXCLUDED.
//
// Run with:
//   npx vitest run src/board/sources/tension.test.ts

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../access/rbac.js";
import { requireDefined } from "../../test-utils/require-defined.js";
import type { RoleConfig } from "../../utils/config.js";
import { deriveIdentity, fingerprint } from "../identity.js";
import type { TensionTarget } from "../types.js";
import { tensionAdapter } from "./tension.js";

// ---------------------------------------------------------------------------
// Vault fixture helpers (mirrors staged.test.ts / lint.test.ts)
// ---------------------------------------------------------------------------

function writeConfig(vaultRoot: string, roles: Record<string, Record<string, unknown>>): void {
  const daftariDir = join(vaultRoot, ".daftari");
  mkdirSync(daftariDir, { recursive: true });
  const roleLines = Object.entries(roles)
    .map(([name, cfg]) => {
      const lines = [`  ${name}:`];
      for (const [k, v] of Object.entries(cfg)) {
        if (Array.isArray(v)) {
          lines.push(`    ${k}: [${(v as string[]).map((s) => JSON.stringify(s)).join(", ")}]`);
        } else {
          lines.push(`    ${k}: ${JSON.stringify(v)}`);
        }
      }
      return lines.join("\n");
    })
    .join("\n");
  const yaml = `version: 1\nvault_name: test-vault\nroles:\n${roleLines}\n`;
  writeFileSync(join(daftariDir, "config.yaml"), yaml, "utf-8");
}

/**
 * Write a tensions.md block into .daftari/tensions.md.
 * Uses the canonical format that tension.ts parseTensionLog understands.
 */
function writeTension(
  vaultRoot: string,
  entry: {
    id?: string; // absent → legacy (no-id)
    date: string;
    title: string;
    kind?: string; // defaults to "factual"
    sourceA: string;
    claimA: string;
    sourceB: string;
    claimB: string;
    status?: string; // defaults to "unresolved"
    loggedBy?: string;
    resolved?: boolean;
    // Resolution fields (make it resolved)
    resolvedAt?: string;
    resolvedBy?: string;
    resolutionKind?: string;
  },
): void {
  const daftariDir = join(vaultRoot, ".daftari");
  mkdirSync(daftariDir, { recursive: true });
  const filePath = join(daftariDir, "tensions.md");

  const lines = [`## ${entry.date} — ${entry.title}`];
  if (entry.id !== undefined) lines.push(`- **Id:** ${entry.id}`);
  const kind = entry.kind ?? "factual";
  if (kind !== "unspecified") lines.push(`- **Kind:** ${kind}`);
  lines.push(`- **Source A:** ${entry.sourceA} says ${entry.claimA}`);
  lines.push(`- **Source B:** ${entry.sourceB} says ${entry.claimB}`);
  lines.push(`- **Status:** ${entry.status ?? "unresolved"}`);
  lines.push(`- **Logged by:** ${entry.loggedBy ?? "agent:test"}`);
  if (entry.resolvedAt && entry.resolvedBy && entry.resolutionKind) {
    lines.push(`- **Resolved at:** ${entry.resolvedAt}`);
    lines.push(`- **Resolved by:** ${entry.resolvedBy}`);
    lines.push(`- **Resolution kind:** ${entry.resolutionKind}`);
  }

  // Append block to file (each entry preceded by blank line, matching renderEntry)
  let existing = "";
  try {
    existing = readFileSync(filePath, "utf-8");
  } catch {
    existing = "";
  }
  writeFileSync(filePath, `${existing}\n${lines.join("\n")}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// Role fixtures
// ---------------------------------------------------------------------------

const adminRole: RoleConfig = {
  read: ["*"],
  write: ["*"],
  promote: true,
  ratify: true,
};

const scopedRole: RoleConfig = {
  // can read "notes" but NOT "restricted"
  read: ["notes"],
  write: ["notes"],
  promote: false,
  ratify: false,
};

const adminAccess: AccessContext = {
  user: "human:admin",
  roleName: "admin",
  role: adminRole,
};

const scopedAccess: AccessContext = {
  user: "human:analyst",
  roleName: "analyst",
  role: scopedRole,
};

// ---------------------------------------------------------------------------
// Scenario 1: Unresolved tension, both sides readable → visible finding
// ---------------------------------------------------------------------------

describe("tensionAdapter — Scenario 1: unresolved tension both sides readable → finding", () => {
  let vaultRoot: string;
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-tension-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
      analyst: { read: ["notes"], write: ["notes"] },
    });
    writeTension(vaultRoot, {
      id: "tension-001",
      date: "2026-01-01",
      title: "Doc A vs Doc B conflict",
      kind: "factual",
      sourceA: "notes/doc-a.md",
      claimA: "The sky is blue",
      sourceB: "notes/doc-b.md",
      claimB: "The sky is green",
      status: "unresolved",
      loggedBy: "agent:test",
    });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("emits one finding for the unresolved tension", async () => {
    const findings = await tensionAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    expect(findings).toHaveLength(1);
    expect(requireDefined(findings[0]).source).toBe("tension");
  });

  it("identity_key is 'tension:tension-001' — native-id path", async () => {
    const findings = await tensionAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    expect(findings).toHaveLength(1);
    const f = requireDefined(findings[0]);
    expect(f.identity_key).toBe("tension:tension-001");

    // Verify via deriveIdentity too
    const target: TensionTarget = { kind: "tension", tensionId: "tension-001" };
    const expected = deriveIdentity("tension", f.check, target);
    expect(f.identity_key).toBe(expected);
  });

  it("target is { kind:'tension', tensionId:'tension-001' }", async () => {
    const findings = await tensionAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = requireDefined(findings[0]);
    expect(f.target).toEqual({ kind: "tension", tensionId: "tension-001" });
  });

  it("evidence contains title, kind, sourceA, claimA, sourceB, claimB", async () => {
    const findings = await tensionAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = requireDefined(findings[0]);
    expect(f.evidence.title).toBe("Doc A vs Doc B conflict");
    expect(f.evidence.kind).toBe("factual");
    expect(f.evidence.sourceA).toBe("notes/doc-a.md");
    expect(f.evidence.claimA).toBe("The sky is blue");
    expect(f.evidence.sourceB).toBe("notes/doc-b.md");
    expect(f.evidence.claimB).toBe("The sky is green");
  });

  it("fingerprint = fingerprint({ claimA, claimB, status, kind })", async () => {
    const findings = await tensionAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = requireDefined(findings[0]);
    const expected = fingerprint({
      claimA: "The sky is blue",
      claimB: "The sky is green",
      status: "unresolved",
      kind: "factual",
    });
    expect(f.fingerprint).toBe(expected);
  });

  it("certainty is 'medium'", async () => {
    const findings = await tensionAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    expect(requireDefined(findings[0]).certainty).toBe("medium");
  });

  it("suggested_action and verify_predicate are non-empty strings", async () => {
    const findings = await tensionAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = requireDefined(findings[0]);
    expect(typeof f.suggested_action).toBe("string");
    expect(f.suggested_action.length).toBeGreaterThan(0);
    expect(typeof f.verify_predicate).toBe("string");
    expect(f.verify_predicate.length).toBeGreaterThan(0);
  });

  it("identityOf(raw) returns same identity_key", async () => {
    const findings = await tensionAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = requireDefined(findings[0]);
    expect(tensionAdapter.identityOf(f)).toBe(f.identity_key);
  });

  it("fingerprintOf(raw) returns same fingerprint", async () => {
    const findings = await tensionAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = requireDefined(findings[0]);
    expect(tensionAdapter.fingerprintOf(f)).toBe(f.fingerprint);
  });

  it("reproduces returns true for the unresolved tension", async () => {
    const findings = await tensionAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = requireDefined(findings[0]);
    const result = await tensionAdapter.reproduces(
      f.identity_key,
      vaultRoot,
      adminAccess,
      FIXED_NOW,
    );
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Both-sides RBAC — one side in denied collection → omitted entirely
// (Covers R19: no count, no existence signal for scoped role)
// ---------------------------------------------------------------------------

describe("tensionAdapter — Scenario 2: one side in denied collection → omitted entirely (R19)", () => {
  let vaultRoot: string;
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-tension-rbac-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
      analyst: { read: ["notes"], write: ["notes"] },
    });
    // Tension whose sourceA is in "notes" (readable) but sourceB is in "restricted" (denied)
    writeTension(vaultRoot, {
      id: "tension-002",
      date: "2026-01-02",
      title: "Cross-collection conflict",
      kind: "factual",
      sourceA: "notes/public-doc.md",
      claimA: "System is stable",
      sourceB: "restricted/secret-doc.md",
      claimB: "System has critical flaw",
      status: "unresolved",
      loggedBy: "agent:test",
    });
    // Also a tension both sides in "notes" — readable by both roles
    writeTension(vaultRoot, {
      id: "tension-003",
      date: "2026-01-03",
      title: "Notes-only conflict",
      kind: "interpretive",
      sourceA: "notes/doc-x.md",
      claimA: "Approach A is best",
      sourceB: "notes/doc-y.md",
      claimB: "Approach B is best",
      status: "unresolved",
      loggedBy: "agent:test",
    });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("admin sees both tensions", async () => {
    const findings = await tensionAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    expect(findings).toHaveLength(2);
    const ids = findings.map((f) => f.identity_key);
    expect(ids).toContain("tension:tension-002");
    expect(ids).toContain("tension:tension-003");
  });

  it("scoped analyst sees ZERO findings — cross-collection tension omitted entirely", async () => {
    // analyst cannot read "restricted", so tension-002 must be omitted.
    // tension-003 is both in "notes" so it should be visible.
    const findings = await tensionAdapter.list(vaultRoot, scopedAccess, FIXED_NOW);
    // tension-002 omitted (restricted side); tension-003 visible
    expect(findings).toHaveLength(1);
    expect(requireDefined(findings[0]).identity_key).toBe("tension:tension-003");
    // Cross-collection tension must not appear — no count, no signal (R19)
    const crossCollectionFinding = findings.find((f) => f.identity_key === "tension:tension-002");
    expect(crossCollectionFinding).toBeUndefined();
  });

  it("reproduces for cross-collection tension returns false for scoped role", async () => {
    const result = await tensionAdapter.reproduces(
      "tension:tension-002",
      vaultRoot,
      scopedAccess,
      FIXED_NOW,
    );
    // Scoped role cannot see it → not in list → reproduces false (R19)
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Resolved tension → excluded from findings; reproduces false
// ---------------------------------------------------------------------------

describe("tensionAdapter — Scenario 3: resolved tension → excluded, reproduces false", () => {
  let vaultRoot: string;
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-tension-resolved-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    });
    // A resolved tension
    writeTension(vaultRoot, {
      id: "tension-004",
      date: "2026-01-04",
      title: "Now resolved",
      kind: "factual",
      sourceA: "notes/doc-a.md",
      claimA: "Claim A",
      sourceB: "notes/doc-b.md",
      claimB: "Claim B",
      status: "resolved",
      loggedBy: "agent:test",
      resolvedAt: "2026-01-05T00:00:00Z",
      resolvedBy: "human:admin",
      resolutionKind: "accepted",
    });
    // An unresolved tension to confirm the filter works
    writeTension(vaultRoot, {
      id: "tension-005",
      date: "2026-01-05",
      title: "Still open",
      kind: "temporal",
      sourceA: "notes/doc-c.md",
      claimA: "Then X",
      sourceB: "notes/doc-d.md",
      claimB: "Now Y",
      status: "unresolved",
      loggedBy: "agent:test",
    });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("resolved tension is NOT in list()", async () => {
    const findings = await tensionAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const resolved = findings.find((f) => f.identity_key === "tension:tension-004");
    expect(resolved).toBeUndefined();
  });

  it("unresolved tension IS in list()", async () => {
    const findings = await tensionAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const open = findings.find((f) => f.identity_key === "tension:tension-005");
    expect(open).toBeDefined();
  });

  it("reproduces returns false for a resolved tension", async () => {
    const result = await tensionAdapter.reproduces(
      "tension:tension-004",
      vaultRoot,
      adminAccess,
      FIXED_NOW,
    );
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Fingerprint drift on claim edit — same identity, new fingerprint
// ---------------------------------------------------------------------------

describe("tensionAdapter — Scenario 4: claim edit → fingerprint drift, identity stable", () => {
  let vaultRoot: string;
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-tension-fingerprint-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    });
    writeTension(vaultRoot, {
      id: "tension-006",
      date: "2026-01-06",
      title: "Drifting tension",
      kind: "factual",
      sourceA: "notes/src-a.md",
      claimA: "Original claim A",
      sourceB: "notes/src-b.md",
      claimB: "Original claim B",
      status: "unresolved",
      loggedBy: "agent:test",
    });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("editing claimA changes fingerprint but NOT identity_key", async () => {
    // Read original finding
    const findingsBefore = await tensionAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    expect(findingsBefore).toHaveLength(1);
    const before = requireDefined(findingsBefore[0]);

    // Overwrite tensions.md with an edited claimA
    const daftariDir = join(vaultRoot, ".daftari");
    const tensionsPath = join(daftariDir, "tensions.md");
    const originalContent = readFileSync(tensionsPath, "utf-8");
    const editedContent = originalContent.replace("Original claim A", "EDITED claim A");
    writeFileSync(tensionsPath, editedContent, "utf-8");

    // Read findings again
    const findingsAfter = await tensionAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    expect(findingsAfter).toHaveLength(1);
    const after = requireDefined(findingsAfter[0]);

    // Identity is stable — same tension-006
    expect(after.identity_key).toBe(before.identity_key);
    expect(after.identity_key).toBe("tension:tension-006");

    // Fingerprint DRIFTED because claimA changed
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Legacy tension (no id field) → excluded (cannot be dispositioned)
// ---------------------------------------------------------------------------

describe("tensionAdapter — Scenario 5: legacy tension with no id → excluded", () => {
  let vaultRoot: string;
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-tension-legacy-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    });
    // Legacy entry — no id field
    writeTension(vaultRoot, {
      // No id
      date: "2024-06-01",
      title: "Old legacy tension",
      kind: "unspecified",
      sourceA: "notes/old-a.md",
      claimA: "Old claim A",
      sourceB: "notes/old-b.md",
      claimB: "Old claim B",
      status: "unresolved",
      loggedBy: "agent:legacy",
    });
    // Modern tension with id — should still appear
    writeTension(vaultRoot, {
      id: "tension-007",
      date: "2026-01-07",
      title: "Modern tension",
      kind: "factual",
      sourceA: "notes/new-a.md",
      claimA: "New claim A",
      sourceB: "notes/new-b.md",
      claimB: "New claim B",
      status: "unresolved",
      loggedBy: "agent:test",
    });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("legacy tension without id is NOT in list() — cannot be safely dispositioned", async () => {
    const findings = await tensionAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    // Only the modern tension appears
    expect(findings).toHaveLength(1);
    expect(requireDefined(findings[0]).identity_key).toBe("tension:tension-007");
  });

  it("reproduces returns false for a hypothetical legacy-id key", async () => {
    // There is no native id to look up; adapters excluding legacy entries means
    // any attempt to reproduce them is false.
    const result = await tensionAdapter.reproduces(
      "tension:legacy-hypothetical",
      vaultRoot,
      adminAccess,
      FIXED_NOW,
    );
    expect(result).toBe(false);
  });
});
