import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBrief, buildDocket } from "../../src/court/docket.js";
import { runCourt } from "../../src/court/index.js";
import { findPrecedents } from "../../src/court/precedent.js";
import { listTensions, type TensionEntry } from "../../src/curation/tension.js";

const TODAY = new Date().toISOString().slice(0, 10);

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

let vault: string;

function writeDoc(
  relPath: string,
  overrides: Record<string, string | null> = {},
  sources: string[] = [],
): void {
  const fm: Record<string, string | null> = {
    title: `Doc ${relPath}`,
    domain: "accumulation",
    collection: relPath.split("/")[0] ?? "",
    status: "canonical",
    confidence: "medium",
    created: TODAY,
    updated: TODAY,
    updated_by: "agent:test",
    provenance: "direct",
    superseded_by: null,
    ...overrides,
  };
  const lines = Object.entries(fm).map(([k, v]) => (v === null ? `${k}: null` : `${k}: "${v}"`));
  const src =
    sources.length > 0 ? `sources:\n${sources.map((s) => `  - "${s}"`).join("\n")}` : "sources: []";
  mkdirSync(join(vault, relPath.split("/")[0] ?? ""), { recursive: true });
  writeFileSync(
    join(vault, relPath),
    `---\n${lines.join("\n")}\nttl_days: 365\n${src}\ntags: []\n---\n\nBody of ${relPath}.\n`,
    "utf-8",
  );
}

function tensionBlock(args: {
  id: string;
  title: string;
  date: string;
  kind: string;
  sourceA: string;
  sourceB: string;
  resolved?: { at: string; by: string; kind: string; rationale?: string };
}): string {
  const lines = [
    `## ${args.date} — ${args.title}`,
    `- **Id:** ${args.id}`,
    `- **Kind:** ${args.kind}`,
    `- **Source A:** ${args.sourceA} says X.`,
    `- **Source B:** ${args.sourceB} says Y.`,
    `- **Status:** ${args.resolved ? "resolved" : "unresolved"}`,
    `- **Logged by:** agent:test`,
  ];
  if (args.resolved) {
    lines.push(`- **Resolved at:** ${args.resolved.at}`);
    lines.push(`- **Resolved by:** ${args.resolved.by}`);
    lines.push(`- **Resolution kind:** ${args.resolved.kind}`);
    if (args.resolved.rationale) lines.push(`- **Rationale:** ${args.resolved.rationale}`);
  }
  return `${lines.join("\n")}\n`;
}

