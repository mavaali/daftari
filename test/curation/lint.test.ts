import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractLinks, runLint } from "../../src/curation/lint.js";

const LINT_VAULT = resolve("test/fixtures/lint-vault");

describe("lint", () => {
  describe("extractLinks", () => {
    it("pulls wikilinks and markdown links, skipping externals", () => {
      const links = extractLinks(
        "see [[foo]] and [[bar|alias]] and [[baz#heading]] and " +
          "[a doc](pricing/x.md) and [site](https://example.com)",
      );
      expect(links).toEqual(["foo", "bar", "baz", "pricing/x.md"]);
    });
  });

  describe("runLint", () => {
    it("flags the stale file past its TTL", async () => {
      const report = await runLint(LINT_VAULT);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.checks.staleFiles.map((f) => f.path)).toEqual(["stale-doc.md"]);
    });

    it("flags the orphan with no inbound links", async () => {
      const report = await runLint(LINT_VAULT);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.checks.orphanFiles.map((f) => f.path)).toEqual(["orphan-doc.md"]);
    });

    it("flags the draft older than the 30-day limit", async () => {
      const report = await runLint(LINT_VAULT);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.checks.oldDrafts.map((f) => f.path)).toEqual(["old-draft.md"]);
    });

    it("flags the stagnant low-confidence file", async () => {
      const report = await runLint(LINT_VAULT);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.checks.stagnantLowConfidence.map((f) => f.path)).toEqual([
        "stagnant-low-conf.md",
      ]);
    });

    it("flags the deprecated file still linked from a canonical doc", async () => {
      const report = await runLint(LINT_VAULT);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const finding = report.value.checks.deprecatedStillLinked;
      expect(finding.map((f) => f.path)).toEqual(["deprecated-linked.md"]);
      expect(finding[0]?.detail).toContain("canonical-hub.md");
    });

    it("totals one finding per check", async () => {
      const report = await runLint(LINT_VAULT);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.totalFindings).toBe(5);
    });

    it("respects a custom draft age limit", async () => {
      // With a 100-year limit no draft is old enough to flag.
      const report = await runLint(LINT_VAULT, { draftMaxDays: 36_500 });
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.checks.oldDrafts).toEqual([]);
    });

    it("reports no unanswered questions when no document raises any", async () => {
      const report = await runLint(LINT_VAULT);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.checks.unansweredQuestions).toEqual([]);
    });
  });

  describe("unansweredQuestions check", () => {
    let dir: string;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    const doc = (name: string, answered: string[], raised: string[]): void => {
      const yamlList = (xs: string[]) =>
        xs.length === 0 ? " []" : `\n${xs.map((x) => `  - "${x}"`).join("\n")}`;
      writeFileSync(
        join(dir, name),
        `---
title: "${name}"
domain: accumulation
collection: docs
status: canonical
confidence: high
created: 2026-01-01
updated: 2026-05-01
updated_by: agent:test
provenance: direct
sources: []
superseded_by: null
ttl_days: null
tags: []
questions_answered:${yamlList(answered)}
questions_raised:${yamlList(raised)}
---

Body.
`,
        "utf-8",
      );
    };

    it("flags a question raised but answered nowhere in the vault", async () => {
      dir = mkdtempSync(join(tmpdir(), "daftari-lint-q-"));
      doc("a.md", [], ["Is the boundary clear?", "Does it scale?"]);
      doc("b.md", ["Does it scale?"], []);

      const report = await runLint(dir);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const finding = report.value.checks.unansweredQuestions;
      expect(finding.map((f) => f.path)).toEqual(["a.md"]);
      // "Does it scale?" is answered by b.md; only the boundary question is orphaned.
      expect(finding[0]?.detail).toContain("Is the boundary clear?");
      expect(finding[0]?.detail).not.toContain("Does it scale?");
    });

    it("treats a question as answered regardless of casing and whitespace", async () => {
      dir = mkdtempSync(join(tmpdir(), "daftari-lint-q-"));
      doc("a.md", [], ["How  does  it  WORK?"]);
      doc("b.md", ["how does it work?"], []);

      const report = await runLint(dir);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.checks.unansweredQuestions).toEqual([]);
    });
  });
});
