import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LINT_CHECKS, runLint, TIER0_LINT_CHECKS } from "../../src/curation/lint.js";

function writeDoc(vault: string, sources: string[]): void {
  writeFileSync(
    join(vault, "claim.md"),
    `---\n` +
      `title: Claim\n` +
      `domain: accumulation\n` +
      `collection: canon\n` +
      `status: draft\n` +
      `confidence: low\n` +
      `created: 2026-01-01\n` +
      `updated: 2026-01-01\n` +
      `updated_by: human:test\n` +
      `provenance: direct\n` +
      `sources: ${JSON.stringify(sources)}\n` +
      `tags: []\n` +
      `---\nClaim.\n`,
  );
}

describe("vault_lint — repository source references", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("registers repository verification as advisory, not tier 0", () => {
    expect(LINT_CHECKS.at(-1)).toBe("unverifiableSourceRefs");
    expect(TIER0_LINT_CHECKS).not.toContain("unverifiableSourceRefs");
  });

  it("accepts an existing repo-external file from a nested vault", async () => {
    const repo = mkdtempSync(join(tmpdir(), "daftari-repo-source-"));
    dirs.push(repo);
    const vault = join(repo, "vault");
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    mkdirSync(join(repo, "evidence"));
    writeFileSync(join(repo, "evidence", "source.md"), "external evidence");
    writeFileSync(join(vault, ".daftari", "config.yaml"), "repo_root: ..\n");
    writeDoc(vault, ["repo:evidence/source.md"]);

    const report = await runLint(vault);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checks.brokenSourceRefs).toEqual([]);
    expect(report.value.checks.unverifiableSourceRefs).toEqual([]);
  });

  it("reports missing and unconfigured repo references without making them tier 0", async () => {
    const vault = mkdtempSync(join(tmpdir(), "daftari-repo-source-"));
    dirs.push(vault);
    writeDoc(vault, ["repo:evidence/missing.md"]);

    const report = await runLint(vault);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checks.brokenSourceRefs).toEqual([]);
    expect(report.value.checks.unverifiableSourceRefs).toEqual([
      {
        path: "claim.md",
        detail: "unverifiable repository source(s): repo:evidence/missing.md (unconfigured)",
      },
    ]);
  });

  it("distinguishes a configured missing file from an unconfigured root", async () => {
    const repo = mkdtempSync(join(tmpdir(), "daftari-repo-source-"));
    dirs.push(repo);
    const vault = join(repo, "vault");
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(join(vault, ".daftari", "config.yaml"), "repo_root: ..\n");
    writeDoc(vault, ["repo:evidence/missing.md"]);

    const report = await runLint(vault);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checks.unverifiableSourceRefs[0]?.detail).toContain("(missing)");
  });

  it("does not touch or report repository metadata when verification is not authorized", async () => {
    const repo = mkdtempSync(join(tmpdir(), "daftari-repo-source-"));
    dirs.push(repo);
    const vault = join(repo, "vault");
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    mkdirSync(join(repo, "evidence"));
    writeFileSync(join(repo, "evidence", "exists.md"), "external evidence");
    writeFileSync(join(vault, ".daftari", "config.yaml"), "repo_root: ..\n");
    writeDoc(vault, ["repo:evidence/exists.md", "repo:evidence/missing.md"]);

    const report = await runLint(vault, { verifyRepoSources: false });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checks.unverifiableSourceRefs).toEqual([]);
  });

  it("labels distill refs as born-unverifiable without repository verification authority", async () => {
    const vault = mkdtempSync(join(tmpdir(), "daftari-distill-source-"));
    dirs.push(vault);
    writeDoc(vault, ["distill:session-42#claim-7"]);

    const report = await runLint(vault, { verifyRepoSources: false });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checks.brokenSourceRefs).toEqual([]);
    expect(report.value.checks.unverifiableSourceRefs).toEqual([
      {
        path: "claim.md",
        detail:
          "born-unverifiable distill source(s): distill:session-42#claim-7 — " +
          "external source, discarded by design — re-derivation means re-presenting the source",
      },
    ]);
  });

  it("groups repository and distill evidence into one finding per citing document", async () => {
    const repo = mkdtempSync(join(tmpdir(), "daftari-mixed-source-"));
    dirs.push(repo);
    const vault = join(repo, "vault");
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(join(vault, ".daftari", "config.yaml"), "repo_root: ..\n");
    writeDoc(vault, ["repo:evidence/missing.md", "distill:session-42#claim-7"]);

    const report = await runLint(vault);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checks.unverifiableSourceRefs).toHaveLength(1);
    expect(report.value.checks.unverifiableSourceRefs[0]?.detail).toContain(
      "repo:evidence/missing.md (missing)",
    );
    expect(report.value.checks.unverifiableSourceRefs[0]?.detail).toContain(
      "born-unverifiable distill source(s): distill:session-42#claim-7",
    );
  });
});
