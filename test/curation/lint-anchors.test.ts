// test/curation/lint-anchors.test.ts
// vault_lint's citation-anchors surfaces (2026-07-26 spec, Phase 8):
// malformedPins and the Decision-4 softened stale copy, budgeted.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LINT_PIN_STEP3_BUDGET, runLint } from "../../src/curation/lint.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "ignore" });
}

function hashOf(repo: string, relPath: string): string {
  return execFileSync("git", ["-C", repo, "hash-object", relPath], { env: GIT_ENV })
    .toString()
    .trim();
}

function staleDoc(describes: string[], extraDescribes: string[] = []): string {
  const all = [...describes, ...extraDescribes];
  return `---
title: "Stale doc with pins"
domain: accumulation
collection: engineering
status: canonical
confidence: high
created: "2020-01-01"
updated: "2020-01-01"
updated_by: agent:test
provenance: direct
ttl_days: 30
tags: []
describes:
${all.map((d) => `  - "${d}"`).join("\n")}
---

Body.
`;
}

describe("vault_lint — citation anchors", () => {
  let vault: string;
  let codeRepo: string;

  beforeEach(() => {
    vault = realpathSync(mkdtempSync(join(tmpdir(), "daftari-lint-anchors-")));
    mkdirSync(join(vault, "engineering"), { recursive: true });
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    codeRepo = realpathSync(mkdtempSync(join(tmpdir(), "daftari-lint-anchors-code-")));
    git(codeRepo, ["init", "-q"]);
    writeFileSync(join(codeRepo, "retry.ts"), "export function retry() {}\n");
    git(codeRepo, ["add", "."]);
    git(codeRepo, ["commit", "-q", "-m", "init"]);
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(codeRepo, { recursive: true, force: true });
  });

  function writeConfig(extra = ""): void {
    writeFileSync(
      join(vault, ".daftari", "config.yaml"),
      `code_repos:\n  svc: ${codeRepo}\n${extra}`,
    );
  }

  describe("malformedPins", () => {
    it("flags a near-miss malformed pin as advisory, never blocking", async () => {
      writeConfig();
      writeFileSync(
        join(vault, "engineering/malformed.md"),
        staleDoc(["svc:retry.ts#L1-2@ZZZZZZZ"]),
      );
      const report = await runLint(vault);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.checks.malformedPins).toHaveLength(1);
      expect(report.value.checks.malformedPins[0]?.path).toBe("engineering/malformed.md");
      expect(report.value.checks.malformedPins[0]?.detail).toContain("svc:retry.ts#L1-2@ZZZZZZZ");
    });

    it("does not flag a well-formed pin", async () => {
      writeConfig();
      writeFileSync(
        join(vault, "engineering/fine.md"),
        staleDoc([`svc:retry.ts@${hashOf(codeRepo, "retry.ts")}`]),
      );
      const report = await runLint(vault);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.checks.malformedPins).toHaveLength(0);
    });
  });

  describe("Decision 4 softened stale copy", () => {
    it("appends softened copy when every pin on a stale doc is intact", async () => {
      writeConfig();
      writeFileSync(
        join(vault, "engineering/stale-intact.md"),
        staleDoc([`svc:retry.ts@${hashOf(codeRepo, "retry.ts")}`]),
      );
      const report = await runLint(vault);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const finding = report.value.checks.staleFiles.find(
        (f) => f.path === "engineering/stale-intact.md",
      );
      expect(finding).toBeDefined();
      expect(finding?.detail).toContain("past TTL, but its 1 code pin");
      expect(finding?.detail).toContain("has not changed since the pins were written");
      expect(report.value.pinsClassified).toBe(0); // whole-file pin never hits step 3
    });

    it("does NOT soften when a pin is moved", async () => {
      writeConfig();
      writeFileSync(join(vault, "engineering/stale-moved.md"), staleDoc(["svc:retry.ts@0000000"]));
      const report = await runLint(vault);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const finding = report.value.checks.staleFiles.find(
        (f) => f.path === "engineering/stale-moved.md",
      );
      expect(finding?.detail).not.toContain("code pin");
    });

    it("does NOT soften a fresh (non-stale) doc even with intact pins", async () => {
      writeConfig();
      writeFileSync(
        join(vault, "engineering/fresh.md"),
        `---
title: "Fresh doc"
domain: accumulation
collection: engineering
status: canonical
confidence: high
created: "2026-01-05"
updated: "2026-01-05"
updated_by: agent:test
provenance: direct
tags: []
describes:
  - "svc:retry.ts@${hashOf(codeRepo, "retry.ts")}"
---

Body.
`,
      );
      const report = await runLint(vault);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.checks.staleFiles.some((f) => f.path === "engineering/fresh.md")).toBe(
        false,
      );
    });

    it("does not soften when jit_anchors is false", async () => {
      writeConfig("jit_anchors: false\n");
      writeFileSync(
        join(vault, "engineering/stale-off.md"),
        staleDoc([`svc:retry.ts@${hashOf(codeRepo, "retry.ts")}`]),
      );
      const report = await runLint(vault);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const finding = report.value.checks.staleFiles.find(
        (f) => f.path === "engineering/stale-off.md",
      );
      expect(finding?.detail).not.toContain("code pin");
      expect(report.value.pinsClassified).toBe(0);
    });

    it("softens using a range pin (exercises step 3, counted in pinsClassified)", async () => {
      const content =
        ["a", "TARGET LINE with enough content for the trivial-content floor", "c"].join("\n") +
        "\n";
      writeFileSync(join(codeRepo, "range.ts"), content);
      git(codeRepo, ["add", "."]);
      git(codeRepo, ["commit", "-q", "-m", "range"]);
      const rangeSha = hashOf(codeRepo, "range.ts");
      // Move the line down — blob differs, text intact (step 3 required).
      writeFileSync(
        join(codeRepo, "range.ts"),
        ["pad", "a", "TARGET LINE with enough content for the trivial-content floor", "c"].join(
          "\n",
        ) + "\n",
      );
      writeConfig();
      writeFileSync(
        join(vault, "engineering/stale-range.md"),
        staleDoc([`svc:range.ts#L2-2@${rangeSha}`]),
      );

      const report = await runLint(vault);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const finding = report.value.checks.staleFiles.find(
        (f) => f.path === "engineering/stale-range.md",
      );
      expect(finding?.detail).toContain("code pin");
      expect(report.value.pinsClassified).toBe(1);
    });

    it("memoises a verdict recurring across multiple stale docs (classified once)", async () => {
      writeConfig();
      const rangeSha = (() => {
        writeFileSync(
          join(codeRepo, "shared.ts"),
          ["a", "SHARED TARGET LINE with enough content here", "c"].join("\n") + "\n",
        );
        git(codeRepo, ["add", "."]);
        git(codeRepo, ["commit", "-q", "-m", "shared"]);
        const sha = hashOf(codeRepo, "shared.ts");
        writeFileSync(
          join(codeRepo, "shared.ts"),
          ["pad", "a", "SHARED TARGET LINE with enough content here", "c"].join("\n") + "\n",
        );
        return sha;
      })();
      writeFileSync(
        join(vault, "engineering/doc-a.md"),
        staleDoc([`svc:shared.ts#L2-2@${rangeSha}`]),
      );
      writeFileSync(
        join(vault, "engineering/doc-b.md"),
        staleDoc([`svc:shared.ts#L2-2@${rangeSha}`]),
      );

      const report = await runLint(vault);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      // Two docs, same (repo, path, sha, range) triple -> classified ONCE.
      expect(report.value.pinsClassified).toBe(1);
      for (const path of ["engineering/doc-a.md", "engineering/doc-b.md"]) {
        const finding = report.value.checks.staleFiles.find((f) => f.path === path);
        expect(finding?.detail).toContain("code pin");
      }
    });

    it("respects the step-3 budget: docs beyond it are not softened", async () => {
      writeConfig();
      // Create (LINT_PIN_STEP3_BUDGET + 1) distinct stale docs, each with a
      // DISTINCT range pin requiring its own step-3 classification (distinct
      // target files so the batch hash can't short-circuit them to intact).
      const n = LINT_PIN_STEP3_BUDGET + 1;
      for (let i = 0; i < n; i++) {
        const fname = `f${i}.ts`;
        writeFileSync(
          join(codeRepo, fname),
          ["a", `TARGET LINE number ${i} with enough content here`, "c"].join("\n") + "\n",
        );
      }
      git(codeRepo, ["add", "."]);
      git(codeRepo, ["commit", "-q", "-m", "many"]);
      const shas: string[] = [];
      for (let i = 0; i < n; i++) shas.push(hashOf(codeRepo, `f${i}.ts`));
      // Now change every file so the blob differs (forcing step 3).
      for (let i = 0; i < n; i++) {
        writeFileSync(
          join(codeRepo, `f${i}.ts`),
          ["pad", "a", `TARGET LINE number ${i} with enough content here`, "c"].join("\n") + "\n",
        );
      }
      for (let i = 0; i < n; i++) {
        writeFileSync(
          join(vault, `engineering/doc-${i}.md`),
          staleDoc([`svc:f${i}.ts#L2-2@${shas[i]}`]),
        );
      }

      const report = await runLint(vault);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.pinsClassified).toBe(LINT_PIN_STEP3_BUDGET);
      // At least one doc's finding must NOT carry the softened copy — the
      // budget was exceeded before every doc could be classified.
      const softened = report.value.checks.staleFiles.filter((f) => f.detail.includes("code pin"));
      expect(softened.length).toBeLessThan(n);
    }, 20000);
  });
});
