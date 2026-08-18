// tier2.test.ts — TDD test suite for U7: tier-2 queue source adapter.
//
// The tier2QueueAdapter wraps the tier-2 residual queue (pending-unchecked
// rows with no covering verdict) and emits one Finding per residual row.
//
// Strategy: DEPENDENCY INJECTION via factory (makeTier2QueueAdapter).
//   Building a full tier-2 graph fixture (provenance log + edges + verdicts
//   + docs) is disproportionate for unit-testing the adapter's mapping logic.
//   Instead, makeTier2QueueAdapter accepts a seam function
//   `(vaultRoot) => Tier2WorkItem[]` that tests inject with pre-canned items.
//   The production export `tier2QueueAdapter` uses the real loading path via
//   loadQueueSources + residualRows (same as U6's edgeStalenessAdapter pattern).
//
// Identity: tuple hash — deriveIdentity("tier2", "pending-unchecked", target)
//   where target = { kind:"tier2", artifact, unit, edgeClass }.
//   This is the HASH-PATH (not native-id), so source+check are included in
//   the hash. This key is DISJOINT from edge-staleness keys which use
//   source="staleness" check="edge-staleness" — confirmed by the identity
//   collision test below.
//
// RBAC: filter by ARTIFACT's collection (same rule as edge-staleness U6).
//   A finding whose artifact collection the caller cannot read is omitted.
//
// reproduces: true iff the (artifact, unit, edgeClass) triple is still
//   pending-unchecked with no covering verdict in the live queue.
//
// Run with:
//   npx vitest run src/board/sources/tier2.test.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../access/rbac.js";
import type { RoleConfig } from "../../utils/config.js";
import { deriveIdentity, fingerprint } from "../identity.js";
import type { Tier2Target } from "../types.js";
import { makeTier2QueueAdapter, tier2QueueAdapter } from "./tier2.js";

// ---------------------------------------------------------------------------
// Vault fixture helpers
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
// Pre-canned Tier2WorkItem fixtures
// ---------------------------------------------------------------------------

