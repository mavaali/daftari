// staged.test.ts — TDD test suite for U7: staged-actions source adapter.
//
// The stagedAdapter wraps listStagedActions (src/curation/staged-actions.ts)
// and emits one Finding per PENDING staged action.
//
// Identity: native-id path — deriveIdentity("staged", check, target) where
//   target = { kind:"staged", stagedActionId: id } → identity_key = "staged:<id>"
//   This is the native-id fast-path in identity.ts, ignoring source/check.
//
// RBAC: filter by the targetPath's collection (artifact collection). Denied
//   findings are omitted entirely — no placeholder, no count (R17/R18).
//
// reproduces: true iff the action id is still present AND pending.
//   A ratified/rejected/expired action → reproduces false.
//
// Run with:
//   npx vitest run src/board/sources/staged.test.ts

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../access/rbac.js";
import type { RoleConfig } from "../../utils/config.js";
import { deriveIdentity, fingerprint } from "../identity.js";
import type { StagedTarget } from "../types.js";
import { stagedAdapter } from "./staged.js";

// ---------------------------------------------------------------------------
// Vault fixture helpers (mirrors lint.test.ts / staleness.test.ts)
// ---------------------------------------------------------------------------

function frontmatter(overrides: Record<string, unknown> = {}): string {
  const fm: Record<string, unknown> = {
    title: "Test Document",
    domain: "accumulation",
    collection: "notes",
    status: "canonical",
    confidence: "medium",
    created: "2020-01-01",
    updated: "2020-01-01",
    updated_by: "agent:seed",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: null,
    ...overrides,
  };
  const lines: string[] = [];
  for (const [k, v] of Object.entries(fm)) {
    if (v === null) {
      lines.push(`${k}: null`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${k}: []`);
      } else {
        lines.push(`${k}:`);
        for (const item of v as unknown[]) {
          lines.push(`  - ${JSON.stringify(item)}`);
        }
      }
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  return `---\n${lines.join("\n")}\n---\n`;
}

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

function writeDoc(vaultRoot: string, path: string, content: string): void {
  const full = join(vaultRoot, path);
  mkdirSync(join(vaultRoot, path.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

/** Write one proposal record into .daftari/staged-actions.jsonl */
function writeStagedActionProposal(
  vaultRoot: string,
  record: {
    id: string;
    action_type: string;
    target_path: string;
    proposed_by: string;
    proposed_at: string;
    expires_at: string;
    status: string;
    rationale: string;
    proposed_diff: string;
  },
): void {
  const daftariDir = join(vaultRoot, ".daftari");
  mkdirSync(daftariDir, { recursive: true });
  const filePath = join(daftariDir, "staged-actions.jsonl");
  let existing = "";
  try {
    existing = readFileSync(filePath, "utf-8");
  } catch {
    existing = "";
  }
  writeFileSync(filePath, `${existing + JSON.stringify(record)}\n`, "utf-8");
}

/** Append a decision record for a given id */
function writeStagedActionDecision(
  vaultRoot: string,
  decision: {
    id: string;
    status: string;
    ratified_at: string;
    ratified_by: string;
    ratification_reason?: string;
  },
): void {
  const daftariDir = join(vaultRoot, ".daftari");
  const filePath = join(daftariDir, "staged-actions.jsonl");
  let existing = "";
  try {
    existing = readFileSync(filePath, "utf-8");
  } catch {
    existing = "";
  }
  writeFileSync(filePath, `${existing + JSON.stringify(decision)}\n`, "utf-8");
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
  // can read "notes" but not "restricted"
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
// Scenario 1: Pending staged action → finding keyed on stage-NNN
// ---------------------------------------------------------------------------

describe("stagedAdapter — Scenario 1: pending action → finding", () => {
  let vaultRoot: string;
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-staged-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
      analyst: { read: ["notes"], write: ["notes"] },
    });
    // Write the target doc so RBAC can resolve its collection
    writeDoc(
      vaultRoot,
      "notes/my-doc.md",
      `${frontmatter({ title: "My Doc", collection: "notes" })}# Body\n`,
    );
    // Write a pending staged action targeting notes/my-doc.md
    writeStagedActionProposal(vaultRoot, {
      id: "stage-001",
      action_type: "promote",
      target_path: "notes/my-doc.md",
      proposed_by: "agent:loop",
      proposed_at: "2025-12-20T00:00:00Z",
      expires_at: "2026-01-03T00:00:00Z",
      status: "pending",
      rationale: "This doc is ready to promote.",
      proposed_diff: "null",
    });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("emits one finding for the pending action", async () => {
    const findings = await stagedAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.check).toBeTruthy();
    expect(findings[0]!.source).toBe("staged");
  });

  it("identity_key is 'staged:stage-001' — native-id path", async () => {
    const findings = await stagedAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    // The native-id fast-path in identity.ts returns "staged:<stagedActionId>"
    expect(f.identity_key).toBe("staged:stage-001");

    // Also verify via deriveIdentity
    const target: StagedTarget = { kind: "staged", stagedActionId: "stage-001" };
    const expected = deriveIdentity("staged", f.check, target);
    expect(f.identity_key).toBe(expected);
  });

  it("target is { kind:'staged', stagedActionId:'stage-001' }", async () => {
    const findings = await stagedAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings[0]!;
    expect(f.target).toEqual({ kind: "staged", stagedActionId: "stage-001" });
  });

  it("evidence contains actionType, targetPath, rationale, expiresAt", async () => {
    const findings = await stagedAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings[0]!;
    expect(f.evidence.actionType).toBe("promote");
    expect(f.evidence.targetPath).toBe("notes/my-doc.md");
    expect(typeof f.evidence.rationale).toBe("string");
    expect(typeof f.evidence.expiresAt).toBe("string");
  });

  it("fingerprint = fingerprint(evidence)", async () => {
    const findings = await stagedAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings[0]!;
    expect(f.fingerprint).toBe(fingerprint(f.evidence));
  });

  it("certainty is 'medium'", async () => {
    const findings = await stagedAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    expect(findings[0]!.certainty).toBe("medium");
  });

  it("suggested_action and verify_predicate are non-empty strings", async () => {
    const findings = await stagedAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings[0]!;
    expect(typeof f.suggested_action).toBe("string");
    expect(f.suggested_action.length).toBeGreaterThan(0);
    expect(typeof f.verify_predicate).toBe("string");
    expect(f.verify_predicate.length).toBeGreaterThan(0);
  });

  it("identityOf(raw) returns same identity_key", async () => {
    const findings = await stagedAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings[0]!;
    expect(stagedAdapter.identityOf(f)).toBe(f.identity_key);
  });

  it("fingerprintOf(raw) returns same fingerprint", async () => {
    const findings = await stagedAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings[0]!;
    expect(stagedAdapter.fingerprintOf(f)).toBe(f.fingerprint);
  });

  it("reproduces returns true for the pending action", async () => {
    const findings = await stagedAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings[0]!;
    const result = await stagedAdapter.reproduces(
      f.identity_key,
      vaultRoot,
      adminAccess,
      FIXED_NOW,
    );
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Identity stable after unrelated ledger appends
// ---------------------------------------------------------------------------

describe("stagedAdapter — Scenario 2: identity stable after unrelated ledger append", () => {
  let vaultRoot: string;
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-staged-identity-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    });
    writeDoc(
      vaultRoot,
      "notes/doc-a.md",
      `${frontmatter({ title: "Doc A", collection: "notes" })}# A\n`,
    );
    writeDoc(
      vaultRoot,
      "notes/doc-b.md",
      `${frontmatter({ title: "Doc B", collection: "notes" })}# B\n`,
    );
    // First pending action
    writeStagedActionProposal(vaultRoot, {
      id: "stage-001",
      action_type: "promote",
      target_path: "notes/doc-a.md",
      proposed_by: "agent:loop",
      proposed_at: "2025-12-20T00:00:00Z",
      expires_at: "2026-01-03T00:00:00Z",
      status: "pending",
      rationale: "Promote doc-a.",
      proposed_diff: "null",
    });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("identity_key of stage-001 is stable after a second action is staged", async () => {
    const findings1 = await stagedAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f1 = findings1.find((f) => f.identity_key === "staged:stage-001");
    expect(f1).toBeDefined();

    // Append a second, unrelated staged action
    writeStagedActionProposal(vaultRoot, {
      id: "stage-002",
      action_type: "deprecate",
      target_path: "notes/doc-b.md",
      proposed_by: "agent:loop",
      proposed_at: "2025-12-21T00:00:00Z",
      expires_at: "2026-01-04T00:00:00Z",
      status: "pending",
      rationale: "Deprecate doc-b.",
      proposed_diff: "null",
    });

    const findings2 = await stagedAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f1Again = findings2.find((f) => f.identity_key === "staged:stage-001");
    expect(f1Again).toBeDefined();
    // Identity unchanged
    expect(f1!.identity_key).toBe(f1Again!.identity_key);
    // Two findings now
    expect(findings2).toHaveLength(2);
    expect(findings2.find((f) => f.identity_key === "staged:stage-002")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Ratified action → reproduces false; not in list
// ---------------------------------------------------------------------------

describe("stagedAdapter — Scenario 3: ratified action → excluded + reproduces false", () => {
  let vaultRoot: string;
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-staged-ratified-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    });
    writeDoc(
      vaultRoot,
      "notes/doc.md",
      `${frontmatter({ title: "Doc", collection: "notes" })}# Body\n`,
    );
    // Write a pending proposal
    writeStagedActionProposal(vaultRoot, {
      id: "stage-001",
      action_type: "promote",
      target_path: "notes/doc.md",
      proposed_by: "agent:loop",
      proposed_at: "2025-12-20T00:00:00Z",
      expires_at: "2026-01-03T00:00:00Z",
      status: "pending",
      rationale: "Promote.",
      proposed_diff: "null",
    });
    // Write a decision record that ratifies it
    writeStagedActionDecision(vaultRoot, {
      id: "stage-001",
      status: "ratified",
      ratified_at: "2025-12-25T00:00:00Z",
      ratified_by: "human:admin",
    });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("ratified action is NOT in list()", async () => {
    const findings = await stagedAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings.find((f) => f.identity_key === "staged:stage-001");
    expect(f).toBeUndefined();
    expect(findings).toHaveLength(0);
  });

  it("reproduces returns false for a ratified action", async () => {
    const result = await stagedAdapter.reproduces(
      "staged:stage-001",
      vaultRoot,
      adminAccess,
      FIXED_NOW,
    );
    expect(result).toBe(false);
  });

  it("pending action remains; ratified action excluded — mixed JSONL", async () => {
    // Add a second pending action on top
    writeDoc(
      vaultRoot,
      "notes/doc2.md",
      `${frontmatter({ title: "Doc2", collection: "notes" })}# Body\n`,
    );
    writeStagedActionProposal(vaultRoot, {
      id: "stage-002",
      action_type: "deprecate",
      target_path: "notes/doc2.md",
      proposed_by: "agent:loop",
      proposed_at: "2025-12-26T00:00:00Z",
      expires_at: "2026-01-09T00:00:00Z",
      status: "pending",
      rationale: "Deprecate doc2.",
      proposed_diff: "null",
    });

    const findings = await stagedAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    // Only stage-002 is pending
    expect(findings).toHaveLength(1);
    expect(findings[0]!.identity_key).toBe("staged:stage-002");
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: RBAC — denied collection → omitted entirely
// ---------------------------------------------------------------------------

describe("stagedAdapter — Scenario 4: RBAC omission for denied collection", () => {
  let vaultRoot: string;
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-staged-rbac-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
      analyst: { read: ["notes"], write: ["notes"] },
    });
    // notes doc — readable by analyst
    writeDoc(
      vaultRoot,
      "notes/readable.md",
      `${frontmatter({ title: "Readable", collection: "notes" })}# Body\n`,
    );
    // restricted doc — NOT readable by analyst
    writeDoc(
      vaultRoot,
      "restricted/secret.md",
      `${frontmatter({ title: "Secret", collection: "restricted" })}# Secret\n`,
    );
    // Two pending actions: one on notes, one on restricted
    writeStagedActionProposal(vaultRoot, {
      id: "stage-001",
      action_type: "promote",
      target_path: "notes/readable.md",
      proposed_by: "agent:loop",
      proposed_at: "2025-12-20T00:00:00Z",
      expires_at: "2026-01-03T00:00:00Z",
      status: "pending",
      rationale: "Promote readable.",
      proposed_diff: "null",
    });
    writeStagedActionProposal(vaultRoot, {
      id: "stage-002",
      action_type: "deprecate",
      target_path: "restricted/secret.md",
      proposed_by: "agent:loop",
      proposed_at: "2025-12-20T00:00:00Z",
      expires_at: "2026-01-03T00:00:00Z",
      status: "pending",
      rationale: "Deprecate secret.",
      proposed_diff: "null",
    });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("admin sees both findings", async () => {
    const findings = await stagedAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    expect(findings).toHaveLength(2);
    const ids = findings.map((f) => f.identity_key);
    expect(ids).toContain("staged:stage-001");
    expect(ids).toContain("staged:stage-002");
  });

  it("scoped analyst sees only the notes finding — restricted is omitted", async () => {
    const findings = await stagedAdapter.list(vaultRoot, scopedAccess, FIXED_NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.identity_key).toBe("staged:stage-001");
  });

  it("reproduces for restricted finding returns false for scoped role", async () => {
    const result = await stagedAdapter.reproduces(
      "staged:stage-002",
      vaultRoot,
      scopedAccess,
      FIXED_NOW,
    );
    // Scoped role cannot see it → not in list → reproduces false
    expect(result).toBe(false);
  });
});
