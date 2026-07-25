import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatherQuestions, normalizeQuestion, renderSheet } from "../../src/interview/questions.js";

const TODAY = new Date().toISOString().slice(0, 10);

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

let vault: string;

function yamlList(key: string, items: string[]): string {
  if (items.length === 0) return `${key}: []`;
  return `${key}:\n${items.map((s) => `  - "${s}"`).join("\n")}`;
}

function writeDoc(
  relPath: string,
  opts: {
    title?: string;
    domain?: string;
    status?: string;
    updated?: string;
    ttl?: number | null;
    raised?: string[];
    answered?: string[];
  } = {},
): void {
  const lines = [
    `title: "${opts.title ?? `Doc ${relPath}`}"`,
    `domain: ${opts.domain ?? "accumulation"}`,
    `collection: ${relPath.split("/")[0] ?? ""}`,
    `status: ${opts.status ?? "canonical"}`,
    "confidence: medium",
    `created: ${TODAY}`,
    `updated: ${opts.updated ?? TODAY}`,
    "updated_by: agent:test",
    "provenance: direct",
    "superseded_by: null",
    `ttl_days: ${opts.ttl === undefined || opts.ttl === null ? "null" : opts.ttl}`,
    "sources: []",
    "tags: []",
    yamlList("questions_raised", opts.raised ?? []),
    yamlList("questions_answered", opts.answered ?? []),
  ];
  mkdirSync(join(vault, relPath.split("/")[0] ?? ""), { recursive: true });
  writeFileSync(
    join(vault, relPath),
    `---\n${lines.join("\n")}\n---\n\nBody of ${relPath}.\n`,
    "utf-8",
  );
}

function tensionBlock(args: {
  id?: string;
  title: string;
  date: string;
  kind?: string;
  sourceA?: string;
  sourceB?: string;
  claimA?: string;
  claimB?: string;
  resolved?: boolean;
}): string {
  const lines = [`## ${args.date} — ${args.title}`];
  if (args.id) lines.push(`- **Id:** ${args.id}`);
  if (args.kind) lines.push(`- **Kind:** ${args.kind}`);
  lines.push(`- **Source A:** ${args.sourceA ?? "pricing/a.md"} says ${args.claimA ?? "X."}`);
  lines.push(`- **Source B:** ${args.sourceB ?? "pricing/b.md"} says ${args.claimB ?? "Y."}`);
  lines.push(`- **Status:** ${args.resolved ? "resolved" : "unresolved"}`);
  lines.push("- **Logged by:** agent:test");
  if (args.resolved) {
    lines.push("- **Resolved at:** 2026-07-01T00:00:00Z");
    lines.push("- **Resolved by:** human:test");
    lines.push("- **Resolution kind:** corrected");
  }
  return `${lines.join("\n")}\n`;
}

