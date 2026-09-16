// staleness.test.ts — TDD test suite for U6: staleness + edge-staleness
// source adapters.
//
// Two adapters under test:
//   ttlStalenessAdapter  — wraps computeStaleness over expired docs.
//                          target: StalenessTarget { kind:"staleness", path }
//   edgeStalenessAdapter — wraps upstreamStaleness (dependency-injected for
//                          testability) for pending-broken rows.
//                          target: Tier2Target { kind:"tier2", artifact, unit, edgeClass }
//
// Edge-staleness fixture strategy: DEPENDENCY INJECTION via factory.
//   Constructing a full edge-staleness graph fixture (consumes.jsonl +
//   curation-log.jsonl + edges.jsonl + tier-2 verdicts) is disproportionate
//   for unit-testing the adapter's mapping logic. Instead,
//   `makeEdgeStalenessAdapter` accepts a `_upstreamStalenessFn` seam
//   (artifact → UpstreamStaleness[]) that tests inject with a pre-canned
//   result. The production export `edgeStalenessAdapter` uses the real
//   upstreamStaleness loading path.
//   This approach is documented in staleness.ts.
//
// Edge states surfaced: ONLY "pending-broken".
//   "pending-unchecked", "pending-compatible", "current", and "unverifiable"
//   are NOT surfaced on the board. Documented in staleness.ts.
//
// Run with:
//   npx vitest run src/board/sources/staleness.test.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../access/rbac.js";
import type { UpstreamStaleness } from "../../curation/edge-staleness.js";
import { requireDefined } from "../../test-utils/require-defined.js";
import type { RoleConfig } from "../../utils/config.js";
import { deriveIdentity, fingerprint } from "../identity.js";
import type { FindingSourceAdapter, Tier2Target } from "../types.js";
import { resolveAdapterForIdentity, SOURCE_ADAPTERS } from "./index.js";
import {
  edgeStalenessAdapter,
  makeEdgeStalenessAdapter,
  ttlStalenessAdapter,
} from "./staleness.js";

// ---------------------------------------------------------------------------
// Vault fixture helpers (mirrors lint.test.ts)
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
// TTL Staleness Adapter tests
// ---------------------------------------------------------------------------

