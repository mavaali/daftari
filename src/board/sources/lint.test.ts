// lint.test.ts — TDD test suite for U5: lint source adapter.
//
// Uses a real temp vault dir seeded with markdown files that trigger lint
// findings. RBAC is exercised via role fixtures (admin + scoped).
//
// Run with:
//   npx vitest run src/board/sources/lint.test.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../access/rbac.js";
import { requireDefined } from "../../test-utils/require-defined.js";
import type { RoleConfig } from "../../utils/config.js";
import { deriveIdentity, fingerprint } from "../identity.js";
import type { FindingSourceAdapter } from "../types.js";
import { SOURCE_ADAPTERS } from "./index.js";
import { lintAdapter } from "./lint.js";

// ---------------------------------------------------------------------------
// Vault fixture helpers
// ---------------------------------------------------------------------------

/** Minimal valid frontmatter for a document. collection = first path segment. */
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
        // Emit as a YAML block sequence so each item is on its own line.
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

/** Write a minimal config.yaml with given roles into the vault. */
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

/** Write a vault doc at a vault-relative path. */
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
  // can only read "notes" collection; "restricted" collection is denied
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
// Suite
// ---------------------------------------------------------------------------

describe("lintAdapter", () => {
  let vaultRoot: string;

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-lint-adapter-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
      analyst: { read: ["notes"], write: ["notes"] },
    });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Scenario 1: orphan doc → lint adapter emits a Finding with correct
  // identity + fingerprint.
  // -------------------------------------------------------------------------
  describe("Scenario 1: orphan doc emits a Finding", () => {
    beforeEach(() => {
      // An orphan doc: no other doc links to it → orphanFiles finding.
      writeDoc(
        vaultRoot,
        "notes/orphan-doc.md",
        `${frontmatter({
          title: "Orphan",
          collection: "notes",
          // updated 1 day ago — not stale unless ttl is very short
          updated: "2025-01-01",
          ttl_days: null,
        })}# Orphan\n\nNo one links here.\n`,
      );
    });

    it("emits at least one Finding for the orphan path", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess);
      const orphanFindings = findings.filter(
        (f) => f.check === "orphanFiles" && f.target.kind === "lint",
      );
      expect(orphanFindings.length).toBeGreaterThan(0);
      const f = orphanFindings.find(
        (f) => f.target.kind === "lint" && f.target.path === "notes/orphan-doc.md",
      );
      expect(f).toBeDefined();
    });

    it("Finding has source='lint', correct check, and LintTarget with the path", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "orphanFiles" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/orphan-doc.md",
      );
      expect(f).toBeDefined();
      expect(requireDefined(f).source).toBe("lint");
      expect(requireDefined(f).target).toEqual({ kind: "lint", path: "notes/orphan-doc.md" });
    });

    it("Finding identity_key matches deriveIdentity('lint', checkName, target)", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "orphanFiles" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/orphan-doc.md",
      );
      expect(f).toBeDefined();
      const expected = deriveIdentity("lint", "orphanFiles", {
        kind: "lint",
        path: "notes/orphan-doc.md",
      });
      expect(requireDefined(f).identity_key).toBe(expected);
    });

    it("Finding fingerprint matches fingerprint({ detail })", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "orphanFiles" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/orphan-doc.md",
      );
      expect(f).toBeDefined();
      const expectedFp = fingerprint({ detail: requireDefined(f).evidence.detail as string });
      expect(requireDefined(f).fingerprint).toBe(expectedFp);
    });

    it("identityOf(raw) returns the same identity_key as stored on the Finding", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "orphanFiles" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/orphan-doc.md",
      );
      expect(f).toBeDefined();
      expect(lintAdapter.identityOf(requireDefined(f))).toBe(requireDefined(f).identity_key);
    });

    it("fingerprintOf(raw) returns the same fingerprint as stored on the Finding", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "orphanFiles" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/orphan-doc.md",
      );
      expect(f).toBeDefined();
      expect(lintAdapter.fingerprintOf(requireDefined(f))).toBe(requireDefined(f).fingerprint);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: RBAC — denied-collection finding is omitted for scoped role.
  // The scoped role can only read "notes"; a finding in "restricted" is dropped.
  // -------------------------------------------------------------------------
  describe("Scenario 2: RBAC omits denied-collection findings", () => {
    beforeEach(() => {
      // An orphan doc in "notes" collection — readable by scopedRole.
      writeDoc(
        vaultRoot,
        "notes/readable.md",
        frontmatter({ title: "Readable", collection: "notes", updated: "2020-01-01" }) +
          "# Readable\n",
      );
      // An orphan doc in "restricted" collection — NOT readable by scopedRole.
      writeDoc(
        vaultRoot,
        "restricted/secret.md",
        frontmatter({ title: "Secret", collection: "restricted", updated: "2020-01-01" }) +
          "# Secret\n",
      );
    });

    it("admin sees findings from both collections", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess);
      const paths = findings.map((f) => (f.target.kind === "lint" ? f.target.path : ""));
      expect(paths).toContain("notes/readable.md");
      expect(paths).toContain("restricted/secret.md");
    });

    it("scoped role sees findings in 'notes' but not 'restricted'", async () => {
      const findings = await lintAdapter.list(vaultRoot, scopedAccess);
      const paths = findings.map((f) => (f.target.kind === "lint" ? f.target.path : ""));
      expect(paths).toContain("notes/readable.md");
      expect(paths).not.toContain("restricted/secret.md");
    });

    it("omission is total — no zero card or placeholder for denied finding", async () => {
      const adminFindings = await lintAdapter.list(vaultRoot, adminAccess);
      const scopedFindings = await lintAdapter.list(vaultRoot, scopedAccess);
      // Admin has more findings (or equal) because it can see restricted collection.
      // The scoped view must NOT have more findings than admin.
      expect(scopedFindings.length).toBeLessThanOrEqual(adminFindings.length);
      // No finding in scopedFindings references restricted/
      for (const f of scopedFindings) {
        if (f.target.kind === "lint") {
          expect(f.target.path).not.toMatch(/^restricted\//);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3: stale doc → staleFiles finding with certainty mapping.
  // A stale doc has exceeded its ttl — we verify the certainty field is set.
  // -------------------------------------------------------------------------
  describe("Scenario 3: stale doc emits staleFiles Finding with certainty", () => {
    const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

    beforeEach(() => {
      // A doc updated 200 days before FIXED_NOW with ttl_days: 90 → stale.
      const staleDate = new Date(FIXED_NOW.getTime() - 200 * 86_400_000).toISOString().slice(0, 10);
      writeDoc(
        vaultRoot,
        "notes/stale-doc.md",
        `${frontmatter({
          title: "Stale",
          collection: "notes",
          updated: staleDate,
          ttl_days: 90,
        })}# Stale doc\n`,
      );
    });

    it("emits a staleFiles finding for the stale doc", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const f = findings.find(
        (f) =>
          f.check === "staleFiles" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/stale-doc.md",
      );
      expect(f).toBeDefined();
    });

    it("staleFiles finding has certainty 'medium' (non-tier0 check)", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const f = findings.find(
        (f) =>
          f.check === "staleFiles" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/stale-doc.md",
      );
      expect(f).toBeDefined();
      expect(requireDefined(f).certainty).toBe("medium");
    });

    it("staleFiles Finding has suggested_action and verify_predicate set", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const f = findings.find(
        (f) =>
          f.check === "staleFiles" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/stale-doc.md",
      );
      expect(f).toBeDefined();
      expect(typeof requireDefined(f).suggested_action).toBe("string");
      expect(requireDefined(f).suggested_action.length).toBeGreaterThan(0);
      expect(typeof requireDefined(f).verify_predicate).toBe("string");
      expect(requireDefined(f).verify_predicate).toContain("staleFiles");
      expect(requireDefined(f).verify_predicate).toContain("notes/stale-doc.md");
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4: tier-0 check (brokenSourceRefs) → certainty "high".
  // -------------------------------------------------------------------------
  describe("Scenario 4: tier-0 check emits Finding with certainty 'high'", () => {
    beforeEach(() => {
      // A doc with an explicit broken vault dependency.
      writeDoc(
        vaultRoot,
        "notes/broken-ref-doc.md",
        `${frontmatter({
          title: "Broken Ref",
          collection: "notes",
          updated: "2025-01-01",
          sources: ["vault:notes/nonexistent-source.md"],
        })}# Broken Ref\n`,
      );
    });

    it("emits a brokenSourceRefs finding for the doc with broken sources", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "brokenSourceRefs" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/broken-ref-doc.md",
      );
      expect(f).toBeDefined();
    });

    it("brokenSourceRefs finding has certainty 'high' (tier-0 check)", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "brokenSourceRefs" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/broken-ref-doc.md",
      );
      expect(f).toBeDefined();
      expect(requireDefined(f).certainty).toBe("high");
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 5: reproduces() returns true while condition holds, false after fix.
  // We test with a stale doc:
  //   - reproduces returns true when doc is still stale (same now)
  //   - list returns no staleFiles finding when the doc is no longer stale
  //     (i.e., a newer now where the doc's updated date is within ttl)
  // -------------------------------------------------------------------------
  describe("Scenario 5: reproduces() true while condition holds, false after fix", () => {
    const STALE_NOW = new Date("2026-01-01T00:00:00Z");
    const staleDate = new Date(STALE_NOW.getTime() - 200 * 86_400_000).toISOString().slice(0, 10);

    beforeEach(() => {
      writeDoc(
        vaultRoot,
        "notes/staleness-check.md",
        `${frontmatter({
          title: "Staleness Check",
          collection: "notes",
          updated: staleDate,
          ttl_days: 90,
        })}# Staleness Check\n`,
      );
    });

    it("reproduces returns true when the stale condition still holds", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess, STALE_NOW);
      const f = findings.find(
        (f) =>
          f.check === "staleFiles" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/staleness-check.md",
      );
      expect(f).toBeDefined();
      const result = await lintAdapter.reproduces(
        requireDefined(f).identity_key,
        vaultRoot,
        adminAccess,
        STALE_NOW,
      );
      expect(result).toBe(true);
    });

    it("reproduces returns false when the condition no longer holds (different now makes doc fresh)", async () => {
      // Using a "now" close to the updated date means the doc is NOT stale (< 90 days).
      const freshNow = new Date(`${staleDate}T00:00:00Z`);
      freshNow.setDate(freshNow.getDate() + 10); // only 10 days after update → not stale

      const findings = await lintAdapter.list(vaultRoot, adminAccess, STALE_NOW);
      const f = findings.find(
        (f) =>
          f.check === "staleFiles" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/staleness-check.md",
      );
      expect(f).toBeDefined();

      // Now re-run reproduces with a fresh now → the stale condition no longer holds.
      const result = await lintAdapter.reproduces(
        requireDefined(f).identity_key,
        vaultRoot,
        adminAccess,
        freshNow,
      );
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 6: positionIntegrity can emit multiple findings per path.
  // Two position integrity issues for one doc → they map to the SAME identity
  // (no discriminator by default). This is the current conservative stance.
  // TODO: if distinct-per-issue identity is needed, add stable discriminators
  // from position IDs (which are stable and available in the detail).
  //
  // We verify the structural correctness: the adapter emits a positionIntegrity
  // finding for a doc with a position issue. Since multiple issues fold to one
  // identity, the adapter emits exactly one finding for that path+check.
  // -------------------------------------------------------------------------
  describe("Scenario 6: same identity regardless of check detail count", () => {
    beforeEach(() => {
      // A doc with a dangling superseded_by reference in positions.
      // position pos-1 claims superseded_by: pos-999 which doesn't exist in the
      // positions array. positionIntegrity will flag this.
      //
      // Use the full position YAML shape that the parser expects (see
      // test/witness/track-record.test.ts positionYaml helper for field names).
      const positionsYaml = [
        "positions:",
        '  - id: "pos-1"',
        '    principal: "alice"',
        '    stance: "assert"',
        "    statement: null",
        '    confidence: "medium"',
        '    provenance: "direct"',
        "    valid_from: null",
        '    superseded_by: "pos-999"',
        '    created: "2025-01-01"',
        "    sources: []",
      ].join("\n");
      writeDoc(
        vaultRoot,
        "notes/position-doc.md",
        `---\ntitle: Position Doc\ndomain: accumulation\ncollection: notes\nstatus: canonical\nconfidence: medium\ncreated: 2025-01-01\nupdated: 2025-01-01\nupdated_by: agent:seed\nprovenance: direct\nsources: []\nsuperseded_by: null\nttl_days: null\n${positionsYaml}\n---\n# Position Doc\n`,
      );
    });

    it("emits a positionIntegrity finding for the position doc", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "positionIntegrity" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/position-doc.md",
      );
      expect(f).toBeDefined();
    });

    it("positionIntegrity finding has a stable identity key", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess);
      const f = findings.find(
        (f) =>
          f.check === "positionIntegrity" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/position-doc.md",
      );
      expect(f).toBeDefined();
      const expected = deriveIdentity("lint", "positionIntegrity", {
        kind: "lint",
        path: "notes/position-doc.md",
      });
      expect(requireDefined(f).identity_key).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 7: Registry iteration yields the lint source (R22 shape).
  // -------------------------------------------------------------------------
  describe("Scenario 7: SOURCE_ADAPTERS registry contains the lint adapter", () => {
    it("SOURCE_ADAPTERS is a non-empty array", () => {
      expect(Array.isArray(SOURCE_ADAPTERS)).toBe(true);
      expect(SOURCE_ADAPTERS.length).toBeGreaterThan(0);
    });

    it("SOURCE_ADAPTERS contains the lintAdapter (same reference)", () => {
      expect(SOURCE_ADAPTERS).toContain(lintAdapter);
    });

    it("every adapter in SOURCE_ADAPTERS implements the FindingSourceAdapter interface", () => {
      for (const adapter of SOURCE_ADAPTERS) {
        expect(typeof adapter.list).toBe("function");
        expect(typeof adapter.identityOf).toBe("function");
        expect(typeof adapter.fingerprintOf).toBe("function");
        expect(typeof adapter.reproduces).toBe("function");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 8: disposition defaults, owner, history shape
  // -------------------------------------------------------------------------
  describe("Scenario 8: Finding shape defaults", () => {
    beforeEach(() => {
      writeDoc(
        vaultRoot,
        "notes/any-doc.md",
        `${frontmatter({ title: "Any", collection: "notes", updated: "2020-01-01" })}# Any\n`,
      );
    });

    it("findings have disposition='new', owner='', history=[]", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess);
      for (const f of findings) {
        expect(f.disposition).toBe("new");
        expect(f.owner).toBe("");
        expect(f.history).toEqual([]);
      }
    });

    it("first_seen and last_seen are ISO 8601 strings", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess);
      for (const f of findings) {
        expect(typeof f.first_seen).toBe("string");
        expect(new Date(f.first_seen).toISOString()).toBe(f.first_seen);
        expect(typeof f.last_seen).toBe("string");
        expect(new Date(f.last_seen).toISOString()).toBe(f.last_seen);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 9 (C1): verbatimQuoteOverrun — two conditions fire on same doc
  // → two DISTINCT Findings with distinct identity_keys and discriminators.
  // Resolving/removing one finding (by its identity_key) leaves the other.
  // -------------------------------------------------------------------------
  describe("Scenario 9 (C1): verbatimQuoteOverrun yields two independent findings", () => {
    const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

    beforeEach(() => {
      // Trigger BOTH verbatimQuoteOverrun conditions:
      //   1. char-overrun: totalChars > 8000 (DISTILL_NUMERIC_DEFAULTS.maxVerbatimChars)
      //   2. no-attribution: provenance=synthesized, sources=[], has verbatim quotes
      //
      // Build a body with 8001+ chars of verbatim-quoted text.
      // verbatimQuotes() matches "quoted text" and curly "quoted text" patterns.
      // Use straight-double-quoted spans, each on its own line.
      const oneQuote = `"${"x".repeat(200)}"`; // 202 chars per quote
      const manyQuotes = Array.from({ length: 41 }, () => oneQuote).join("\n"); // 41*202=8282 chars
      writeDoc(
        vaultRoot,
        "notes/verbatim-both.md",
        frontmatter({
          title: "Verbatim Both",
          collection: "notes",
          provenance: "synthesized",
          sources: [],
          updated: "2025-01-01",
        }) +
          "# Verbatim Both\n\n" +
          manyQuotes +
          "\n",
      );
    });

    it("emits exactly two verbatimQuoteOverrun findings for the doc", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const vqFindings = findings.filter(
        (f) =>
          f.check === "verbatimQuoteOverrun" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/verbatim-both.md",
      );
      expect(vqFindings.length).toBe(2);
    });

    it("the two findings have distinct identity_keys", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const vqFindings = findings.filter(
        (f) =>
          f.check === "verbatimQuoteOverrun" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/verbatim-both.md",
      );
      expect(vqFindings.length).toBe(2);
      const keys = vqFindings.map((f) => f.identity_key);
      expect(keys[0]).not.toBe(keys[1]);
    });

    it("one finding has discriminator 'char-overrun' and the other 'no-attribution'", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const vqFindings = findings.filter(
        (f) =>
          f.check === "verbatimQuoteOverrun" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/verbatim-both.md",
      );
      const discriminators = new Set(vqFindings.map((f) => f.discriminator));
      expect(discriminators).toContain("char-overrun");
      expect(discriminators).toContain("no-attribution");
    });

    it("each finding's identity_key matches deriveIdentity with its discriminator", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const vqFindings = findings.filter(
        (f) =>
          f.check === "verbatimQuoteOverrun" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/verbatim-both.md",
      );
      for (const f of vqFindings) {
        const expected = deriveIdentity("lint", "verbatimQuoteOverrun", f.target, f.discriminator);
        expect(f.identity_key).toBe(expected);
      }
    });

    it("removing one finding by identity_key leaves the other intact", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess, FIXED_NOW);
      const vqFindings = findings.filter(
        (f) =>
          f.check === "verbatimQuoteOverrun" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/verbatim-both.md",
      );
      expect(vqFindings.length).toBe(2);

      // Simulate "resolving" the char-overrun finding (filter it out).
      const charOverrunKey = vqFindings.find(
        (f) => f.discriminator === "char-overrun",
      )?.identity_key;
      const noAttrKey = vqFindings.find((f) => f.discriminator === "no-attribution")?.identity_key;
      expect(charOverrunKey).toBeDefined();
      expect(noAttrKey).toBeDefined();

      // After removing the char-overrun finding, the no-attribution one is still present.
      const remaining = findings.filter((f) => f.identity_key !== charOverrunKey);
      expect(remaining.some((f) => f.identity_key === noAttrKey)).toBe(true);

      // After removing the no-attribution finding, the char-overrun one is still present.
      const remaining2 = findings.filter((f) => f.identity_key !== noAttrKey);
      expect(remaining2.some((f) => f.identity_key === charOverrunKey)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 10 (I1): malformedPins — two malformed describes entries on the
  // same doc → two DISTINCT Findings with distinct identity_keys.
  // -------------------------------------------------------------------------
  describe("Scenario 10 (I1): malformedPins yields distinct findings per malformed entry", () => {
    beforeEach(() => {
      // Two malformed pin entries: pin suffix end < start.
      // Format: "repo:path#L<start>-<end>@<sha>"  (no brackets — see describes.ts PIN_SUFFIX)
      // SHA must be 7-40 lowercase hex chars.
      const sha = "a".repeat(40);
      writeDoc(
        vaultRoot,
        "notes/malformed-pins-doc.md",
        `${frontmatter({
          title: "Malformed Pins",
          collection: "notes",
          updated: "2025-01-01",
          describes: [
            // end (5) < start (10) → malformed
            `myrepo:src/foo.ts#L10-5@${sha}`,
            // end (3) < start (20) → malformed (different entry)
            `myrepo:src/bar.ts#L20-3@${sha}`,
          ],
        })}# Malformed Pins\n`,
      );
    });

    it("emits exactly two malformedPins findings for the doc", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess);
      const mpFindings = findings.filter(
        (f) =>
          f.check === "malformedPins" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/malformed-pins-doc.md",
      );
      expect(mpFindings.length).toBe(2);
    });

    it("the two malformedPins findings have distinct identity_keys", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess);
      const mpFindings = findings.filter(
        (f) =>
          f.check === "malformedPins" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/malformed-pins-doc.md",
      );
      expect(mpFindings.length).toBe(2);
      expect(requireDefined(mpFindings[0]).identity_key).not.toBe(
        requireDefined(mpFindings[1]).identity_key,
      );
    });

    it("each malformedPins finding has a discriminator derived from its describes entry", async () => {
      const findings = await lintAdapter.list(vaultRoot, adminAccess);
      const mpFindings = findings.filter(
        (f) =>
          f.check === "malformedPins" &&
          f.target.kind === "lint" &&
          f.target.path === "notes/malformed-pins-doc.md",
      );
      for (const f of mpFindings) {
        expect(typeof f.discriminator).toBe("string");
        expect((f.discriminator as string).length).toBeGreaterThan(0);
      }
      // The two discriminators must differ.
      expect(requireDefined(mpFindings[0]).discriminator).not.toBe(
        requireDefined(mpFindings[1]).discriminator,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 11 (I3): FindingSourceAdapter interface carries now parameter.
  // A FindingSourceAdapter-typed variable accepts lintAdapter and can call
  // list/reproduces with now injected — confirming the engine can inject now
  // through the interface type without requiring an intersection-type hack.
  // -------------------------------------------------------------------------
  describe("Scenario 11 (I3): FindingSourceAdapter interface supports now injection", () => {
    beforeEach(() => {
      writeDoc(
        vaultRoot,
        "notes/interface-check.md",
        frontmatter({ title: "Interface Check", collection: "notes", updated: "2020-01-01" }) +
          "# Interface Check\n",
      );
    });

    it("lintAdapter is assignable to FindingSourceAdapter (no intersection hack needed)", () => {
      // If lintAdapter required an intersection type to carry now, this
      // assignment would fail at the TypeScript level. The fact that this test
      // file compiles confirms the interface itself carries now.
      const adapter: FindingSourceAdapter = lintAdapter;
      expect(typeof adapter.list).toBe("function");
      expect(typeof adapter.reproduces).toBe("function");
    });

    it("engine can inject now via FindingSourceAdapter interface", async () => {
      const adapter: FindingSourceAdapter = lintAdapter;
      const FIXED_NOW = new Date("2026-01-01T00:00:00Z");
      // Call list with now through the interface type — this would be a type
      // error if FindingSourceAdapter.list didn't carry now?.
      const findings = await adapter.list(vaultRoot, adminAccess, FIXED_NOW);
      // We just care that the call compiles and returns an array.
      expect(Array.isArray(findings)).toBe(true);
    });

    it("engine can inject now via reproduces through the interface", async () => {
      const adapter: FindingSourceAdapter = lintAdapter;
      const FIXED_NOW = new Date("2026-01-01T00:00:00Z");
      // reproduces called through the interface with now — type-level proof.
      const result = await adapter.reproduces("nonexistent-key", vaultRoot, adminAccess, FIXED_NOW);
      expect(result).toBe(false);
    });
  });
});
