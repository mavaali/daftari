import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LINT_CHECKS, runLint, TIER0_LINT_CHECKS } from "../../src/curation/lint.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

function writeDoc(
  vault: string,
  path: string,
  status: string,
  supersededBy: string | null = null,
): void {
  const abs = join(vault, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    `---\ntitle: T\ndomain: accumulation\ncollection: ${path.split("/")[0]}\n` +
      `status: ${status}\nconfidence: medium\ncreated: 2026-05-01\nupdated: 2026-05-01\n` +
      `updated_by: agent:seed\nprovenance: direct\nsources: []\n` +
      `superseded_by: ${supersededBy ?? "null"}\nttl_days: 90\ntags: []\n---\nBody.\n`,
  );
}

async function chainFindings(vault: string, pathVisible?: (path: string) => boolean) {
  const report = await runLint(vault, pathVisible ? { pathVisible } : {});
  if (!report.ok) throw report.error;
  return { findings: report.value.checks.supersedeChains, report: report.value };
}

describe("vault_lint — supersedeChains", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
    // The fixture's own docs are not under test.
    rmSync(join(vault, "pricing"), { recursive: true, force: true });
    rmSync(join(vault, "competitive-intel"), { recursive: true, force: true });
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("is a registered, advisory (non-tier-0) check", () => {
    expect(LINT_CHECKS).toContain("supersedeChains");
    expect(TIER0_LINT_CHECKS).not.toContain("supersedeChains");
  });

  it("reports a two-document loop as exactly one finding naming both", async () => {
    writeDoc(vault, "decisions/a.md", "superseded", "decisions/b.md");
    writeDoc(vault, "decisions/b.md", "superseded", "decisions/a.md");

    const { findings, report } = await chainFindings(vault);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain("decisions/a.md");
    expect(findings[0]?.detail).toContain("decisions/b.md");
    const namingBoth = Object.values(report.checks)
      .flat()
      .filter(
        (f) =>
          `${f.path} ${f.detail}`.includes("decisions/a.md") &&
          `${f.path} ${f.detail}`.includes("decisions/b.md"),
      );
    expect(namingBoth).toHaveLength(1);
  });

  it("reports one finding for a longer loop, regardless of entry point", async () => {
    writeDoc(vault, "decisions/a.md", "superseded", "decisions/b.md");
    writeDoc(vault, "decisions/b.md", "superseded", "decisions/c.md");
    writeDoc(vault, "decisions/c.md", "superseded", "decisions/a.md");
    writeDoc(vault, "decisions/tail.md", "superseded", "decisions/b.md");

    const { findings } = await chainFindings(vault);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe("decisions/a.md");
    expect(findings[0]?.detail).toContain("decisions/c.md");
    expect(findings[0]?.detail).not.toContain("tail");
  });

  it("reports a document pointing at itself", async () => {
    writeDoc(vault, "decisions/a.md", "superseded", "decisions/a.md");

    const { findings } = await chainFindings(vault);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe("decisions/a.md");
  });

  it("is silent on a chain ending in a canonical document", async () => {
    writeDoc(vault, "decisions/a.md", "superseded", "decisions/b.md");
    writeDoc(vault, "decisions/b.md", "superseded", "decisions/c.md");
    writeDoc(vault, "decisions/c.md", "canonical");

    expect((await chainFindings(vault)).findings).toEqual([]);
  });

  it.each(["draft", "deprecated", "superseded", "archived"])(
    "reports a chain whose last entry is %s",
    async (status) => {
      writeDoc(vault, "decisions/a.md", "superseded", "decisions/b.md");
      writeDoc(vault, "decisions/b.md", status);

      const { findings } = await chainFindings(vault);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.path).toBe("decisions/b.md");
      expect(findings[0]?.detail).toContain(status);
      expect(findings[0]?.detail).toContain("decisions/a.md");
    },
  );

  it("folds converging chains into one finding per last entry", async () => {
    writeDoc(vault, "decisions/a.md", "superseded", "decisions/end.md");
    writeDoc(vault, "decisions/b.md", "superseded", "decisions/mid.md");
    writeDoc(vault, "decisions/mid.md", "superseded", "decisions/end.md");
    writeDoc(vault, "decisions/end.md", "draft");

    const { findings } = await chainFindings(vault);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain("decisions/a.md");
    expect(findings[0]?.detail).toContain("decisions/b.md");
  });

  it("does not treat a retired document with no pointer as a chain", async () => {
    writeDoc(vault, "decisions/a.md", "deprecated");

    expect((await chainFindings(vault)).findings).toEqual([]);
  });

  it("leaves a dangling pointer to brokenSourceRefs", async () => {
    writeDoc(vault, "decisions/a.md", "superseded", "decisions/b.md");
    writeDoc(vault, "decisions/b.md", "superseded", "decisions/ghost.md");

    const { findings, report } = await chainFindings(vault);

    expect(findings).toEqual([]);
    expect(report.checks.brokenSourceRefs.map((f) => f.path)).toContain("decisions/b.md");
  });

  it("resolves a relative superseded_by the way the other checks do", async () => {
    writeDoc(vault, "decisions/a.md", "superseded", "b.md");
    writeDoc(vault, "decisions/b.md", "superseded", "a.md");

    expect((await chainFindings(vault)).findings).toHaveLength(1);
  });

  it("computes from the caller's vantage and names no hidden doc", async () => {
    writeDoc(vault, "decisions/a.md", "superseded", "secret/h.md");
    writeDoc(vault, "secret/h.md", "superseded", "decisions/a.md");

    const { findings } = await chainFindings(vault, (p) => p.startsWith("decisions/"));

    expect(findings).toEqual([]);
  });
});