describe("ttlStalenessAdapter", () => {
  let vaultRoot: string;
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-ttl-staleness-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
      analyst: { read: ["notes"], write: ["notes"] },
    });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Expired-TTL doc → staleness finding emitted.
  // Identity is stable; fingerprint drifts with score/ageDays.
  // -------------------------------------------------------------------------
  describe("Scenario 1: expired-TTL doc → finding with identity-stable / fingerprint-drifts", () => {
    // doc updated 200 days before FIXED_NOW, ttl_days: 90 → expired
    const staleDate = new Date(new Date("2026-01-01T00:00:00Z").getTime() - 200 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    beforeEach(() => {
      writeDoc(
        vaultRoot,
        "notes/expired-doc.md",
        `${frontmatter({
          title: "Expired",
          collection: "notes",
          updated: staleDate,
          ttl_days: 90,
        })}# Expired\n`,
      );
    });

    it("emits a ttl-staleness finding for the expired doc", async () => {
      const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const f = findings.find(
        (f) =>
          f.check === "ttl-staleness" &&
          f.target.kind === "staleness" &&
          f.target.path === "notes/expired-doc.md",
      );
      expect(f).toBeDefined();
    });

    it("finding has source='staleness', StalenessTarget with correct path", async () => {
      const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const f = findings.find(
        (f) =>
          f.check === "ttl-staleness" &&
          f.target.kind === "staleness" &&
          f.target.path === "notes/expired-doc.md",
      );
      expect(f).toBeDefined();
      expect(requireDefined(f).source).toBe("staleness");
      expect(requireDefined(f).target).toEqual({ kind: "staleness", path: "notes/expired-doc.md" });
    });

    it("identity_key = deriveIdentity('staleness','ttl-staleness',target) — no discriminator", async () => {
      const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const f = findings.find(
        (f) =>
          f.check === "ttl-staleness" &&
          f.target.kind === "staleness" &&
          f.target.path === "notes/expired-doc.md",
      );
      expect(f).toBeDefined();
      const expected = deriveIdentity("staleness", "ttl-staleness", {
        kind: "staleness",
        path: "notes/expired-doc.md",
      });
      expect(requireDefined(f).identity_key).toBe(expected);
      expect(requireDefined(f).discriminator).toBeUndefined();
    });

    it("fingerprint = fingerprint(evidence) where evidence is volatile (score,ageDays,ttlDays)", async () => {
      const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const f = findings.find(
        (f) =>
          f.check === "ttl-staleness" &&
          f.target.kind === "staleness" &&
          f.target.path === "notes/expired-doc.md",
      );
      expect(f).toBeDefined();
      // fingerprint covers full evidence — score and ageDays are the volatile parts,
      // ttlDays is stable but included. fingerprintOf uses fingerprint(raw.evidence)
      // which must be consistent with how list() stored the fingerprint.
      const expectedFp = fingerprint(requireDefined(f).evidence);
      expect(requireDefined(f).fingerprint).toBe(expectedFp);
    });

    it("identity STABLE across two runs while fingerprint DRIFTS as ageDays grows", async () => {
      // Run 1: 200 days past update
      const findings1 = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const f1 = findings1.find(
        (f) =>
          f.check === "ttl-staleness" &&
          f.target.kind === "staleness" &&
          f.target.path === "notes/expired-doc.md",
      );
      expect(f1).toBeDefined();

      // Run 2: 210 days past update (10 more days → ageDays changed)
      const now2 = new Date(FIXED_NOW.getTime() + 10 * 86_400_000);
      const findings2 = await ttlStalenessAdapter.list(vaultRoot, adminAccess, now2);
      const f2 = findings2.find(
        (f) =>
          f.check === "ttl-staleness" &&
          f.target.kind === "staleness" &&
          f.target.path === "notes/expired-doc.md",
      );
      expect(f2).toBeDefined();

      // Identity is STABLE
      expect(requireDefined(f1).identity_key).toBe(requireDefined(f2).identity_key);

      // Fingerprint DRIFTS because ageDays changed (200 → 210)
      expect(requireDefined(f1).evidence.ageDays).toBe(200);
      expect(requireDefined(f2).evidence.ageDays).toBe(210);
      expect(requireDefined(f1).fingerprint).not.toBe(requireDefined(f2).fingerprint);
    });

    it("evidence carries score, ageDays, ttlDays with correct values", async () => {
      const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const f = findings.find(
        (f) =>
          f.check === "ttl-staleness" &&
          f.target.kind === "staleness" &&
          f.target.path === "notes/expired-doc.md",
      );
      expect(f).toBeDefined();
      expect(typeof requireDefined(f).evidence.score).toBe("number");
      expect(typeof requireDefined(f).evidence.ageDays).toBe("number");
      expect(requireDefined(f).evidence.ttlDays).toBe(90);
      expect(requireDefined(f).evidence.ageDays).toBe(200);
      expect(requireDefined(f).evidence.score).toBe(1); // min(1, 200/90) = 1
    });

    it("identityOf(raw) returns the same identity_key as stored", async () => {
      const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const f = findings.find(
        (f) =>
          f.check === "ttl-staleness" &&
          f.target.kind === "staleness" &&
          f.target.path === "notes/expired-doc.md",
      );
      expect(f).toBeDefined();
      expect(ttlStalenessAdapter.identityOf(requireDefined(f))).toBe(
        requireDefined(f).identity_key,
      );
    });

    it("fingerprintOf(raw) returns the same fingerprint as stored", async () => {
      const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const f = findings.find(
        (f) =>
          f.check === "ttl-staleness" &&
          f.target.kind === "staleness" &&
          f.target.path === "notes/expired-doc.md",
      );
      expect(f).toBeDefined();
      expect(ttlStalenessAdapter.fingerprintOf(requireDefined(f))).toBe(
        requireDefined(f).fingerprint,
      );
    });

    it("certainty is 'medium'", async () => {
      const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const f = findings.find(
        (f) =>
          f.check === "ttl-staleness" &&
          f.target.kind === "staleness" &&
          f.target.path === "notes/expired-doc.md",
      );
      expect(f).toBeDefined();
      expect(requireDefined(f).certainty).toBe("medium");
    });

    it("suggested_action and verify_predicate are non-empty strings", async () => {
      const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const f = findings.find(
        (f) =>
          f.check === "ttl-staleness" &&
          f.target.kind === "staleness" &&
          f.target.path === "notes/expired-doc.md",
      );
      expect(f).toBeDefined();
      expect(typeof requireDefined(f).suggested_action).toBe("string");
      expect(requireDefined(f).suggested_action.length).toBeGreaterThan(0);
      expect(typeof requireDefined(f).verify_predicate).toBe("string");
      expect(requireDefined(f).verify_predicate.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Non-expired docs → no finding.
  // -------------------------------------------------------------------------
  describe("Scenario 2: non-expired doc → no finding", () => {
    it("doc with ttl_days=null is never emitted", async () => {
      writeDoc(
        vaultRoot,
        "notes/no-ttl.md",
        `${frontmatter({
          title: "No TTL",
          collection: "notes",
          updated: "2020-01-01",
          ttl_days: null,
        })}# No TTL\n`,
      );
      const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const paths = findings.map((f) => (f.target.kind === "staleness" ? f.target.path : ""));
      expect(paths).not.toContain("notes/no-ttl.md");
    });

    it("doc updated recently within TTL is not emitted", async () => {
      // updated 10 days before FIXED_NOW, ttl=90 → NOT expired
      const recentDate = new Date(FIXED_NOW.getTime() - 10 * 86_400_000).toISOString().slice(0, 10);
      writeDoc(
        vaultRoot,
        "notes/fresh-doc.md",
        `${frontmatter({
          title: "Fresh",
          collection: "notes",
          updated: recentDate,
          ttl_days: 90,
        })}# Fresh\n`,
      );
      const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const paths = findings.map((f) => (f.target.kind === "staleness" ? f.target.path : ""));
      expect(paths).not.toContain("notes/fresh-doc.md");
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3: RBAC — denied collection finding omitted entirely (R17).
  // -------------------------------------------------------------------------
  describe("Scenario 3: RBAC omits denied-collection TTL findings", () => {
    const staleDate = new Date(new Date("2026-01-01T00:00:00Z").getTime() - 200 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    beforeEach(() => {
      // Expired doc in "notes" — readable by scopedRole
      writeDoc(
        vaultRoot,
        "notes/expired-readable.md",
        `${frontmatter({
          title: "Expired Readable",
          collection: "notes",
          updated: staleDate,
          ttl_days: 90,
        })}# Expired Readable\n`,
      );
      // Expired doc in "restricted" — NOT readable by scopedRole
      writeDoc(
        vaultRoot,
        "restricted/expired-secret.md",
        `${frontmatter({
          title: "Expired Secret",
          collection: "restricted",
          updated: staleDate,
          ttl_days: 90,
        })}# Expired Secret\n`,
      );
    });

    it("admin sees findings from both collections", async () => {
      const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const paths = findings.map((f) => (f.target.kind === "staleness" ? f.target.path : ""));
      expect(paths).toContain("notes/expired-readable.md");
      expect(paths).toContain("restricted/expired-secret.md");
    });

    it("scoped role sees 'notes' finding but not 'restricted' finding", async () => {
      const findings = await ttlStalenessAdapter.list(vaultRoot, scopedAccess, FIXED_NOW);
      const paths = findings.map((f) => (f.target.kind === "staleness" ? f.target.path : ""));
      expect(paths).toContain("notes/expired-readable.md");
      expect(paths).not.toContain("restricted/expired-secret.md");
    });

    it("omission is total — no placeholder for denied finding", async () => {
      const adminFindings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const scopedFindings = await ttlStalenessAdapter.list(vaultRoot, scopedAccess, FIXED_NOW);
      expect(scopedFindings.length).toBeLessThanOrEqual(adminFindings.length);
      for (const f of scopedFindings) {
        if (f.target.kind === "staleness") {
          expect(f.target.path).not.toMatch(/^restricted\//);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4: reproduces() lifecycle.
  // -------------------------------------------------------------------------
  describe("Scenario 4: reproduces() returns true while expired, false after refresh", () => {
    const staleDate = new Date(new Date("2026-01-01T00:00:00Z").getTime() - 200 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    beforeEach(() => {
      writeDoc(
        vaultRoot,
        "notes/reproduced-doc.md",
        `${frontmatter({
          title: "Reproduced",
          collection: "notes",
          updated: staleDate,
          ttl_days: 90,
        })}# Reproduced\n`,
      );
    });

    it("reproduces returns true when doc is still expired", async () => {
      const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const f = findings.find(
        (f) =>
          f.check === "ttl-staleness" &&
          f.target.kind === "staleness" &&
          f.target.path === "notes/reproduced-doc.md",
      );
      expect(f).toBeDefined();
      const result = await ttlStalenessAdapter.reproduces(
        requireDefined(f).identity_key,
        vaultRoot,
        adminAccess,
        FIXED_NOW,
      );
      expect(result).toBe(true);
    });

    it("reproduces returns false when doc is refreshed within TTL (different now)", async () => {
      // Use a now close to the update date so the doc is NOT expired
      const freshNow = new Date(`${staleDate}T00:00:00Z`);
      freshNow.setDate(freshNow.getDate() + 10); // 10 days after update < 90 day TTL → not expired

      const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const f = findings.find(
        (f) =>
          f.check === "ttl-staleness" &&
          f.target.kind === "staleness" &&
          f.target.path === "notes/reproduced-doc.md",
      );
      expect(f).toBeDefined();

      const result = await ttlStalenessAdapter.reproduces(
        requireDefined(f).identity_key,
        vaultRoot,
        adminAccess,
        freshNow,
      );
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 5: FindingSourceAdapter interface — now injection compiles.
  // -------------------------------------------------------------------------
  describe("Scenario 5: FindingSourceAdapter interface supports now injection", () => {
    it("ttlStalenessAdapter is assignable to FindingSourceAdapter", () => {
      const adapter: FindingSourceAdapter = ttlStalenessAdapter;
      expect(typeof adapter.list).toBe("function");
      expect(typeof adapter.reproduces).toBe("function");
    });

    it("engine can inject now via FindingSourceAdapter interface", async () => {
      const adapter: FindingSourceAdapter = ttlStalenessAdapter;
      const findings = await adapter.list(vaultRoot, adminAccess, FIXED_NOW);
      expect(Array.isArray(findings)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 6: Finding shape defaults.
  // -------------------------------------------------------------------------
  describe("Scenario 6: Finding shape defaults (disposition, owner, history)", () => {
    const staleDate = new Date(new Date("2026-01-01T00:00:00Z").getTime() - 200 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    beforeEach(() => {
      writeDoc(
        vaultRoot,
        "notes/shape-doc.md",
        `${frontmatter({
          title: "Shape",
          collection: "notes",
          updated: staleDate,
          ttl_days: 90,
        })}# Shape\n`,
      );
    });

    it("findings have disposition='new', owner='', history=[]", async () => {
      const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      for (const f of findings) {
        expect(f.disposition).toBe("new");
        expect(f.owner).toBe("");
        expect(f.history).toEqual([]);
      }
    });

    it("first_seen and last_seen are ISO 8601 strings", async () => {
      const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      for (const f of findings) {
        expect(typeof f.first_seen).toBe("string");
        expect(new Date(f.first_seen).toISOString()).toBe(f.first_seen);
        expect(typeof f.last_seen).toBe("string");
        expect(new Date(f.last_seen).toISOString()).toBe(f.last_seen);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Edge Staleness Adapter tests (dependency-injection via makeEdgeStalenessAdapter)
// ---------------------------------------------------------------------------
//
// Strategy: `makeEdgeStalenessAdapter(fn)` produces an adapter that calls
// `fn(artifact)` instead of the real upstreamStaleness loading path.
// Tests inject a pre-canned function to drive the mapping logic.
//
// Surfaced states: ONLY "pending-broken". Other states are NOT surfaced.

describe("edgeStalenessAdapter (via makeEdgeStalenessAdapter injection)", () => {
  let vaultRoot: string;

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-edge-staleness-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
      analyst: { read: ["notes"], write: ["notes"] },
    });
    // Artifact doc in "notes" collection
    writeDoc(
      vaultRoot,
      "notes/artifact.md",
      frontmatter({ title: "Artifact", collection: "notes", updated: "2025-01-01" }) +
        "# Artifact\n",
    );
    // Unit (upstream) doc
    writeDoc(
      vaultRoot,
      "notes/unit.md",
      `${frontmatter({ title: "Unit", collection: "notes", updated: "2025-01-01" })}# Unit\n`,
    );
    // Artifact in "restricted" collection (for RBAC tests)
    writeDoc(
      vaultRoot,
      "restricted/secret-artifact.md",
      `${frontmatter({
        title: "Secret Artifact",
        collection: "restricted",
        updated: "2025-01-01",
      })}# Secret\n`,
    );
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Scenario 7: pending-broken row → finding with Tier2Target tuple identity.
  // -------------------------------------------------------------------------
  describe("Scenario 7: pending-broken row → finding with tuple identity", () => {
    const pendingBrokenRow: UpstreamStaleness = {
      unit: "notes/unit.md",
      edge_class: "compiled",
      staleness: "pending-broken",
      baseline: "2025-01-01T00:00:00.000Z",
      changed_fields: ["body"],
      reason: "tier-1: compiled edge affected by body change",
    };

    it("emits a finding for the pending-broken row", async () => {
      const adapter = makeEdgeStalenessAdapter(() => [pendingBrokenRow]);
      const findings = await adapter.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "edge-staleness" &&
          f.target.kind === "tier2" &&
          f.target.artifact === "notes/artifact.md" &&
          f.target.unit === "notes/unit.md" &&
          f.target.edgeClass === "compiled",
      );
      expect(f).toBeDefined();
    });

    it("finding has source='staleness', check='edge-staleness', Tier2Target shape", async () => {
      const adapter = makeEdgeStalenessAdapter(() => [pendingBrokenRow]);
      const findings = await adapter.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "edge-staleness" &&
          f.target.kind === "tier2" &&
          (f.target as Tier2Target).artifact === "notes/artifact.md",
      );
      expect(f).toBeDefined();
      expect(requireDefined(f).source).toBe("staleness");
      expect(requireDefined(f).check).toBe("edge-staleness");
      const target = requireDefined(f).target as Tier2Target;
      expect(target.kind).toBe("tier2");
      expect(target.artifact).toBe("notes/artifact.md");
      expect(target.unit).toBe("notes/unit.md");
      expect(target.edgeClass).toBe("compiled");
    });

    it("identity_key = deriveIdentity('staleness','edge-staleness',Tier2Target) — no discriminator", async () => {
      const adapter = makeEdgeStalenessAdapter(() => [pendingBrokenRow]);
      const findings = await adapter.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "edge-staleness" &&
          f.target.kind === "tier2" &&
          (f.target as Tier2Target).artifact === "notes/artifact.md",
      );
      expect(f).toBeDefined();
      const expectedTarget: Tier2Target = {
        kind: "tier2",
        artifact: "notes/artifact.md",
        unit: "notes/unit.md",
        edgeClass: "compiled",
      };
      const expected = deriveIdentity("staleness", "edge-staleness", expectedTarget);
      expect(requireDefined(f).identity_key).toBe(expected);
      expect(requireDefined(f).discriminator).toBeUndefined();
    });

    it("fingerprint = fingerprint(evidence) covering volatile fields (staleness,changed_fields,baseline,reason)", async () => {
      const adapter = makeEdgeStalenessAdapter(() => [pendingBrokenRow]);
      const findings = await adapter.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "edge-staleness" &&
          f.target.kind === "tier2" &&
          (f.target as Tier2Target).artifact === "notes/artifact.md",
      );
      expect(f).toBeDefined();
      // fingerprint covers full evidence — fingerprintOf must use fingerprint(raw.evidence)
      // which must be consistent with how list() stored the fingerprint.
      const expectedFp = fingerprint(requireDefined(f).evidence);
      expect(requireDefined(f).fingerprint).toBe(expectedFp);
    });

    it("identityOf(raw) returns the same identity_key", async () => {
      const adapter = makeEdgeStalenessAdapter(() => [pendingBrokenRow]);
      const findings = await adapter.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "edge-staleness" &&
          f.target.kind === "tier2" &&
          (f.target as Tier2Target).artifact === "notes/artifact.md",
      );
      expect(f).toBeDefined();
      expect(adapter.identityOf(requireDefined(f))).toBe(requireDefined(f).identity_key);
    });

    it("fingerprintOf(raw) returns the same fingerprint", async () => {
      const adapter = makeEdgeStalenessAdapter(() => [pendingBrokenRow]);
      const findings = await adapter.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "edge-staleness" &&
          f.target.kind === "tier2" &&
          (f.target as Tier2Target).artifact === "notes/artifact.md",
      );
      expect(f).toBeDefined();
      expect(adapter.fingerprintOf(requireDefined(f))).toBe(requireDefined(f).fingerprint);
    });

    it("tuple identity is unique per (artifact, unit, edgeClass)", async () => {
      const row2: UpstreamStaleness = {
        unit: "notes/other-unit.md",
        edge_class: "declared",
        staleness: "pending-broken",
        baseline: null,
        changed_fields: ["confidence"],
        reason: "tier-2: broken",
      };
      const adapter = makeEdgeStalenessAdapter(() => [pendingBrokenRow, row2]);
      const findings = await adapter.list(vaultRoot, adminAccess);
      const edgeFindings = findings.filter(
        (f) =>
          f.check === "edge-staleness" &&
          f.target.kind === "tier2" &&
          (f.target as Tier2Target).artifact === "notes/artifact.md",
      );
      expect(edgeFindings.length).toBeGreaterThanOrEqual(2);
      const keys = edgeFindings.map((f) => f.identity_key);
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });

    it("evidence carries staleness, changed_fields, reason, baseline", async () => {
      const adapter = makeEdgeStalenessAdapter(() => [pendingBrokenRow]);
      const findings = await adapter.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "edge-staleness" &&
          f.target.kind === "tier2" &&
          (f.target as Tier2Target).artifact === "notes/artifact.md",
      );
      expect(f).toBeDefined();
      expect(requireDefined(f).evidence.staleness).toBe("pending-broken");
      expect(requireDefined(f).evidence.changed_fields).toEqual(["body"]);
      expect(requireDefined(f).evidence.baseline).toBe("2025-01-01T00:00:00.000Z");
      expect(typeof requireDefined(f).evidence.reason).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 8: Only pending-broken surfaced; other states are NOT.
  // -------------------------------------------------------------------------
  describe("Scenario 8: only pending-broken rows are surfaced", () => {
    const statesNotSurfaced: UpstreamStaleness["staleness"][] = [
      "pending-unchecked",
      "pending-compatible",
      "current",
      "unverifiable",
    ];

    for (const staleness of statesNotSurfaced) {
      it(`${staleness} row → NOT emitted as a board finding`, async () => {
        const row: UpstreamStaleness = {
          unit: "notes/unit.md",
          edge_class: "declared",
          staleness,
          baseline: "2025-01-01T00:00:00.000Z",
          changed_fields: [],
          reason: "test",
        };
        const adapter = makeEdgeStalenessAdapter(() => [row]);
        const findings = await adapter.list(vaultRoot, adminAccess);
        const edgeFindings = findings.filter((f) => f.check === "edge-staleness");
        expect(edgeFindings.length).toBe(0);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 9: RBAC — denied ARTIFACT collection → finding omitted (R17).
  // -------------------------------------------------------------------------
  describe("Scenario 9: RBAC filters by artifact collection", () => {
    const pendingBrokenRow: UpstreamStaleness = {
      unit: "notes/unit.md",
      edge_class: "compiled",
      staleness: "pending-broken",
      baseline: "2025-01-01T00:00:00.000Z",
      changed_fields: ["body"],
      reason: "tier-1: affected",
    };

    it("admin sees findings for both notes and restricted artifacts", async () => {
      const adapter = makeEdgeStalenessAdapter(() => [pendingBrokenRow]);
      const findings = await adapter.list(vaultRoot, adminAccess);
      const artifacts = findings
        .filter((f) => f.check === "edge-staleness" && f.target.kind === "tier2")
        .map((f) => (f.target as Tier2Target).artifact);
      expect(artifacts).toContain("notes/artifact.md");
      expect(artifacts).toContain("restricted/secret-artifact.md");
    });

    it("scoped role sees notes artifact but NOT restricted artifact", async () => {
      const adapter = makeEdgeStalenessAdapter(() => [pendingBrokenRow]);
      const findings = await adapter.list(vaultRoot, scopedAccess);
      const artifacts = findings
        .filter((f) => f.check === "edge-staleness" && f.target.kind === "tier2")
        .map((f) => (f.target as Tier2Target).artifact);
      expect(artifacts).toContain("notes/artifact.md");
      expect(artifacts).not.toContain("restricted/secret-artifact.md");
    });

    it("omission is total — no placeholder for denied artifact finding", async () => {
      const adapter = makeEdgeStalenessAdapter(() => [pendingBrokenRow]);
      const adminFindings = await adapter.list(vaultRoot, adminAccess);
      const scopedFindings = await adapter.list(vaultRoot, scopedAccess);
      expect(scopedFindings.length).toBeLessThanOrEqual(adminFindings.length);
      for (const f of scopedFindings) {
        if (f.target.kind === "tier2") {
          expect((f.target as Tier2Target).artifact).not.toMatch(/^restricted\//);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 9b: RBAC — denied UNIT collection → finding omitted entirely.
  //
  // The finding target exposes the unit path; if the caller cannot read the
  // unit's collection, the finding is omitted even when the artifact is
  // readable. This matches vaultTier2Queue's both-endpoints-readable policy
  // and prevents upstream existence disclosure (#455).
  // -------------------------------------------------------------------------
  describe("Scenario 9b: RBAC omits finding when unit collection is denied", () => {
    const pendingBrokenRowRestrictedUnit: UpstreamStaleness = {
      unit: "restricted/secret-unit.md",
      edge_class: "declared",
      staleness: "pending-broken",
      baseline: "2025-01-01T00:00:00.000Z",
      changed_fields: ["body"],
      reason: "tier-1: affected",
    };
    const pendingBrokenRowReadableUnit: UpstreamStaleness = {
      unit: "notes/unit.md",
      edge_class: "declared",
      staleness: "pending-broken",
      baseline: "2025-01-01T00:00:00.000Z",
      changed_fields: ["body"],
      reason: "tier-1: affected",
    };

    beforeEach(() => {
      // Add a restricted unit doc to the vault for RBAC resolution
      writeDoc(
        vaultRoot,
        "restricted/secret-unit.md",
        frontmatter({ title: "Secret Unit", collection: "restricted", updated: "2025-01-01" }) +
          "# Secret\n",
      );
    });

    it("admin sees finding when unit is in restricted collection", async () => {
      const adapter = makeEdgeStalenessAdapter((artifact) =>
        artifact === "notes/artifact.md" ? [pendingBrokenRowRestrictedUnit] : [],
      );
      const findings = await adapter.list(vaultRoot, adminAccess);
      const edgeFindings = findings.filter(
        (f) =>
          f.check === "edge-staleness" &&
          f.target.kind === "tier2" &&
          (f.target as Tier2Target).artifact === "notes/artifact.md" &&
          (f.target as Tier2Target).unit === "restricted/secret-unit.md",
      );
      expect(edgeFindings.length).toBeGreaterThanOrEqual(1);
    });

    it("scoped analyst: artifact readable but unit in denied collection → finding OMITTED", async () => {
      // artifact=notes/artifact.md is readable by scopedRole (notes collection)
      // unit=restricted/secret-unit.md is NOT readable by scopedRole
      const adapter = makeEdgeStalenessAdapter((artifact) =>
        artifact === "notes/artifact.md" ? [pendingBrokenRowRestrictedUnit] : [],
      );
      const findings = await adapter.list(vaultRoot, scopedAccess);
      const denied = findings.filter(
        (f) =>
          f.check === "edge-staleness" &&
          f.target.kind === "tier2" &&
          (f.target as Tier2Target).unit === "restricted/secret-unit.md",
      );
      // Must be zero — unit existence must not leak
      expect(denied).toHaveLength(0);
    });

    it("scoped analyst sees readable-unit finding but not restricted-unit finding", async () => {
      const adapter = makeEdgeStalenessAdapter((artifact) =>
        artifact === "notes/artifact.md"
          ? [pendingBrokenRowRestrictedUnit, pendingBrokenRowReadableUnit]
          : [],
      );
      const findings = await adapter.list(vaultRoot, scopedAccess);
      const edgeFindings = findings.filter((f) => f.check === "edge-staleness");
      const units = edgeFindings.map((f) => (f.target as Tier2Target).unit);
      expect(units).toContain("notes/unit.md");
      expect(units).not.toContain("restricted/secret-unit.md");
    });

    it("omission is total — restricted unit path does not appear anywhere in denied findings", async () => {
      const adapter = makeEdgeStalenessAdapter((artifact) =>
        artifact === "notes/artifact.md" ? [pendingBrokenRowRestrictedUnit] : [],
      );
      const scopedFindings = await adapter.list(vaultRoot, scopedAccess);
      for (const f of scopedFindings) {
        if (f.target.kind === "tier2") {
          expect((f.target as Tier2Target).unit).not.toMatch(/^restricted\//);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 10: reproduces() — true when row still pending-broken, false after.
  // -------------------------------------------------------------------------
  describe("Scenario 10: reproduces() for edge-staleness", () => {
    const pendingBrokenRow: UpstreamStaleness = {
      unit: "notes/unit.md",
      edge_class: "compiled",
      staleness: "pending-broken",
      baseline: "2025-01-01T00:00:00.000Z",
      changed_fields: ["body"],
      reason: "tier-1: affected",
    };

    it("reproduces returns true when the row is still pending-broken", async () => {
      const adapter = makeEdgeStalenessAdapter(() => [pendingBrokenRow]);
      const findings = await adapter.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "edge-staleness" &&
          f.target.kind === "tier2" &&
          (f.target as Tier2Target).artifact === "notes/artifact.md",
      );
      expect(f).toBeDefined();
      const result = await adapter.reproduces(
        requireDefined(f).identity_key,
        vaultRoot,
        adminAccess,
      );
      expect(result).toBe(true);
    });

    it("reproduces returns false when the row resolves (no longer pending-broken)", async () => {
      const adapterBroken = makeEdgeStalenessAdapter(() => [pendingBrokenRow]);
      const findings = await adapterBroken.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "edge-staleness" &&
          f.target.kind === "tier2" &&
          (f.target as Tier2Target).artifact === "notes/artifact.md",
      );
      expect(f).toBeDefined();

      // Now inject no rows (row resolved to current)
      const adapterResolved = makeEdgeStalenessAdapter(() => []);
      const result = await adapterResolved.reproduces(
        requireDefined(f).identity_key,
        vaultRoot,
        adminAccess,
      );
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 11: makeEdgeStalenessAdapter conforms to FindingSourceAdapter.
  // -------------------------------------------------------------------------
  describe("Scenario 11: makeEdgeStalenessAdapter conforms to FindingSourceAdapter", () => {
    it("produced adapter is assignable to FindingSourceAdapter", () => {
      const adapter: FindingSourceAdapter = makeEdgeStalenessAdapter(() => []);
      expect(typeof adapter.list).toBe("function");
      expect(typeof adapter.reproduces).toBe("function");
    });
  });
});

// ---------------------------------------------------------------------------
// Registry tests — SOURCE_ADAPTERS array
// ---------------------------------------------------------------------------

describe("SOURCE_ADAPTERS registry (R22) after U6", () => {
  it("SOURCE_ADAPTERS contains ttlStalenessAdapter", () => {
    expect(SOURCE_ADAPTERS).toContain(ttlStalenessAdapter);
  });

  it("SOURCE_ADAPTERS contains edgeStalenessAdapter", () => {
    expect(SOURCE_ADAPTERS).toContain(edgeStalenessAdapter);
  });

  it("every adapter in SOURCE_ADAPTERS has all FindingSourceAdapter methods", () => {
    for (const adapter of SOURCE_ADAPTERS) {
      expect(typeof adapter.list).toBe("function");
      expect(typeof adapter.identityOf).toBe("function");
      expect(typeof adapter.fingerprintOf).toBe("function");
      expect(typeof adapter.reproduces).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 12: resolveAdapterForIdentity (C1)
//   Two adapters share source:"staleness" — a source→adapter map cannot
//   disambiguate. The resolver iterates SOURCE_ADAPTERS and returns the FIRST
//   adapter whose reproduces() recognises the key; an unknown key → null.
// ---------------------------------------------------------------------------

describe("resolveAdapterForIdentity (C1)", () => {
  let vaultRoot: string;
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z");
  const staleDate = new Date(new Date("2026-01-01T00:00:00Z").getTime() - 200 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-resolver-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    });
    // Expired TTL doc → produces a ttlStalenessAdapter identity_key
    writeDoc(
      vaultRoot,
      "notes/expired-for-resolver.md",
      `${frontmatter({
        title: "Expired Resolver",
        collection: "notes",
        updated: staleDate,
        ttl_days: 90,
      })}# Expired\n`,
    );
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("identity_key from ttlStalenessAdapter resolves to ttlStalenessAdapter (not edgeStalenessAdapter)", async () => {
    const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings.find((f) => f.check === "ttl-staleness" && f.target.kind === "staleness");
    expect(f).toBeDefined();

    const resolved = await resolveAdapterForIdentity(
      requireDefined(f).identity_key,
      vaultRoot,
      adminAccess,
      FIXED_NOW,
    );
    expect(resolved).toBe(ttlStalenessAdapter);
    expect(resolved).not.toBe(edgeStalenessAdapter);
  });

  it("edge-staleness identity_key for phantom paths resolves to null (not ttlStalenessAdapter)", async () => {
    // Build an edge-staleness identity_key manually — the identity is derived
    // purely from source/check/target. The docs don't actually exist in the
    // vault, so no adapter will reproduce this key.
    // Key validation: the resolver must NOT return ttlStalenessAdapter for an
    // edge-staleness key (the two adapters share source:"staleness" but their
    // identity_key namespaces are distinct).
    const target: Tier2Target = {
      kind: "tier2",
      artifact: "notes/artifact-does-not-exist.md",
      unit: "notes/unit-does-not-exist.md",
      edgeClass: "declared",
    };
    const edgeIdentityKey = deriveIdentity("staleness", "edge-staleness", target);

    const resolved = await resolveAdapterForIdentity(
      edgeIdentityKey,
      vaultRoot,
      adminAccess,
      FIXED_NOW,
    );
    // No real pending-broken row exists for these phantom paths → null.
    // Critically: it must NOT be ttlStalenessAdapter (wrong adapter).
    expect(resolved).toBeNull();
    expect(resolved).not.toBe(ttlStalenessAdapter);
  });

  it("an unknown identity_key resolves to null", async () => {
    const resolved = await resolveAdapterForIdentity(
      "staleness:completely-unknown-identity-key-xyz",
      vaultRoot,
      adminAccess,
      FIXED_NOW,
    );
    expect(resolved).toBeNull();
  });

  it("ttl identity_key does NOT resolve to edgeStalenessAdapter — disambiguates correctly", async () => {
    // Both adapters emit source:"staleness" — a map keyed by source cannot
    // distinguish them. The resolver must not return the wrong adapter.
    const findings = await ttlStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    const f = findings.find((f) => f.check === "ttl-staleness");
    expect(f).toBeDefined();

    // edgeStalenessAdapter.reproduces should return false for a ttl key.
    const edgeReproduces = await edgeStalenessAdapter.reproduces(
      requireDefined(f).identity_key,
      vaultRoot,
      adminAccess,
      FIXED_NOW,
    );
    expect(edgeReproduces).toBe(false);

    // Only ttlStalenessAdapter.reproduces should return true.
    const ttlReproduces = await ttlStalenessAdapter.reproduces(
      requireDefined(f).identity_key,
      vaultRoot,
      adminAccess,
      FIXED_NOW,
    );
    expect(ttlReproduces).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 13: edgeStalenessAdapter production smoke test (I1)
//   Exercises the real load path (readProvenanceLog / readTier2Verdicts /
//   listEdges / loadDocuments / upstreamStaleness) on a real temp vault.
//   Goal: a wiring bug (wrong import, wrong arg order) must not hide behind
//   injected-fn tests.
//
//   Vault seeded with: one doc + a minimal provenance log (no edges).
//   Expected: list() returns an array (possibly empty) WITHOUT throwing.
//   We do NOT seed a full edge because constructing a valid provenance/
//   consumes/edges fixture for the declared-edge path is disproportionate for
//   a smoke test; the injected-fn tests cover that mapping logic exhaustively.
// ---------------------------------------------------------------------------

describe("edgeStalenessAdapter production smoke test (I1)", () => {
  let vaultRoot: string;
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-edge-smoke-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    });
    // One doc with sources: [] (no declared upstream)
    writeDoc(
      vaultRoot,
      "notes/smoke-doc.md",
      `${frontmatter({
        title: "Smoke",
        collection: "notes",
        updated: "2025-06-01",
        sources: [],
      })}# Smoke\n`,
    );
    // Minimal provenance log: one entry for smoke-doc (no upstream to be stale on)
    const daftariDir = join(vaultRoot, ".daftari");
    mkdirSync(daftariDir, { recursive: true });
    const provenanceEntry = JSON.stringify({
      file: "notes/smoke-doc.md",
      action: "write",
      timestamp: "2025-06-01T00:00:00.000Z",
      changed_fields: ["body"],
    });
    writeFileSync(join(daftariDir, "curation-log.jsonl"), `${provenanceEntry}\n`, "utf-8");
    // Note: no edges.jsonl and no tier2-verdicts.jsonl seeded — these are
    // optional (absent-file is treated as "no entries" by the loaders).
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("production edgeStalenessAdapter.list() runs without throwing on a vault with a provenance log", async () => {
    // The real load path must complete without error even when edges/verdicts
    // are absent. Result is [] (no declared sources → no rows to classify).
    let findings: import("../types.js").Finding[] | undefined;
    await expect(
      (async () => {
        findings = await edgeStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      })(),
    ).resolves.not.toThrow();
    expect(Array.isArray(findings)).toBe(true);
  });

  it("production edgeStalenessAdapter.list() returns an array (zero or more findings)", async () => {
    const findings = await edgeStalenessAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
    // With sources:[] and no edges, no pending-broken rows exist → empty array.
    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBe(0);
  });

  it("production wiring loads without error — identityOf and fingerprintOf are functions", () => {
    // Basic structural check: the production singleton exports correct methods.
    expect(typeof edgeStalenessAdapter.list).toBe("function");
    expect(typeof edgeStalenessAdapter.identityOf).toBe("function");
    expect(typeof edgeStalenessAdapter.fingerprintOf).toBe("function");
    expect(typeof edgeStalenessAdapter.reproduces).toBe("function");
  });
});
