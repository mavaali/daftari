// Dated snapshots (#645): a document in a `series` is written once and never
// edited, so its own TTL says nothing about the vault. The TTL belongs to the
// series and fires on the newest member only, when no new snapshot has been
// written. Every whole-vault staleness surface has to agree on that.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { runLint } from "../../src/curation/lint.js";
import { gatherQuestions } from "../../src/interview/questions.js";
import { runSleepCycle } from "../../src/sleep/cycle.js";
import { vaultStatus } from "../../src/tools/read.js";

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

let vault: string;

function writeDoc(relPath: string, over: Record<string, string | number> = {}): void {
  const fm: Record<string, string | number> = {
    title: `Doc ${relPath}`,
    domain: "accumulation",
    collection: relPath.split("/")[0] ?? "",
    status: "canonical",
    confidence: "high",
    created: daysAgo(0),
    updated: daysAgo(0),
    updated_by: "agent:test",
    provenance: "direct",
    ...over,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  const file = join(vault, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `---\n${lines.join("\n")}\ntags: []\n---\n\nBody.\n`, "utf-8");
}

function writeSnapshot(
  relPath: string,
  age: number,
  over: Record<string, string | number> = {},
): void {
  writeDoc(relPath, {
    series: "weekly-review",
    ttl_days: 14,
    created: daysAgo(age),
    updated: daysAgo(age),
    ...over,
  });
}

function writeFourWeeklies(newestAge: number): void {
  writeSnapshot("reviews/w1.md", newestAge + 21);
  writeSnapshot("reviews/w2.md", newestAge + 14);
  writeSnapshot("reviews/w3.md", newestAge + 7);
  writeSnapshot("reviews/w4.md", newestAge);
}

async function stalePaths(pathVisible?: (p: string) => boolean): Promise<string[]> {
  const report = await runLint(vault, pathVisible ? { pathVisible } : {});
  expect(report.ok).toBe(true);
  if (!report.ok) return [];
  return report.value.checks.staleFiles.map((f) => f.path);
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-series-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("series staleness", () => {
  describe("lint staleFiles", () => {
    it("lists none of four weekly snapshots when the newest is nine days old", async () => {
      writeFourWeeklies(9);
      expect(await stalePaths()).toEqual([]);
    });

    it("lists only the newest when it is twenty days old", async () => {
      writeFourWeeklies(20);
      expect(await stalePaths()).toEqual(["reviews/w4.md"]);
    });

    it("still flags a document outside any series", async () => {
      writeFourWeeklies(9);
      writeDoc("notes/lone.md", { ttl_days: 14, created: daysAgo(40), updated: daysAgo(40) });
      expect(await stalePaths()).toEqual(["notes/lone.md"]);
    });

    it("judges each series on its own newest member", async () => {
      writeSnapshot("reviews/a-old.md", 40, { series: "a" });
      writeSnapshot("reviews/a-new.md", 20, { series: "a" });
      writeSnapshot("reviews/b-old.md", 40, { series: "b" });
      writeSnapshot("reviews/b-new.md", 3, { series: "b" });
      expect(await stalePaths()).toEqual(["reviews/a-new.md"]);
    });

    it("does not let a typo fix on an old snapshot stand in for a new one", async () => {
      writeSnapshot("reviews/w1.md", 30, { updated: daysAgo(0) });
      writeSnapshot("reviews/w2.md", 20);
      expect(await stalePaths()).toEqual(["reviews/w2.md"]);
    });

    it("never goes stale when the newest member made no freshness promise", async () => {
      writeSnapshot("reviews/w1.md", 30);
      writeSnapshot("reviews/w2.md", 20, { ttl_days: "null" });
      expect(await stalePaths()).toEqual([]);
    });

    it("does not let a retired snapshot keep the series fresh", async () => {
      writeSnapshot("reviews/w1.md", 30);
      writeSnapshot("reviews/w2.md", 16);
      writeSnapshot("reviews/w3.md", 9, { status: "deprecated" });
      expect(await stalePaths()).toEqual(["reviews/w2.md"]);
    });

    it("judges the newest member the caller can see, so a hidden one leaks nothing", async () => {
      writeSnapshot("reviews/w1.md", 30);
      writeSnapshot("reviews/w2.md", 20);
      writeSnapshot("restricted/w3.md", 2);
      const visible = await stalePaths((p) => p.startsWith("reviews/"));
      expect(visible).toEqual(["reviews/w2.md"]);
      expect(await stalePaths()).toEqual([]);
    });
  });

  describe("vault_status", () => {
    it("counts only the newest member as stale", async () => {
      writeFourWeeklies(20);
      const r = await vaultStatus(vault);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.stalenessDistribution).toEqual({ fresh: 3, aging: 0, stale: 1, total: 4 });
    });

    it("scores over the caller's visible set", async () => {
      writeSnapshot("reviews/w1.md", 30);
      writeSnapshot("restricted/w2.md", 2);
      const analyst: AccessContext = {
        user: "human:test",
        roleName: "analyst",
        role: { read: ["reviews"], write: [], promote: false, ratify: false },
      };
      const r = await vaultStatus(vault, analyst);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.stalenessDistribution).toEqual({ fresh: 0, aging: 0, stale: 1, total: 1 });
    });
  });

  describe("sleep", () => {
    it("reports only the newest member as decayed", async () => {
      writeFourWeeklies(20);
      const r = await runSleepCycle(vault);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.staleness.stale).toBe(1);
      expect(r.value.decayedQuiet.map((q) => q.path)).toEqual(["reviews/w4.md"]);
    });
  });

  describe("interview", () => {
    it("asks only about the newest member", async () => {
      writeFourWeeklies(20);
      const r = await gatherQuestions(vault);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const stale = r.value.filter((q) => q.kind === "stale");
      expect(stale).toHaveLength(1);
      expect(stale[0]?.question).toContain("reviews/w4.md");
    });
  });
});