// A minimal Tier2WorkItem for injection (matches the shape in tools/tier2.ts)
function makeWorkItem(
  artifact: string,
  unit: string,
  edgeClass: "declared" | "earned" = "declared",
) {
  return {
    artifact,
    unit,
    edge_class: edgeClass,
    baseline: "2025-01-01T00:00:00.000Z",
    changed_fields: ["body"],
    field_changes: { body: { before: null, after: null } },
    usage_span: null,
    question: `Does ${artifact} still hold given changes to ${unit}?`,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: Tier-2 residual row → tuple identity, correct mapping
// ---------------------------------------------------------------------------

describe("makeTier2QueueAdapter — Scenario 1: residual row → finding with tuple identity", () => {
  let vaultRoot: string;
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-tier2-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    });
    writeDoc(
      vaultRoot,
      "notes/artifact.md",
      frontmatter({ title: "Artifact", collection: "notes" }) + "# Body\n",
    );
    writeDoc(
      vaultRoot,
      "notes/unit.md",
      frontmatter({ title: "Unit", collection: "notes" }) + "# Unit body\n",
    );
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("emits one finding for a pending-unchecked row", async () => {
    const item = makeWorkItem("notes/artifact.md", "notes/unit.md");
    const adapter = makeTier2QueueAdapter(async () => [item]);
    const findings = await adapter.list(vaultRoot, adminAccess, FIXED_NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.source).toBe("tier2");
  });

  it("identity_key is the tuple hash: deriveIdentity('tier2', check, target)", async () => {
    const item = makeWorkItem("notes/artifact.md", "notes/unit.md", "declared");
    const adapter = makeTier2QueueAdapter(async () => [item]);
    const findings = await adapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings[0]!;

    const target: Tier2Target = {
      kind: "tier2",
      artifact: "notes/artifact.md",
      unit: "notes/unit.md",
      edgeClass: "declared",
    };
    const expected = deriveIdentity("tier2", f.check, target);
    expect(f.identity_key).toBe(expected);
    // And it is NOT a native-id (not "staged:..." or "tension:...")
    expect(f.identity_key).not.toMatch(/^staged:/);
    expect(f.identity_key).not.toMatch(/^tension:/);
    // It's a sha256 hex (64 chars)
    expect(f.identity_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("target matches the (artifact, unit, edgeClass) triple", async () => {
    const item = makeWorkItem("notes/artifact.md", "notes/unit.md", "earned");
    const adapter = makeTier2QueueAdapter(async () => [item]);
    const findings = await adapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings[0]!;
    expect(f.target).toEqual({
      kind: "tier2",
      artifact: "notes/artifact.md",
      unit: "notes/unit.md",
      edgeClass: "earned",
    });
  });

  it("evidence contains edge_class, changed_fields, baseline, question", async () => {
    const item = makeWorkItem("notes/artifact.md", "notes/unit.md");
    const adapter = makeTier2QueueAdapter(async () => [item]);
    const findings = await adapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings[0]!;
    expect(f.evidence.edge_class).toBe("declared");
    expect(Array.isArray(f.evidence.changed_fields)).toBe(true);
    expect(f.evidence.baseline).toBe("2025-01-01T00:00:00.000Z");
    expect(typeof f.evidence.question).toBe("string");
  });

  it("fingerprint = fingerprint(evidence)", async () => {
    const item = makeWorkItem("notes/artifact.md", "notes/unit.md");
    const adapter = makeTier2QueueAdapter(async () => [item]);
    const findings = await adapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings[0]!;
    expect(f.fingerprint).toBe(fingerprint(f.evidence));
  });

  it("certainty is 'medium'", async () => {
    const item = makeWorkItem("notes/artifact.md", "notes/unit.md");
    const adapter = makeTier2QueueAdapter(async () => [item]);
    const findings = await adapter.list(vaultRoot, adminAccess, FIXED_NOW);
    expect(findings[0]!.certainty).toBe("medium");
  });

  it("suggested_action and verify_predicate are non-empty strings", async () => {
    const item = makeWorkItem("notes/artifact.md", "notes/unit.md");
    const adapter = makeTier2QueueAdapter(async () => [item]);
    const findings = await adapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings[0]!;
    expect(typeof f.suggested_action).toBe("string");
    expect(f.suggested_action.length).toBeGreaterThan(0);
    expect(typeof f.verify_predicate).toBe("string");
    expect(f.verify_predicate.length).toBeGreaterThan(0);
  });

  it("identityOf(raw) and fingerprintOf(raw) match stored values", async () => {
    const item = makeWorkItem("notes/artifact.md", "notes/unit.md");
    const adapter = makeTier2QueueAdapter(async () => [item]);
    const findings = await adapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings[0]!;
    expect(adapter.identityOf(f)).toBe(f.identity_key);
    expect(adapter.fingerprintOf(f)).toBe(f.fingerprint);
  });

  it("reproduces returns true when item is still in live set", async () => {
    const item = makeWorkItem("notes/artifact.md", "notes/unit.md");
    const adapter = makeTier2QueueAdapter(async () => [item]);
    const findings = await adapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings[0]!;
    const result = await adapter.reproduces(f.identity_key, vaultRoot, adminAccess, FIXED_NOW);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Covering verdict → disappears from live set (reproduces false)
// ---------------------------------------------------------------------------

describe("makeTier2QueueAdapter — Scenario 2: covered row → disappears from live set", () => {
  let vaultRoot: string;
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-tier2-covered-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    });
    writeDoc(
      vaultRoot,
      "notes/artifact.md",
      frontmatter({ title: "Artifact", collection: "notes" }) + "# Body\n",
    );
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("reproduces returns false when live set is empty (no pending items)", async () => {
    // First list with the item present
    const item = makeWorkItem("notes/artifact.md", "notes/unit.md");
    let items = [item];
    const adapter = makeTier2QueueAdapter(async () => items);
    const findings = await adapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings[0]!;
    const capturedId = f.identity_key;

    // Now simulate a verdict covering the row — clear the live set
    items = [];
    const result = await adapter.reproduces(capturedId, vaultRoot, adminAccess, FIXED_NOW);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Tuple identity stable across runs
// ---------------------------------------------------------------------------

describe("makeTier2QueueAdapter — Scenario 3: tuple identity stable across list() calls", () => {
  let vaultRoot: string;
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-tier2-stable-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    });
    writeDoc(
      vaultRoot,
      "notes/artifact.md",
      frontmatter({ title: "Artifact", collection: "notes" }) + "# Body\n",
    );
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("identity_key does not change across two list() calls with same items", async () => {
    const item = makeWorkItem("notes/artifact.md", "notes/unit.md");
    const adapter = makeTier2QueueAdapter(async () => [item]);

    const run1 = await adapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const run2 = await adapter.list(vaultRoot, adminAccess, new Date("2026-06-01T00:00:00Z"));
    expect(run1[0]!.identity_key).toBe(run2[0]!.identity_key);
  });

  it("different (artifact,unit,edgeClass) triples produce different identity_keys", async () => {
    const item1 = makeWorkItem("notes/artifact.md", "notes/unit.md", "declared");
    const item2 = makeWorkItem("notes/artifact.md", "notes/unit.md", "earned");
    const item3 = makeWorkItem("notes/artifact.md", "notes/other-unit.md", "declared");

    const adapter = makeTier2QueueAdapter(async () => [item1, item2, item3]);
    // Write additional docs for RBAC
    writeDoc(
      vaultRoot,
      "notes/other-unit.md",
      frontmatter({ title: "Other", collection: "notes" }) + "# Other\n",
    );
    const findings = await adapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const ids = findings.map((f) => f.identity_key);
    // All three are distinct
    expect(new Set(ids).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: RBAC — denied artifact collection → omitted entirely
// ---------------------------------------------------------------------------

describe("makeTier2QueueAdapter — Scenario 4: RBAC omission for denied artifact collection", () => {
  let vaultRoot: string;
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-tier2-rbac-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
      analyst: { read: ["notes"], write: ["notes"] },
    });
    // notes artifact — readable by analyst
    writeDoc(
      vaultRoot,
      "notes/artifact.md",
      frontmatter({ title: "Artifact", collection: "notes" }) + "# Body\n",
    );
    // restricted artifact — NOT readable by analyst
    writeDoc(
      vaultRoot,
      "restricted/secret-artifact.md",
      frontmatter({ title: "Secret", collection: "restricted" }) + "# Secret\n",
    );
    writeDoc(
      vaultRoot,
      "notes/unit.md",
      frontmatter({ title: "Unit", collection: "notes" }) + "# Unit\n",
    );
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("admin sees findings for both artifacts", async () => {
    const item1 = makeWorkItem("notes/artifact.md", "notes/unit.md");
    const item2 = makeWorkItem("restricted/secret-artifact.md", "notes/unit.md");
    const adapter = makeTier2QueueAdapter(async () => [item1, item2]);
    const findings = await adapter.list(vaultRoot, adminAccess, FIXED_NOW);
    expect(findings).toHaveLength(2);
    const artifacts = findings.map((f) => (f.target as Tier2Target).artifact);
    expect(artifacts).toContain("notes/artifact.md");
    expect(artifacts).toContain("restricted/secret-artifact.md");
  });

  it("scoped analyst only sees the notes artifact finding — restricted omitted", async () => {
    const item1 = makeWorkItem("notes/artifact.md", "notes/unit.md");
    const item2 = makeWorkItem("restricted/secret-artifact.md", "notes/unit.md");
    const adapter = makeTier2QueueAdapter(async () => [item1, item2]);
    const findings = await adapter.list(vaultRoot, scopedAccess, FIXED_NOW);
    expect(findings).toHaveLength(1);
    expect((findings[0]!.target as Tier2Target).artifact).toBe("notes/artifact.md");
  });

  it("reproduces for restricted artifact returns false for scoped role", async () => {
    const item1 = makeWorkItem("notes/artifact.md", "notes/unit.md");
    const item2 = makeWorkItem("restricted/secret-artifact.md", "notes/unit.md");
    const adapter = makeTier2QueueAdapter(async () => [item1, item2]);

    // Get the restricted finding identity as admin
    const adminFindings = await adapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const restricted = adminFindings.find(
      (f) => (f.target as Tier2Target).artifact === "restricted/secret-artifact.md",
    );
    expect(restricted).toBeDefined();

    // Scoped role cannot reproduce it
    const result = await adapter.reproduces(
      restricted!.identity_key,
      vaultRoot,
      scopedAccess,
      FIXED_NOW,
    );
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Identity non-collision with edge-staleness (source+check differ)
// ---------------------------------------------------------------------------

describe("tier2QueueAdapter — Scenario 5: identity keys disjoint from edge-staleness", () => {
  it("tier2-queue and edge-staleness produce different identity_keys for same (artifact,unit,edgeClass)", () => {
    // edge-staleness uses source="staleness", check="edge-staleness"
    // tier2-queue uses source="tier2", check=<some stable name>
    const target: Tier2Target = {
      kind: "tier2",
      artifact: "notes/artifact.md",
      unit: "notes/unit.md",
      edgeClass: "declared",
    };

    const edgeStalenessKey = deriveIdentity("staleness", "edge-staleness", target);
    const tier2QueueKey = deriveIdentity("tier2", "pending-unchecked", target);

    // They must be different because source+check differ
    expect(tier2QueueKey).not.toBe(edgeStalenessKey);
    // Both are 64-char hex hashes
    expect(edgeStalenessKey).toMatch(/^[0-9a-f]{64}$/);
    expect(tier2QueueKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Production smoke test — real wiring does not throw on a minimal vault
// ---------------------------------------------------------------------------

describe("tier2QueueAdapter (production) — Scenario 6: smoke test on empty vault", () => {
  let vaultRoot: string;

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-tier2-smoke-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    });
    // Write a minimal doc with no sources (no tier-2 queue items expected)
    writeDoc(
      vaultRoot,
      "notes/baseline.md",
      frontmatter({ title: "Baseline", collection: "notes", sources: [] }) + "# Baseline\n",
    );
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("production tier2QueueAdapter.list() does not throw on a minimal vault", async () => {
    const findings = await tier2QueueAdapter.list(vaultRoot, adminAccess, new Date());
    // Minimal vault with no tier-2 sources → no findings (or empty)
    expect(Array.isArray(findings)).toBe(true);
  });

  it("production tier2QueueAdapter.reproduces() does not throw for an unknown id", async () => {
    const result = await tier2QueueAdapter.reproduces(
      "0".repeat(64),
      vaultRoot,
      adminAccess,
      new Date(),
    );
    expect(result).toBe(false);
  });
});
