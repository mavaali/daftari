import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import {
  LINT_CHECKS,
  type LintCheckName,
  type LintFinding,
  runLint,
} from "../../src/curation/lint.js";
import { LINT_PREVIEW_PER_CHECK, previewChecks } from "../../src/curation/lint-page.js";
import { shadowActionsPath } from "../../src/curation/shadow.js";
import { stageAction } from "../../src/curation/staged-actions.js";
import { addTension } from "../../src/curation/tension.js";
import {
  curationTools,
  lintContentSummary,
  summarizeLint,
  vaultLint,
} from "../../src/tools/curation.js";

// Long collection paths and every per-document check firing: closer to the
// audited vault's report than a vault of short names would be.
function doc(i: number): string {
  return (
    "---\n" +
    `title: Document ${i}\ndomain: accumulation\ncollection: knowledge\n` +
    "status: draft\nconfidence: low\ncreated: 2025-01-01\nupdated: 2025-01-01\n" +
    "ttl_days: 30\nupdated_by: human:test\nprovenance: direct\n" +
    `sources:\n  - knowledge/missing-source-${i}.md\ntags: []\n` +
    `questions_raised:\n  - What did document ${i} leave open about the long tail of this topic?\n` +
    "---\nBody.\n"
  );
}

function writeDoc(vault: string, rel: string, content: string): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function populate(vault: string, count: number): void {
  for (let i = 0; i < count; i++) {
    writeDoc(vault, `knowledge/engineering/platform/document-number-${i}.md`, doc(i));
  }
}

async function stage(vault: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const staged = await stageAction(vault, {
      actionType: "promote",
      targetPath: `knowledge/engineering/platform/document-number-${i}.md`,
      proposedBy: "agent:test",
      rationale: `${"A long justification for this proposal ".repeat(20)}end.`,
      proposedDiff: {},
    });
    if (!staged.ok) throw staged.error;
  }
}

function shadow(vault: string, count: number): void {
  mkdirSync(join(vault, ".daftari"), { recursive: true });
  for (let i = 0; i < count; i++) {
    appendFileSync(
      shadowActionsPath(vault),
      `${JSON.stringify({
        at: "2026-01-01T00:00:00.000Z",
        tool: "vault_write",
        action: "write",
        target_path: `knowledge/engineering/platform/document-number-${i}.md`,
        agent: "agent:test",
        i_base: 1,
        blast: 0,
        impact: 1,
        budget: 0.5,
        spent_before: 0,
        would_gate: true,
        decision: "gated",
        commit_message: "m",
      })}\n`,
    );
  }
}

// What a client receives: the structured report plus the content summary.
async function deliveredChars(vault: string): Promise<number> {
  const result = await vaultLint(vault, {});
  if (!result.ok) throw result.error;
  return JSON.stringify(result.value).length + lintContentSummary(result.value, vault).length;
}

