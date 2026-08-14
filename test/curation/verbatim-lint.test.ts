// test/curation/verbatim-lint.test.ts
//
// U12/R9 — verbatim-quote budget. Distill compiles conversation into
// paraphrased belief, so a synthesized note carrying long verbatim quotes — or
// any quote with no sources[] attribution — is a compile-quality smell. The
// `verbatimQuoteOverrun` lint check surfaces it, advisory-only (never a write
// blocker), scoped to synthesized provenance so manual notes may quote freely.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LINT_CHECKS, runLint, TIER0_LINT_CHECKS } from "../../src/curation/lint.js";

function writeDoc(
  vault: string,
  name: string,
  opts: { provenance?: string; sources?: string; body: string },
): void {
  const fm = [
    `title: ${name}`,
    "domain: accumulation",
    "collection: distill",
    "status: draft",
    "confidence: low",
    "created: 2026-01-01",
    "updated: 2026-01-01",
    "updated_by: agent:distill",
    `provenance: ${opts.provenance ?? "synthesized"}`,
    `sources: ${opts.sources ?? "[]"}`,
    "tags: []",
  ].join("\n");
  writeFileSync(join(vault, name), `---\n${fm}\n---\n\n${opts.body}\n`);
}

const CAP = 20;

describe("vault_lint — verbatimQuoteOverrun (U12)", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-verbatim-lint-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("is a registered, advisory (non-tier-0) check", () => {
    expect(LINT_CHECKS).toContain("verbatimQuoteOverrun");
    expect(TIER0_LINT_CHECKS).not.toContain("verbatimQuoteOverrun");
  });

  it("flags a synthesized doc whose verbatim quote exceeds the cap; lint stays advisory", async () => {
    const longQuote = "x".repeat(CAP + 20);
    writeDoc(vault, "over.md", {
      sources: '["distill:chat-a#c1"]',
      body: `The team decided "${longQuote}" during standup.`,
    });
    const report = await runLint(vault, { maxVerbatimChars: CAP });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const found = report.value.checks.verbatimQuoteOverrun;
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe("over.md");
    expect(found[0]?.detail).toContain(`exceed cap ${CAP}`);
    // Advisory only — it must not be a tier-0 (hard) finding.
    expect(TIER0_LINT_CHECKS).not.toContain("verbatimQuoteOverrun");
  });

  it("does not flag a within-cap quote that carries a sources[] attribution", async () => {
    writeDoc(vault, "fine.md", {
      sources: '["distill:chat-a#c1"]',
      body: 'She said "ok" and left.',
    });
    const report = await runLint(vault, { maxVerbatimChars: CAP });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checks.verbatimQuoteOverrun).toEqual([]);
  });

  it("flags a quote that lacks any sources[] attribution, regardless of size", async () => {
    writeDoc(vault, "noattr.md", {
      sources: "[]",
      body: 'He said "hi" today.',
    });
    const report = await runLint(vault, { maxVerbatimChars: CAP });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const found = report.value.checks.verbatimQuoteOverrun;
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe("noattr.md");
    expect(found[0]?.detail).toMatch(/no sources/);
  });

  it("does not flag a non-synthesized (direct) note that quotes freely", async () => {
    const longQuote = "y".repeat(CAP + 20);
    writeDoc(vault, "manual.md", {
      provenance: "direct",
      sources: "[]",
      body: `Verbatim from the doc: "${longQuote}".`,
    });
    const report = await runLint(vault, { maxVerbatimChars: CAP });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checks.verbatimQuoteOverrun).toEqual([]);
  });
});