function writeTensions(blocks: string[]): void {
  mkdirSync(join(vault, ".daftari"), { recursive: true });
  writeFileSync(join(vault, ".daftari", "tensions.md"), blocks.join("\n"), "utf-8");
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-court-"));
  // Documents: base is cited by derived (source edge) and linked (body link).
  writeDoc("pricing/base.md");
  writeDoc("pricing/derived.md", {}, ["pricing/base.md"]);
  writeDoc("competitive-intel/other.md");
  writeDoc("moonshot/idea.md", { status: "draft", confidence: "low" });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("buildDocket", () => {
  it("briefs open tensions and ranks stale + high-blast cases first", async () => {
    writeTensions([
      tensionBlock({
        id: "t-fresh",
        title: "Fresh small dispute",
        date: daysAgo(5),
        kind: "interpretive",
        sourceA: "competitive-intel/other.md",
        sourceB: "moonshot/idea.md",
      }),
      tensionBlock({
        id: "t-stale",
        title: "Stale wide dispute",
        date: daysAgo(120),
        kind: "factual",
        sourceA: "pricing/base.md",
        sourceB: "competitive-intel/other.md",
      }),
    ]);

    const r = await buildDocket(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.openCount).toBe(2);
    expect(r.value.rulingCount).toBe(0);
    expect(r.value.entries.map((e) => e.id)).toEqual(["t-stale", "t-fresh"]);

    const stale = r.value.entries[0];
    expect(stale?.agingTier).toBe("stale");
    expect(stale?.sideA.status).toBe("canonical");
    // base is cited by derived (source edge); other has no inbound edges.
    expect(stale?.blast.primary).toBe(1);
    expect(stale?.blast.total).toBe(1);
    expect(stale?.precedents).toEqual([]);
  });

  it("marks a side whose document no longer exists as gone", async () => {
    writeTensions([
      tensionBlock({
        id: "t-ghost",
        title: "Dispute with a deleted side",
        date: daysAgo(10),
        kind: "factual",
        sourceA: "pricing/base.md",
        sourceB: "pricing/deleted.md",
      }),
    ]);

    const r = await buildDocket(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.entries[0]?.sideB.status).toBe("gone");
  });

  it("attaches cluster membership when tensions share documents", async () => {
    writeTensions([
      tensionBlock({
        id: "t-1",
        title: "A vs B",
        date: daysAgo(10),
        kind: "factual",
        sourceA: "pricing/base.md",
        sourceB: "pricing/derived.md",
      }),
      tensionBlock({
        id: "t-2",
        title: "B vs C",
        date: daysAgo(10),
        kind: "factual",
        sourceA: "pricing/derived.md",
        sourceB: "competitive-intel/other.md",
      }),
    ]);

    const r = await buildDocket(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.entries[0]?.clusterId).toBeTruthy();
    expect(r.value.entries[0]?.clusterSize).toBe(3);
    expect(r.value.entries[0]?.clusterId).toBe(r.value.entries[1]?.clusterId);
  });
});

describe("findPrecedents", () => {
  const open: TensionEntry = {
    id: "t-open",
    date: TODAY,
    title: "Open dispute",
    kind: "factual",
    sourceA: "pricing/base.md",
    sourceB: "competitive-intel/other.md",
    claimA: "X",
    claimB: "Y",
    status: "unresolved",
    loggedBy: "agent:test",
    resolved: false,
  };

  function ruling(overrides: Partial<TensionEntry>): TensionEntry {
    return {
      id: "t-ruled",
      date: daysAgo(60),
      title: "Past dispute",
      kind: "temporal",
      sourceA: "moonshot/idea.md",
      sourceB: "moonshot/other.md",
      claimA: "P",
      claimB: "Q",
      status: "resolved",
      loggedBy: "agent:test",
      resolved: true,
      resolution: {
        resolved_at: "2026-05-01T00:00:00Z",
        resolved_by: "human:test",
        kind: "corrected",
        rationale: "The newer measurement was right.",
      },
      ...overrides,
    };
  }

  it("tiers shared-document above collection-pair above same-kind", () => {
    const shared = ruling({ id: "r-shared", sourceA: "pricing/base.md" });
    const pair = ruling({
      id: "r-pair",
      sourceA: "pricing/whatever.md",
      sourceB: "competitive-intel/thing.md",
    });
    const kind = ruling({ id: "r-kind", kind: "factual" });

    const found = findPrecedents(open, [kind, pair, shared]);
    expect(found.map((p) => p.id)).toEqual(["r-shared", "r-pair", "r-kind"]);
    expect(found[0]?.matchTier).toBe("shared-document");
    expect(found[1]?.matchTier).toBe("collection-pair");
    expect(found[2]?.matchTier).toBe("same-kind");
    expect(found[0]?.rationale).toBe("The newer measurement was right.");
  });

  it("returns nothing when no ruling matches any tier", () => {
    const unrelated = ruling({}); // temporal kind, moonshot pair, no shared doc
    expect(findPrecedents(open, [unrelated])).toEqual([]);
  });

  it("canonicalizes alias paths in the collection-pair key", () => {
    // pricing/../moonshot/x.md is a moonshot doc — its raw top segment says
    // pricing, but it must NOT match the open pricing ↔ competitive-intel pair.
    const aliasOut = ruling({
      id: "r-alias-out",
      sourceA: "pricing/../moonshot/x.md",
      sourceB: "competitive-intel/thing.md",
    });
    expect(findPrecedents(open, [aliasOut])).toEqual([]);

    // moonshot/../pricing/x.md IS a pricing doc — it must match.
    const aliasIn = ruling({
      id: "r-alias-in",
      sourceA: "moonshot/../pricing/x.md",
      sourceB: "competitive-intel/thing.md",
    });
    const found = findPrecedents(open, [aliasIn]);
    expect(found.map((p) => p.id)).toEqual(["r-alias-in"]);
    expect(found[0]?.matchTier).toBe("collection-pair");
  });

  it("caps at three and prefers newer rulings within a tier", () => {
    const rulings = [1, 2, 3, 4].map((i) =>
      ruling({
        id: `r-${i}`,
        kind: "factual",
        resolution: {
          resolved_at: `2026-0${i}-01T00:00:00Z`,
          resolved_by: "human:test",
          kind: "corrected",
        },
      }),
    );
    const found = findPrecedents(open, rulings);
    expect(found).toHaveLength(3);
    expect(found.map((p) => p.id)).toEqual(["r-4", "r-3", "r-2"]);
  });
});

describe("buildBrief", () => {
  it("returns the single case by id, and null for an unknown id", async () => {
    writeTensions([
      tensionBlock({
        id: "t-1",
        title: "A vs B",
        date: daysAgo(10),
        kind: "factual",
        sourceA: "pricing/base.md",
        sourceB: "pricing/derived.md",
      }),
    ]);
    const hit = await buildBrief(vault, "t-1");
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(hit.value?.title).toBe("A vs B");

    const miss = await buildBrief(vault, "t-nope");
    expect(miss.ok).toBe(true);
    if (!miss.ok) return;
    expect(miss.value).toBeNull();
  });
});

describe("runCourt (CLI)", () => {
  it("prints the docket and writes JSON", async () => {
    writeTensions([
      tensionBlock({
        id: "t-1",
        title: "A vs B",
        date: daysAgo(120),
        kind: "factual",
        sourceA: "pricing/base.md",
        sourceB: "competitive-intel/other.md",
      }),
    ]);
    const outMd = join(vault, "..", `court-${Date.now()}.md`);
    const outJson = `${outMd}.json`;
    const code = await runCourt(["--vault", vault, "--output", outMd, "--output-json", outJson]);
    expect(code).toBe(0);

    const md = readFileSync(outMd, "utf-8");
    expect(md).toContain("# Tension Court — Docket");
    expect(md).toContain("**1** case(s) open");
    expect(md).toContain("## 1. A vs B  [stale · factual · 120d]");
    expect(md).toContain("daftari court rule t-1");
    expect(md).toContain("precedents: none — first impression");

    const json = JSON.parse(readFileSync(outJson, "utf-8"));
    expect(json.docket.openCount).toBe(1);
    expect(json.docket.entries[0].id).toBe("t-1");
    rmSync(outMd, { force: true });
    rmSync(outJson, { force: true });
  });

  it("rules a tension, and the ruling becomes precedent on the next docket", async () => {
    writeTensions([
      tensionBlock({
        id: "t-old",
        title: "Old pricing dispute",
        date: daysAgo(50),
        kind: "factual",
        sourceA: "pricing/base.md",
        sourceB: "competitive-intel/other.md",
      }),
      tensionBlock({
        id: "t-new",
        title: "New pricing dispute",
        date: daysAgo(2),
        kind: "factual",
        sourceA: "pricing/base.md",
        sourceB: "pricing/derived.md",
      }),
    ]);

    const code = await runCourt([
      "rule",
      "t-old",
      "--vault",
      vault,
      "--kind",
      "corrected",
      "--rationale",
      "Vendor page confirmed the entry tier.",
      "--by",
      "human:test",
    ]);
    expect(code).toBe(0);

    // The log now records the ruling…
    const tensions = await listTensions(vault);
    expect(tensions.ok).toBe(true);
    if (!tensions.ok) return;
    const ruled = tensions.value.find((t) => t.id === "t-old");
    expect(ruled?.resolved).toBe(true);
    expect(ruled?.resolution?.kind).toBe("corrected");
    expect(ruled?.resolution?.resolved_by).toBe("human:test");

    // …and the next docket cites it as precedent on the similar open case.
    const docket = await buildDocket(vault);
    expect(docket.ok).toBe(true);
    if (!docket.ok) return;
    expect(docket.value.openCount).toBe(1);
    expect(docket.value.rulingCount).toBe(1);
    const precedents = docket.value.entries[0]?.precedents ?? [];
    expect(precedents).toHaveLength(1);
    expect(precedents[0]?.title).toBe("Old pricing dispute");
    expect(precedents[0]?.matchTier).toBe("shared-document");
    expect(precedents[0]?.rationale).toBe("Vendor page confirmed the entry tier.");
  });

  it("exits 2 on a bad --kind and on an unknown id", async () => {
    writeTensions([
      tensionBlock({
        id: "t-1",
        title: "A vs B",
        date: daysAgo(10),
        kind: "factual",
        sourceA: "pricing/base.md",
        sourceB: "pricing/derived.md",
      }),
    ]);
    expect(await runCourt(["rule", "t-1", "--vault", vault, "--kind", "sure"])).toBe(2);
    expect(await runCourt(["rule", "t-missing", "--vault", vault, "--kind", "corrected"])).toBe(2);
    expect(await runCourt(["rule", "--vault", vault, "--kind", "corrected"])).toBe(2);
  });

  it("renders a single brief with --tension, including a miss message", async () => {
    writeTensions([
      tensionBlock({
        id: "t-1",
        title: "A vs B",
        date: daysAgo(10),
        kind: "factual",
        sourceA: "pricing/base.md",
        sourceB: "pricing/derived.md",
      }),
    ]);
    const outMd = join(vault, "..", `brief-${Date.now()}.md`);
    expect(await runCourt(["--vault", vault, "--tension", "t-1", "--output", outMd])).toBe(0);
    expect(readFileSync(outMd, "utf-8")).toContain("# Tension Court — Brief");

    expect(await runCourt(["--vault", vault, "--tension", "t-none", "--output", outMd])).toBe(0);
    expect(readFileSync(outMd, "utf-8")).toContain("No open tension with id");
    rmSync(outMd, { force: true });
  });

  it("prints an empty-docket message when there are no tensions", async () => {
    const outMd = join(vault, "..", `empty-${Date.now()}.md`);
    expect(await runCourt(["--vault", vault, "--output", outMd])).toBe(0);
    expect(readFileSync(outMd, "utf-8")).toContain("The docket is clear.");
    rmSync(outMd, { force: true });
  });
});