describe("vault_lint paging (#644)", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-lint-paging-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("an unfiltered lint on a 300-document vault delivers under 10,000 characters", async () => {
    populate(vault, 300);
    await stage(vault, 30);
    shadow(vault, 40);
    // Sanity: without the summary this vault reports the wall from the issue.
    const full = await vaultLint(vault, { limit: 1000 });
    expect(full.ok && JSON.stringify(full.value).length).toBeGreaterThan(88_000);
    expect(await deliveredChars(vault)).toBeLessThan(10_000);
  }, 60_000);

  it("holds the bound with every check firing at the budget", async () => {
    populate(vault, 300);
    await stage(vault, 30);
    shadow(vault, 40);
    const result = await vaultLint(vault, {});
    if (!result.ok) throw result.error;
    const finding = {
      path: "knowledge/engineering/platform/subsystem/a-rather-long-document-name-for-a-real-vault.md",
      detail: "d".repeat(500),
    };
    const reported = Object.fromEntries(LINT_CHECKS.map((c) => [c, Array(50).fill(finding)]));
    const view = previewChecks(reported as Record<LintCheckName, LintFinding[]>);
    const worst = { ...result.value, ...view, totalFindings: 800 };
    expect(JSON.stringify(worst).length + summarizeLint(worst).length).toBeLessThan(10_000);
  }, 60_000);

  it("carries exactly the fields its output schema declares, in both modes", async () => {
    populate(vault, 4);
    const schema = curationTools.find((t) => t.name === "vault_lint")?.outputSchema;
    const declared = Object.keys(schema?.properties as object).sort();
    for (const args of [{}, { filter: "orphanFiles", limit: 1 }]) {
      const result = await vaultLint(vault, args);
      if (!result.ok) throw result.error;
      expect(Object.keys(result.value).sort()).toEqual(declared);
    }
  });

  it("the default result counts each check in full and previews its first few", async () => {
    populate(vault, 10);
    const result = await vaultLint(vault, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = await runLint(vault);
    if (!report.ok) throw report.error;

    expect(result.value.mode).toBe("summary");
    expect(result.value.filter).toBeNull();
    expect(Object.keys(result.value.checks).sort()).toEqual([...LINT_CHECKS].sort());
    expect(result.value.totalFindings).toBe(report.value.totalFindings);
    for (const check of LINT_CHECKS) {
      expect(result.value.counts[check]).toBe(report.value.checks[check].length);
    }
    expect(result.value.counts.orphanFiles).toBe(10);
    expect(result.value.checks.orphanFiles).toHaveLength(LINT_PREVIEW_PER_CHECK);
    expect(result.value.nextOffset.orphanFiles).toBe(LINT_PREVIEW_PER_CHECK);
  });

  it("walking nextOffset through a check returns exactly what the engine found, in order", async () => {
    populate(vault, 12);
    const report = await runLint(vault);
    if (!report.ok) throw report.error;

    const walked: LintFinding[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = await vaultLint(vault, { filter: "orphanFiles", limit: 5, offset });
      if (!page.ok) throw page.error;
      expect(page.value.mode).toBe("page");
      expect(page.value.totalFindings).toBe(12);
      expect(page.value.counts.orphanFiles).toBe(12);
      expect(page.value.checks.orphanFiles?.length).toBeLessThanOrEqual(5);
      walked.push(...(page.value.checks.orphanFiles ?? []));
      offset = page.value.nextOffset.orphanFiles;
    }
    expect(walked).toEqual(report.value.checks.orphanFiles);
  });

  it("filter alone still narrows to one check, in bounded pages", async () => {
    populate(vault, 60);
    const result = await vaultLint(vault, { filter: "orphanFiles" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filter).toBe("orphanFiles");
    expect(Object.keys(result.value.checks)).toEqual(["orphanFiles"]);
    expect(Object.keys(result.value.counts)).toEqual(["orphanFiles"]);
    expect(result.value.totalFindings).toBe(60);
    expect(result.value.checks.orphanFiles).toHaveLength(50);
    expect(result.value.nextOffset).toEqual({ orphanFiles: 50 });
  });

  it("limit without a filter pages every check, with details unclipped", async () => {
    populate(vault, 4);
    const result = await vaultLint(vault, { limit: 1, offset: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("page");
    expect(result.value.filter).toBeNull();
    expect(result.value.totalFindings).toBeGreaterThan(4);
    expect(result.value.checks.orphanFiles).toHaveLength(1);
    expect(result.value.nextOffset.orphanFiles).toBe(2);
  });

  it("rejects bad paging before the staged-action sweep runs", async () => {
    await stageAction(vault, {
      actionType: "promote",
      targetPath: "a.md",
      proposedBy: "agent:test",
      rationale: "r.",
      proposedDiff: {},
      proposedAt: "2020-01-01T00:00:00Z",
      ttlDays: 1,
    });
    const result = await vaultLint(vault, { limit: -1 });
    expect(result.ok).toBe(false);
    const swept = await vaultLint(vault, { limit: 0 });
    expect(swept.ok && swept.value.stagedActionsTotal).toBe(0);
  });

  it("previews the staged and shadow lists but keeps their totals; a page carries them whole", async () => {
    populate(vault, 1);
    await stage(vault, 12);
    shadow(vault, 25);

    const summary = await vaultLint(vault, {});
    if (!summary.ok) throw summary.error;
    expect(summary.value.stagedActionsTotal).toBe(12);
    expect(summary.value.stagedActions.length).toBeLessThan(12);
    expect(summary.value.stagedActions[0]?.rationale.length).toBeLessThan(200);
    expect(summary.value.shadowActions.gated).toBe(25);
    expect(summary.value.shadowActions.gatedCount).toBe(25);
    expect(summary.value.shadowActions.recentGated.length).toBeLessThan(20);
    expect(summary.value.shadowActions.gatedSurfaced.length).toBeLessThan(20);

    const page = await vaultLint(vault, { filter: "orphanFiles", limit: 0 });
    if (!page.ok) throw page.error;
    expect(page.value.stagedActions).toHaveLength(12);
    expect(page.value.stagedActionsTotal).toBe(12);
    expect(page.value.shadowActions.recentGated).toHaveLength(20);
  });

  it("the content summary reports true counts, not preview lengths", async () => {
    populate(vault, 10);
    await stage(vault, 12);
    const result = await vaultLint(vault, {});
    if (!result.ok) throw result.error;
    const text = lintContentSummary(result.value, vault);
    expect(text).toContain("orphanFiles 10");
    expect(text).toContain("staged: 12 pending");
    expect(text).toContain(`of ${result.value.totalFindings} finding(s)`);
    expect(text).toContain("offset");
  });

  describe("under RBAC", () => {
    const reader: AccessContext = {
      user: "human:reader",
      roleName: "reader",
      role: { read: ["pricing"], write: [], promote: false, ratify: false },
    };

    beforeEach(async () => {
      for (let i = 0; i < 6; i++) {
        writeDoc(vault, `pricing/p-${i}.md`, "---\ntitle: P\n---\nbody");
        writeDoc(vault, `intel/i-${i}.md`, "---\ntitle: I\n---\nbody");
      }
      const t = await addTension(vault, {
        title: "cross",
        kind: "factual",
        sourceA: "pricing/p-0.md",
        claimA: "x",
        sourceB: "intel/i-0.md",
        claimB: "z",
        loggedBy: "test",
      });
      if (!t.ok) throw t.error;
    });

    it("counts cover only what the caller can read, and no page reaches further", async () => {
      const summary = await vaultLint(vault, {}, reader);
      if (!summary.ok) throw summary.error;
      expect(summary.value.counts.orphanFiles).toBe(6);

      const page = await vaultLint(vault, { filter: "orphanFiles", limit: 100 }, reader);
      if (!page.ok) throw page.error;
      expect(page.value.counts.orphanFiles).toBe(6);
      expect(page.value.nextOffset).toEqual({});
      const paths = (page.value.checks.orphanFiles ?? []).map((f) => f.path);
      expect(paths).toHaveLength(6);
      expect(paths.every((p) => p.startsWith("pricing/"))).toBe(true);

      const past = await vaultLint(vault, { filter: "orphanFiles", offset: 6 }, reader);
      if (!past.ok) throw past.error;
      expect(past.value.checks.orphanFiles).toEqual([]);
    });

    it("vault-global aggregates read the same in every mode", async () => {
      const summary = await vaultLint(vault, {}, reader);
      const page = await vaultLint(vault, { filter: "orphanFiles", limit: 1 }, reader);
      const admin = await vaultLint(vault, {});
      if (!summary.ok || !page.ok || !admin.ok) throw new Error("lint failed");
      expect(summary.value.tensionHealth.total).toBe(1);
      expect(page.value.tensionHealth).toEqual(summary.value.tensionHealth);
      expect(admin.value.tensionHealth).toEqual(summary.value.tensionHealth);
    });
  });
});