function writeTensions(blocks: string[]): void {
  mkdirSync(join(vault, ".daftari"), { recursive: true });
  writeFileSync(join(vault, ".daftari", "tensions.md"), blocks.join("\n"), "utf-8");
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-interview-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("gatherQuestions — tension questions", () => {
  it("asks about unresolved tensions, quoting both claims", async () => {
    writeDoc("pricing/a.md");
    writeDoc("pricing/b.md");
    writeTensions([
      tensionBlock({
        id: "tension-001",
        title: "A vs B",
        date: daysAgo(5),
        kind: "factual",
        claimA: "the entry tier is free.",
        claimB: "there is no free tier.",
      }),
    ]);

    const r = await gatherQuestions(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tension = r.value.filter((q) => q.kind === "tension");
    expect(tension).toHaveLength(1);
    expect(tension[0]?.question).toContain('"the entry tier is free."');
    expect(tension[0]?.question).toContain('"there is no free tier."');
    expect(tension[0]?.refs).toEqual(["tension-001", "pricing/a.md", "pricing/b.md"]);
  });

  it("skips resolved, legacy-unspecified, and inter-proposal entries", async () => {
    writeTensions([
      tensionBlock({
        id: "tension-001",
        title: "Closed",
        date: daysAgo(40),
        kind: "factual",
        resolved: true,
      }),
      tensionBlock({ title: "Legacy, no id or kind", date: daysAgo(200) }),
      tensionBlock({
        id: "tension-002",
        title: "Contested proposal",
        date: daysAgo(3),
        kind: "inter-proposal",
        sourceA: "pricing/a.md",
        sourceB: "pricing/a.md",
      }),
      tensionBlock({ id: "tension-003", title: "Open", date: daysAgo(3), kind: "temporal" }),
    ]);

    const r = await gatherQuestions(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tension = r.value.filter((q) => q.kind === "tension");
    expect(tension).toHaveLength(1);
    expect(tension[0]?.refs[0]).toBe("tension-003");
  });

  it("asks the longest-carried disputes first (stale tier, then oldest)", async () => {
    writeTensions([
      tensionBlock({ id: "tension-001", title: "Fresh", date: daysAgo(5), kind: "factual" }),
      tensionBlock({ id: "tension-002", title: "Stale", date: daysAgo(120), kind: "factual" }),
      tensionBlock({ id: "tension-003", title: "Aging", date: daysAgo(45), kind: "factual" }),
    ]);

    const r = await gatherQuestions(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.filter((q) => q.kind === "tension").map((q) => q.refs[0]);
    expect(ids).toEqual(["tension-002", "tension-003", "tension-001"]);
  });
});

describe("gatherQuestions — stale questions", () => {
  it("asks about expired canonical accumulation docs, largest overshoot first", async () => {
    writeDoc("pricing/very-stale.md", { updated: daysAgo(100), ttl: 30 });
    writeDoc("pricing/barely-stale.md", { updated: daysAgo(40), ttl: 30 });
    writeDoc("pricing/fresh.md", { updated: TODAY, ttl: 30 });

    const r = await gatherQuestions(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const stale = r.value.filter((q) => q.kind === "stale");
    expect(stale.map((q) => q.refs[0])).toEqual([
      "pricing/very-stale.md",
      "pricing/barely-stale.md",
    ]);
    expect(stale[0]?.question).toContain("70 days past its 30-day freshness window");
  });

  it("never asks about generative, non-canonical, or no-TTL docs", async () => {
    writeDoc("moonshot/idea.md", { domain: "generative", updated: daysAgo(100), ttl: 30 });
    writeDoc("_drafts/wip.md", { status: "draft", updated: daysAgo(100), ttl: 30 });
    writeDoc("pricing/timeless.md", { updated: daysAgo(1000), ttl: null });

    const r = await gatherQuestions(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.filter((q) => q.kind === "stale")).toHaveLength(0);
  });
});

describe("gatherQuestions — open questions", () => {
  it("asks questions_raised that no doc answers, and merges duplicate raisings", async () => {
    writeDoc("pricing/a.md", { raised: ["How elastic is demand?"] });
    writeDoc("pricing/b.md", { raised: ["How elastic is  DEMAND?"] });

    const r = await gatherQuestions(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const open = r.value.filter((q) => q.kind === "open_question");
    expect(open).toHaveLength(1);
    expect(open[0]?.refs).toEqual(["pricing/a.md", "pricing/b.md"]);
  });

  it("treats an answer recorded anywhere as closing the question", async () => {
    writeDoc("pricing/a.md", { raised: ["What is the unit of billing?"] });
    writeDoc("competitive-intel/c.md", { answered: ["what is the unit of  billing?"] });

    const r = await gatherQuestions(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.filter((q) => q.kind === "open_question")).toHaveLength(0);
  });

  it("ignores questions raised only by retired docs", async () => {
    writeDoc("pricing/old.md", { status: "deprecated", raised: ["Still relevant?"] });

    const r = await gatherQuestions(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.filter((q) => q.kind === "open_question")).toHaveLength(0);
  });
});

describe("gatherQuestions — sheet assembly", () => {
  it("orders kinds tension → stale → open_question and assigns sequential ids", async () => {
    writeDoc("pricing/stale.md", { updated: daysAgo(60), ttl: 30 });
    writeDoc("pricing/curious.md", { raised: ["Open one?"] });
    writeTensions([
      tensionBlock({ id: "tension-001", title: "Open", date: daysAgo(3), kind: "factual" }),
    ]);

    const r = await gatherQuestions(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((q) => q.kind)).toEqual(["tension", "stale", "open_question"]);
    expect(r.value.map((q) => q.id)).toEqual(["q-001", "q-002", "q-003"]);
  });

  it("caps the sheet at --limit after ordering", async () => {
    writeDoc("pricing/stale.md", { updated: daysAgo(60), ttl: 30 });
    writeDoc("pricing/curious.md", { raised: ["Open one?"] });
    writeTensions([
      tensionBlock({ id: "tension-001", title: "Open", date: daysAgo(3), kind: "factual" }),
    ]);

    const r = await gatherQuestions(vault, { limit: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((q) => q.kind)).toEqual(["tension", "stale"]);
  });

  it("returns an empty sheet for a vault with nothing unclear", async () => {
    writeDoc("pricing/fine.md", { updated: TODAY, ttl: 365 });

    const r = await gatherQuestions(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(0);
  });
});

describe("normalizeQuestion", () => {
  it("collapses whitespace and case", () => {
    expect(normalizeQuestion("  What   IS it? ")).toBe("what is it?");
  });
});

describe("renderSheet", () => {
  it("renders one block per question with id, kind, and refs", async () => {
    writeTensions([
      tensionBlock({ id: "tension-001", title: "Open", date: daysAgo(3), kind: "factual" }),
    ]);
    const r = await gatherQuestions(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const sheet = renderSheet(r.value, TODAY);
    expect(sheet).toContain(`# Interview sheet — ${TODAY}`);
    expect(sheet).toContain("## q-001 — tension");
    expect(sheet).toContain("tension-001, pricing/a.md, pricing/b.md");
  });
});
