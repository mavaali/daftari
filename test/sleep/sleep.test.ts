import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stageAction } from "../../src/curation/staged-actions.js";
import { runSleepCycle } from "../../src/sleep/cycle.js";
import { runSleep, wakeQueuePath } from "../../src/sleep/index.js";

const TODAY = new Date().toISOString().slice(0, 10);

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

let vault: string;

function writeDoc(
  relPath: string,
  overrides: Record<string, string | number | null> = {},
  sources: string[] = [],
): void {
  const fm: Record<string, string | number | null> = {
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
    ttl_days: 120,
    ...overrides,
  };
  const lines = Object.entries(fm).map(([k, v]) => {
    if (v === null) return `${k}: null`;
    return typeof v === "number" ? `${k}: ${v}` : `${k}: "${v}"`;
  });
  const src =
    sources.length > 0 ? `sources:\n${sources.map((s) => `  - "${s}"`).join("\n")}` : "sources: []";
  mkdirSync(join(vault, relPath.split("/")[0] ?? ""), { recursive: true });
  writeFileSync(
    join(vault, relPath),
    `---\n${lines.join("\n")}\n${src}\ntags: []\n---\n\nBody of ${relPath}.\n`,
    "utf-8",
  );
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-sleep-"));
  // The cast:
  //   pricing/rotten.md — canonical, past its 30d TTL, cited by derived.md
  //     → the load-bearing wake case.
  //   pricing/lonely.md — canonical, past TTL, no dependents → quiet decay.
  //   moonshot/dream.md — GENERATIVE, past TTL → counted, never woken.
  //   pricing/fresh.md — canonical, inside TTL → untouched.
  writeDoc("pricing/rotten.md", { updated: daysAgo(90), created: daysAgo(90), ttl_days: 30 });
  writeDoc("pricing/derived.md", {}, ["pricing/rotten.md"]);
  writeDoc("pricing/lonely.md", { updated: daysAgo(200), created: daysAgo(200), ttl_days: 30 });
  writeDoc("moonshot/dream.md", {
    domain: "generative",
    updated: daysAgo(90),
    created: daysAgo(90),
    ttl_days: 30,
  });
  writeDoc("pricing/fresh.md");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("runSleepCycle", () => {
  it("wakes load-bearing decayed docs and only them", async () => {
    const r = await runSleepCycle(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value;

    expect(c.wake.map((w) => w.path)).toEqual(["pricing/rotten.md"]);
    const w = c.wake[0];
    expect(w?.blastPrimary).toBe(1);
    expect(w?.blastTotal).toBe(1);
    expect(w?.ttlDays).toBe(30);
    expect(w?.ageDays).toBeGreaterThanOrEqual(90);
    expect(w?.reason).toContain("re-verify against its sources");

    expect(c.decayedQuiet.map((q) => q.path)).toEqual(["pricing/lonely.md"]);
    expect(c.generativeStale).toBe(1);
    // rotten + lonely are stale; dream is stale too but counted in the
    // distribution; fresh + derived are fresh.
    expect(c.staleness.stale).toBe(3);
    expect(c.staleness.total).toBe(5);
  });

  it("ranks the wake list by blast, then age", async () => {
    // A second decayed doc with a WIDER blast must outrank rotten.
    writeDoc("pricing/hub.md", { updated: daysAgo(40), created: daysAgo(40), ttl_days: 30 });
    writeDoc("competitive-intel/a.md", {}, ["pricing/hub.md"]);
    writeDoc("competitive-intel/b.md", {}, ["pricing/hub.md"]);

    const r = await runSleepCycle(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.wake.map((w) => w.path)).toEqual(["pricing/hub.md", "pricing/rotten.md"]);
  });

  it("sweeps expired staged actions and reports the queue", async () => {
    const staged = await stageAction(vault, {
      actionType: "deprecate",
      targetPath: "pricing/lonely.md",
      proposedBy: "agent:test",
      rationale: "long past TTL with no dependents",
      proposedDiff: { status: "deprecated" },
      ttlDays: 2,
    });
    expect(staged.ok).toBe(true);

    const r = await runSleepCycle(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ratification.pending).toBe(1);
    expect(r.value.ratification.expiringSoon).toHaveLength(1);
    expect(r.value.ratification.expiringSoon[0]?.targetPath).toBe("pricing/lonely.md");
    expect(r.value.sweptExpired).toEqual([]);
  });

  it("surfaces stale tensions and the docket head", async () => {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(
      join(vault, ".daftari", "tensions.md"),
      `## ${daysAgo(120)} — Old dispute\n- **Id:** t-old\n- **Kind:** factual\n` +
        `- **Source A:** pricing/rotten.md says X.\n- **Source B:** pricing/fresh.md says Y.\n` +
        `- **Status:** unresolved\n- **Logged by:** agent:test\n`,
      "utf-8",
    );

    const r = await runSleepCycle(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tensions.open).toBe(1);
    expect(r.value.tensions.stale).toHaveLength(1);
    expect(r.value.tensions.stale[0]?.id).toBe("t-old");
    expect(r.value.tensions.docketTop[0]?.title).toBe("Old dispute");
    expect(r.value.tensions.docketTop[0]?.tier).toBe("stale");
  });
});

describe("runSleep (CLI)", () => {
  it("writes the report, the JSON, and the wake queue", async () => {
    const outMd = join(vault, "..", `sleep-${Date.now()}.md`);
    const outJson = `${outMd}.json`;
    const code = await runSleep(["--vault", vault, "--output", outMd, "--output-json", outJson]);
    expect(code).toBe(0);

    const md = readFileSync(outMd, "utf-8");
    expect(md).toContain("# Morning Report");
    expect(md).toContain("## Wake list — 1 load-bearing decayed document(s)");
    expect(md).toContain("| pricing/rotten.md |");
    expect(md).toContain("Quiet decay — 1");
    expect(md).toContain("generative docs past TTL: 1");

    const queue = readFileSync(wakeQueuePath(vault), "utf-8").trim().split("\n");
    expect(queue).toHaveLength(1);
    expect(JSON.parse(queue[0] as string).path).toBe("pricing/rotten.md");

    const json = JSON.parse(readFileSync(outJson, "utf-8"));
    expect(json.cycle.wake).toHaveLength(1);
    expect(json.wakeQueuePath).toBe(wakeQueuePath(vault));
    rmSync(outMd, { force: true });
    rmSync(outJson, { force: true });
  });

  it("skips the queue with --no-queue", async () => {
    const outMd = join(vault, "..", `sleep-nq-${Date.now()}.md`);
    expect(await runSleep(["--vault", vault, "--no-queue", "--output", outMd])).toBe(0);
    expect(existsSync(wakeQueuePath(vault))).toBe(false);
    rmSync(outMd, { force: true });
  });

  it("caps the report's wake rows at --wake-limit with an explicit remainder", async () => {
    writeDoc("pricing/old2.md", { updated: daysAgo(50), created: daysAgo(50), ttl_days: 30 });
    writeDoc("competitive-intel/c.md", {}, ["pricing/old2.md"]);
    const outMd = join(vault, "..", `sleep-cap-${Date.now()}.md`);
    expect(await runSleep(["--vault", vault, "--wake-limit", "1", "--output", outMd])).toBe(0);
    const md = readFileSync(outMd, "utf-8");
    expect(md).toContain("…and 1 more (full list in the queue)");
    // The queue still carries the full list.
    expect(readFileSync(wakeQueuePath(vault), "utf-8").trim().split("\n")).toHaveLength(2);
    rmSync(outMd, { force: true });
  });

  it("rejects a bad --wake-limit", async () => {
    expect(await runSleep(["--vault", vault, "--wake-limit", "zero"])).toBe(2);
  });

  it("prints help on --help", async () => {
    expect(await runSleep(["--help"])).toBe(0);
  });
});

describe("runSleep (--dream selection)", () => {
  it("rejects an unknown dream type", async () => {
    expect(await runSleep(["--vault", vault, "--dream", "lucid"])).toBe(2);
  });

  it("--dream circadian is the default pass (no LLM, exit 0)", async () => {
    const outMd = join(vault, "..", `sleep-dream-${Date.now()}.md`);
    expect(
      await runSleep(["--vault", vault, "--dream", "circadian", "--no-queue", "--output", outMd]),
    ).toBe(0);
    expect(readFileSync(outMd, "utf-8")).toContain("# Morning Report");
    rmSync(outMd, { force: true });
  });

  it("--dream tension-scan fails fast (exit 2) without an API key — no free-path spend", async () => {
    // The scan is the ONLY dream that can spend; a missing key must be a
    // config error before any vault work happens.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("DAFTARI_LLM_TRANSPORT", "");
    try {
      expect(await runSleep(["--vault", vault, "--dream", "tension-scan"])).toBe(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("--dream tension-scan rejects a bad --max-llm-calls", async () => {
    expect(
      await runSleep(["--vault", vault, "--dream", "tension-scan", "--max-llm-calls", "zero"]),
    ).toBe(2);
  });
});
