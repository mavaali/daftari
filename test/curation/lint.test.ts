import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractLinks, runLint } from "../../src/curation/lint.js";
import { addTension, resolveTension, tensionsPath } from "../../src/curation/tension.js";

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

  describe("tensionHealth (Phase 1)", () => {
    let dir: string;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    const baseTension = {
      sourceA: "pricing/a.md",
      claimA: "A",
      sourceB: "pricing/b.md",
      claimB: "B",
      loggedBy: "agent:claude-code",
    };

    it("reports zeros when no tensions have been logged", async () => {
      dir = mkdtempSync(join(tmpdir(), "daftari-lint-th-"));
      const report = await runLint(dir);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const h = report.value.tensionHealth;
      expect(h.total).toBe(0);
      expect(h.byKind).toEqual({
        temporal: 0,
        factual: 0,
        interpretive: 0,
        unspecified: 0,
      });
      expect(h.resolvedLifetime).toBe(0);
      expect(h.byResolutionKind).toEqual({
        superseded: 0,
        corrected: 0,
        accepted: 0,
        invalid: 0,
      });
      expect(h.stableAcknowledged).toBe(0);
      expect(h.unspecifiedLegacy).toBe(0);
    });

    it("groups counts by kind and by resolution kind", async () => {
      dir = mkdtempSync(join(tmpdir(), "daftari-lint-th-"));

      const t1 = await addTension(dir, { ...baseTension, title: "t1", kind: "temporal" });
      const t2 = await addTension(dir, { ...baseTension, title: "t2", kind: "factual" });
      // t3 and t5 are seeded as fixtures for the unresolved-of-each-kind counts.
      await addTension(dir, { ...baseTension, title: "t3", kind: "factual" });
      const t4 = await addTension(dir, { ...baseTension, title: "t4", kind: "interpretive" });
      await addTension(dir, { ...baseTension, title: "t5", kind: "interpretive" });

      // t1: superseded, t2: corrected, t4: accepted. t3 + t5 remain unresolved.
      if (t1.ok)
        await resolveTension(dir, t1.value.id as string, {
          resolved_at: "2026-06-01T00:00:00Z",
          resolved_by: "mihir",
          kind: "superseded",
        });
      if (t2.ok)
        await resolveTension(dir, t2.value.id as string, {
          resolved_at: "2026-06-02T00:00:00Z",
          resolved_by: "mihir",
          kind: "corrected",
        });
      if (t4.ok)
        await resolveTension(dir, t4.value.id as string, {
          resolved_at: "2026-06-03T00:00:00Z",
          resolved_by: "mihir",
          kind: "accepted",
        });

      // Add a legacy entry (no kind, no id) to verify it counts as unspecified.
      mkdirSync(join(dir, ".daftari"), { recursive: true });
      const existing = readFileSync(tensionsPath(dir), "utf-8");
      writeFileSync(
        tensionsPath(dir),
        `${existing}\n## 2025-12-01 — Legacy entry\n` +
          "- **Source A:** legacy/a.md says X\n" +
          "- **Source B:** legacy/b.md says Y\n" +
          "- **Status:** unresolved\n" +
          "- **Logged by:** agent:legacy\n",
        "utf-8",
      );

      const report = await runLint(dir);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const h = report.value.tensionHealth;
      expect(h.total).toBe(6);
      expect(h.byKind).toEqual({
        temporal: 1,
        factual: 2,
        interpretive: 2,
        unspecified: 1,
      });
      expect(h.resolvedLifetime).toBe(3);
      expect(h.byResolutionKind).toEqual({
        superseded: 1,
        corrected: 1,
        accepted: 1,
        invalid: 0,
      });
      expect(h.stableAcknowledged).toBe(1);
      expect(h.unspecifiedLegacy).toBe(1);
    });

    it("counts an accepted tension as stable acknowledged, not as a standard finding", async () => {
      dir = mkdtempSync(join(tmpdir(), "daftari-lint-th-"));
      const t = await addTension(dir, {
        ...baseTension,
        title: "Accepted disagreement",
        kind: "interpretive",
      });
      if (!t.ok) return;
      await resolveTension(dir, t.value.id as string, {
        resolved_at: "2026-06-03T00:00:00Z",
        resolved_by: "mihir",
        kind: "accepted",
        rationale: "Both views stand",
      });

      const report = await runLint(dir);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const h = report.value.tensionHealth;
      expect(h.stableAcknowledged).toBe(1);
      expect(h.resolvedLifetime).toBe(1);
      expect(h.byResolutionKind.accepted).toBe(1);
      // Resolved-with-accepted entries are NOT counted as unresolved/active.
      expect(h.total - h.resolvedLifetime).toBe(0);

      // The standard lint findings count is unchanged by tension state — only
      // the tensionHealth surface reports it. (totalFindings counts the six
      // file-level checks, not tensions.)
      expect(report.value.totalFindings).toBe(0);
    });

    it("does not flag unspecified-only tension logs as defects", async () => {
      dir = mkdtempSync(join(tmpdir(), "daftari-lint-th-"));
      // Seed three legacy entries; no warnings, just counts.
      mkdirSync(join(dir, ".daftari"), { recursive: true });
      const legacy =
        "\n## 2025-12-01 — Legacy 1\n" +
        "- **Source A:** legacy/a.md says X\n" +
        "- **Source B:** legacy/b.md says Y\n" +
        "- **Status:** unresolved\n" +
        "- **Logged by:** agent:legacy\n" +
        "\n## 2025-12-02 — Legacy 2\n" +
        "- **Source A:** legacy/c.md says X\n" +
        "- **Source B:** legacy/d.md says Y\n" +
        "- **Status:** unresolved\n" +
        "- **Logged by:** agent:legacy\n" +
        "\n## 2025-12-03 — Legacy 3\n" +
        "- **Source A:** legacy/e.md says X\n" +
        "- **Source B:** legacy/f.md says Y\n" +
        "- **Status:** unresolved\n" +
        "- **Logged by:** agent:legacy\n";
      writeFileSync(tensionsPath(dir), legacy, "utf-8");

      const report = await runLint(dir);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.tensionHealth.unspecifiedLegacy).toBe(3);
      // Phase 1 does not introduce a tension-related entry in `checks`, so
      // standard findings remain unaffected.
      expect(report.value.totalFindings).toBe(0);
    });
  });

  // ----- Phase 4: aging -------------------------------------------------
  //
  // The lint-level tests exercise the aggregator: which entries land in which
  // tier, kind-specific stale copy gating, and the explicit exclusions for
  // accepted resolutions and unspecified entries.

  describe("tensionHealth aging (Phase 4)", () => {
    let dir: string;
    const NOW = new Date("2026-06-01T00:00:00Z");

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    const baseTension = {
      sourceA: "pricing/a.md",
      claimA: "A",
      sourceB: "pricing/b.md",
      claimB: "B",
      loggedBy: "agent:claude-code",
    };

    // Logged dates relative to NOW (2026-06-01):
    //   2026-05-22 →  10 days  (fresh)
    //   2026-05-01 →  31 days  (aging)
    //   2026-03-02 →  91 days  (stale)
    //   2025-11-13 → 200 days  (stale)

    it("counts a single fresh, aging, and stale tension across kinds", async () => {
      dir = mkdtempSync(join(tmpdir(), "daftari-lint-aging-"));
      await addTension(dir, { ...baseTension, title: "t1", kind: "factual", date: "2026-05-22" });
      await addTension(dir, { ...baseTension, title: "t2", kind: "factual", date: "2026-05-01" });
      await addTension(dir, { ...baseTension, title: "t3", kind: "factual", date: "2026-03-02" });

      const report = await runLint(dir, { now: NOW });
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const a = report.value.tensionHealth.aging;
      expect(a.fresh).toBe(1);
      expect(a.aging).toBe(1);
      expect(a.stale).toBe(1);
      expect(a.staleByKind.factual).toBe(1);
      expect(a.staleByKind.temporal).toBe(0);
      expect(a.staleByKind.interpretive).toBe(0);
      expect(a.staleByKind.unspecified).toBe(0);
    });

    it("renders kind-specific stale copy only for kinds with a nonzero stale count", async () => {
      dir = mkdtempSync(join(tmpdir(), "daftari-lint-aging-"));
      // One stale of each loggable kind.
      await addTension(dir, { ...baseTension, title: "t1", kind: "temporal", date: "2026-03-02" });
      await addTension(dir, { ...baseTension, title: "t2", kind: "factual", date: "2026-03-02" });
      await addTension(dir, {
        ...baseTension,
        title: "t3",
        kind: "interpretive",
        date: "2026-03-02",
      });

      const report = await runLint(dir, { now: NOW });
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const a = report.value.tensionHealth.aging;
      expect(a.staleMessages.temporal).toMatch(/temporal tension/);
      expect(a.staleMessages.temporal).toMatch(/older doc deprecated/);
      expect(a.staleMessages.factual).toMatch(/factual tension/);
      expect(a.staleMessages.factual).toMatch(/investigation overdue/);
      expect(a.staleMessages.interpretive).toMatch(/interpretive tension/);
      // Gap 4: interpretive copy names the right resolution paths and avoids
      // the "garbage collect" framing.
      expect(a.staleMessages.interpretive).toContain("`accepted`");
      expect(a.staleMessages.interpretive).toContain("`invalid`");
      expect(a.staleMessages.interpretive).not.toMatch(/garbage collect/i);
    });

    it("omits per-kind stale copy when that kind has no stale entries", async () => {
      dir = mkdtempSync(join(tmpdir(), "daftari-lint-aging-"));
      // Stale factual only; temporal/interpretive should produce no message.
      await addTension(dir, { ...baseTension, title: "t1", kind: "factual", date: "2026-03-02" });

      const report = await runLint(dir, { now: NOW });
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const a = report.value.tensionHealth.aging;
      expect(a.staleMessages.factual).toBeDefined();
      expect(a.staleMessages.temporal).toBeUndefined();
      expect(a.staleMessages.interpretive).toBeUndefined();
    });

    it("excludes accepted-resolution tensions from every aging tier", async () => {
      dir = mkdtempSync(join(tmpdir(), "daftari-lint-aging-"));
      const t = await addTension(dir, {
        ...baseTension,
        title: "stable disagreement",
        kind: "interpretive",
        date: "2025-11-13", // 200 days ago
      });
      if (!t.ok) return;
      await resolveTension(dir, t.value.id as string, {
        resolved_at: "2026-02-01T00:00:00Z",
        resolved_by: "mihir",
        kind: "accepted",
        rationale: "Both views stand",
      });

      const report = await runLint(dir, { now: NOW });
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const h = report.value.tensionHealth;
      // Still reported via Phase 1's stable-acknowledged bucket.
      expect(h.stableAcknowledged).toBe(1);
      // But absent from every aging tier.
      expect(h.aging.fresh).toBe(0);
      expect(h.aging.aging).toBe(0);
      expect(h.aging.stale).toBe(0);
      expect(h.aging.staleByKind.interpretive).toBe(0);
      expect(h.aging.staleMessages.interpretive).toBeUndefined();
    });

    it("excludes unspecified (legacy) tensions from every aging tier", async () => {
      dir = mkdtempSync(join(tmpdir(), "daftari-lint-aging-"));
      // 200-day-old legacy entry: no kind, no id, no warning expected.
      mkdirSync(join(dir, ".daftari"), { recursive: true });
      const legacy =
        "\n## 2025-11-13 — Legacy ancient\n" +
        "- **Source A:** legacy/a.md says X\n" +
        "- **Source B:** legacy/b.md says Y\n" +
        "- **Status:** unresolved\n" +
        "- **Logged by:** agent:legacy\n";
      writeFileSync(tensionsPath(dir), legacy, "utf-8");

      const report = await runLint(dir, { now: NOW });
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const h = report.value.tensionHealth;
      expect(h.unspecifiedLegacy).toBe(1);
      expect(h.aging.fresh).toBe(0);
      expect(h.aging.aging).toBe(0);
      expect(h.aging.stale).toBe(0);
      expect(h.aging.staleByKind.unspecified).toBe(0);
      // Unspecified is not in staleMessages' key set at all.
      expect(Object.keys(h.aging.staleMessages)).not.toContain("unspecified");
    });

    it("excludes resolved-corrected and resolved-superseded entries from aging counts", async () => {
      dir = mkdtempSync(join(tmpdir(), "daftari-lint-aging-"));
      // Both would be stale if unresolved (200 days old) — but they're closed.
      const a = await addTension(dir, {
        ...baseTension,
        title: "old factual",
        kind: "factual",
        date: "2025-11-13",
      });
      const b = await addTension(dir, {
        ...baseTension,
        title: "old temporal",
        kind: "temporal",
        date: "2025-11-13",
      });
      if (!a.ok || !b.ok) return;
      await resolveTension(dir, a.value.id as string, {
        resolved_at: "2026-02-01T00:00:00Z",
        resolved_by: "mihir",
        kind: "corrected",
      });
      await resolveTension(dir, b.value.id as string, {
        resolved_at: "2026-02-01T00:00:00Z",
        resolved_by: "mihir",
        kind: "superseded",
      });

      const report = await runLint(dir, { now: NOW });
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const h = report.value.tensionHealth;
      expect(h.aging.fresh).toBe(0);
      expect(h.aging.aging).toBe(0);
      expect(h.aging.stale).toBe(0);
      // But Phase 1 totals still reflect them.
      expect(h.resolvedLifetime).toBe(2);
    });

    it("snapshots a mixed fixture covering every tier and kind", async () => {
      dir = mkdtempSync(join(tmpdir(), "daftari-lint-aging-"));
      // Fresh: one of each loggable kind.
      await addTension(dir, { ...baseTension, title: "f-t", kind: "temporal", date: "2026-05-22" });
      await addTension(dir, { ...baseTension, title: "f-f", kind: "factual", date: "2026-05-22" });
      await addTension(dir, {
        ...baseTension,
        title: "f-i",
        kind: "interpretive",
        date: "2026-05-22",
      });
      // Aging: one of each.
      await addTension(dir, { ...baseTension, title: "a-t", kind: "temporal", date: "2026-04-15" });
      await addTension(dir, { ...baseTension, title: "a-f", kind: "factual", date: "2026-04-15" });
      await addTension(dir, {
        ...baseTension,
        title: "a-i",
        kind: "interpretive",
        date: "2026-04-15",
      });
      // Stale: one of each.
      await addTension(dir, { ...baseTension, title: "s-t", kind: "temporal", date: "2026-01-01" });
      await addTension(dir, { ...baseTension, title: "s-f", kind: "factual", date: "2026-01-01" });
      await addTension(dir, {
        ...baseTension,
        title: "s-i",
        kind: "interpretive",
        date: "2026-01-01",
      });
      // Legacy unspecified (200d): counted toward totals only.
      mkdirSync(join(dir, ".daftari"), { recursive: true });
      const existing = readFileSync(tensionsPath(dir), "utf-8");
      writeFileSync(
        tensionsPath(dir),
        `${existing}\n## 2025-11-13 — Legacy U\n` +
          "- **Source A:** legacy/a.md says X\n" +
          "- **Source B:** legacy/b.md says Y\n" +
          "- **Status:** unresolved\n" +
          "- **Logged by:** agent:legacy\n",
        "utf-8",
      );

      const report = await runLint(dir, { now: NOW });
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const h = report.value.tensionHealth;
      expect(h.total).toBe(10);
      expect(h.byKind).toEqual({
        temporal: 3,
        factual: 3,
        interpretive: 3,
        unspecified: 1,
      });
      expect(h.aging.fresh).toBe(3);
      expect(h.aging.aging).toBe(3);
      expect(h.aging.stale).toBe(3);
      expect(h.aging.staleByKind).toEqual({
        temporal: 1,
        factual: 1,
        interpretive: 1,
        unspecified: 0,
      });
      // All three stale-tier messages render.
      expect(h.aging.staleMessages.temporal).toBeDefined();
      expect(h.aging.staleMessages.factual).toBeDefined();
      expect(h.aging.staleMessages.interpretive).toBeDefined();
    });
  });

  // ----- Phase 2: clusters ----------------------------------------------
  //
  // Cluster metrics added to the tension-health surface — counts only,
  // never flagging anything as a defect. `large` (>5 docs) and `aged` (>90d
  // oldest tension) are the two smell thresholds named in the spec.

  describe("tensionHealth clusters (Phase 2)", () => {
    let dir: string;
    const NOW = new Date("2026-06-01T00:00:00Z");

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    const baseTension = {
      sourceA: "pricing/a.md",
      claimA: "A",
      sourceB: "pricing/b.md",
      claimB: "B",
      loggedBy: "agent:claude-code",
    };

    it("reports zero clusters when nothing has been logged", async () => {
      dir = mkdtempSync(join(tmpdir(), "daftari-lint-clusters-"));
      const report = await runLint(dir, { now: NOW });
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const c = report.value.tensionHealth.clusters;
      expect(c.count).toBe(0);
      expect(c.maxSize).toBe(0);
      expect(c.large).toBe(0);
      expect(c.aged).toBe(0);
    });

    it("counts clusters, flags large (>5 docs) and aged (>90d oldest tension)", async () => {
      dir = mkdtempSync(join(tmpdir(), "daftari-lint-clusters-"));
      // Cluster A: 6 documents (large), oldest tension 95 days old (aged).
      // hub + 5 spokes = 6 documents total.
      await addTension(dir, {
        ...baseTension,
        title: "old hub",
        sourceA: "a/hub.md",
        sourceB: "a/spoke1.md",
        kind: "factual",
        date: "2026-02-26", // 95 days before NOW (triggers `aged` flag)
      });
      for (let i = 2; i <= 5; i++) {
        await addTension(dir, {
          ...baseTension,
          title: `hub spoke ${i}`,
          sourceA: "a/hub.md",
          sourceB: `a/spoke${i}.md`,
          kind: "factual",
          date: "2026-05-22", // 10 days before NOW (fresh)
        });
      }

      // Cluster B: 3 documents, all fresh (not large, not aged).
      await addTension(dir, {
        ...baseTension,
        title: "b1",
        sourceA: "b/x.md",
        sourceB: "b/y.md",
        kind: "interpretive",
        date: "2026-05-22",
      });
      await addTension(dir, {
        ...baseTension,
        title: "b2",
        sourceA: "b/y.md",
        sourceB: "b/z.md",
        kind: "interpretive",
        date: "2026-05-22",
      });

      const report = await runLint(dir, { now: NOW });
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const c = report.value.tensionHealth.clusters;
      expect(c.count).toBe(2);
      expect(c.maxSize).toBe(6);
      expect(c.large).toBe(1);
      expect(c.aged).toBe(1);
    });

    it("excludes accepted-resolution tensions from cluster metrics", async () => {
      dir = mkdtempSync(join(tmpdir(), "daftari-lint-clusters-"));
      const t = await addTension(dir, {
        ...baseTension,
        title: "accepted",
        kind: "interpretive",
        date: "2026-05-22",
      });
      if (!t.ok) return;
      await resolveTension(dir, t.value.id as string, {
        resolved_at: "2026-05-23T00:00:00Z",
        resolved_by: "mihir",
        kind: "accepted",
      });

      const report = await runLint(dir, { now: NOW });
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const c = report.value.tensionHealth.clusters;
      expect(c.count).toBe(0);
      expect(c.maxSize).toBe(0);
    });
  });
});
