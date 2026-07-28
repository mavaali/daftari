// validityConflicts wired into vault_lint.
//
// This is where a malformed or contradictory interval finally surfaces. The
// schema layer deliberately refuses to flag one — an optional field must not
// be able to make a document unwritable — so lint is the only place that
// reports it, which is exactly the advisory posture the curation engine
// declares: it reports problems, it does not auto-fix them.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LINT_CHECKS, runLint } from "../../src/curation/lint.js";

function write(vault: string, name: string, over: Record<string, string>): void {
  const lines = Object.entries({
    title: name,
    domain: "accumulation",
    collection: "pricing",
    status: "canonical",
    confidence: "high",
    created: "2026-01-01",
    updated: "2026-01-01",
    updated_by: "agent:test",
    provenance: "direct",
    ...over,
  }).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(join(vault, name), `---\n${lines.join("\n")}\ntags: []\n---\n\nBody of ${name}.\n`);
}

describe("vault_lint — validityConflicts", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-lint-validity-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("is a registered lint check", () => {
    expect(LINT_CHECKS).toContain("validityConflicts");
  });

  it("reports nothing for a vault with no authored intervals", async () => {
    write(vault, "plain.md", {});
    const report = await runLint(vault);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checks.validityConflicts).toEqual([]);
  });

  it("flags a malformed endpoint, naming the raw value", async () => {
    write(vault, "typo.md", { valid_from: "January 2026" });
    const report = await runLint(vault);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const found = report.value.checks.validityConflicts;
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe("typo.md");
    expect(found[0]?.detail).toContain("malformed-endpoint");
    expect(found[0]?.detail).toContain("January 2026");
  });

  it("flags an inverted interval", async () => {
    write(vault, "inverted.md", { valid_from: "2026-06-01", valid_until: "2026-01-01" });
    const report = await runLint(vault);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checks.validityConflicts[0]?.detail).toContain("inverted");
  });

  it("flags a supersession overlap", async () => {
    write(vault, "v1.md", {
      superseded_by: "v2.md",
      valid_from: "2026-01-01",
      valid_until: "2026-12-31",
    });
    write(vault, "v2.md", { valid_from: "2026-04-01" });
    const report = await runLint(vault);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const details = report.value.checks.validityConflicts.map((f) => f.detail);
    expect(details.some((d) => d.includes("supersession-overlap"))).toBe(true);
  });

  it("does NOT make the document schema-invalid — validity never blocks a write", async () => {
    // Asserted end-to-end: a malformed interval is a lint finding and nothing
    // more. If schemaInvalid starts firing here, an optional field has become a
    // hard blocker in five subsystems. Design record, Decision 1.
    write(vault, "typo.md", { valid_from: "January 2026" });
    const report = await runLint(vault);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checks.validityConflicts).toHaveLength(1);
    expect(report.value.checks.schemaInvalid.map((f) => f.path)).not.toContain("typo.md");
  });

  it("counts its findings in totalFindings exactly once", async () => {
    write(vault, "typo.md", { valid_from: "January 2026" });
    const report = await runLint(vault);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const summed = LINT_CHECKS.reduce((n, c) => n + report.value.checks[c].length, 0);
    expect(report.value.totalFindings).toBe(summed);
  });

  it("computes over the caller-visible doc set", async () => {
    // #217: an invisible doc is excluded BEFORE the check runs, so it is
    // neither named in a finding nor able to influence one.
    write(vault, "visible.md", { valid_from: "2026-01-01" });
    write(vault, "hidden.md", { valid_from: "January 2026" });
    const report = await runLint(vault, { pathVisible: (p) => p !== "hidden.md" });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checks.validityConflicts).toEqual([]);
  });
});
