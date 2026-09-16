import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSleepCycle } from "../../src/sleep/cycle.js";
import { renderMarkdown } from "../../src/sleep/report.js";
import { commit, headFullSha } from "../../src/utils/git.js";

const NOW = new Date("2026-08-21T00:00:00Z");

function md(
  vault: string,
  path: string,
  opts: {
    sources?: string[];
    domain?: "accumulation" | "generative";
    status?: string;
  } = {},
): void {
  mkdirSync(dirname(join(vault, path)), { recursive: true });
  const sources = (opts.sources ?? []).map((source) => JSON.stringify(source)).join(", ");
  writeFileSync(
    join(vault, path),
    `---\n` +
      `title: ${path}\n` +
      `domain: ${opts.domain ?? "accumulation"}\n` +
      `collection: ${path.split("/")[0] ?? ""}\n` +
      `status: ${opts.status ?? "canonical"}\n` +
      `confidence: high\n` +
      `created: 2026-08-01\n` +
      `updated: 2026-08-20\n` +
      `updated_by: agent:test\n` +
      `provenance: direct\n` +
      `ttl_days: 365\n` +
      `sources: [${sources}]\n` +
      `tags: []\n` +
      `---\n\nBody.\n`,
  );
}

async function commitPaths(vault: string, paths: string[], message: string): Promise<void> {
  const result = await commit(vault, paths, message, "agent:test");
  if (!result.ok) throw result.error;
}

describe("daftari sleep — vanished-source wake", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-sleep-vanished-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("wakes a fresh canonical dependent with the last commit that contained its deleted source", async () => {
    md(vault, "refs/source.md");
    md(vault, "analysis/dependent.md", { sources: ["vault:refs/source.md"] });
    await commitPaths(vault, ["refs/source.md", "analysis/dependent.md"], "add source graph");
    const sourceCommit = await headFullSha(vault);
    expect(sourceCommit.ok).toBe(true);
    if (!sourceCommit.ok) return;

    rmSync(join(vault, "refs/source.md"));
    await commitPaths(vault, ["refs/source.md"], "delete source");
    const dependentBefore = readFileSync(join(vault, "analysis/dependent.md"), "utf-8");

    const result = await runSleepCycle(vault, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const task = result.value.wake.find((candidate) => candidate.path === "analysis/dependent.md");
    expect(task?.reason).toContain("source-vanished");
    expect(task?.reason).toContain("refs/source.md");
    expect(task?.reason).toContain(sourceCommit.value);
    expect(task?.reason).toContain("recoverable via asof");
    const report = renderMarkdown({
      generatedAt: NOW.toISOString(),
      vault,
      cycle: result.value,
      wakeQueuePath: null,
      wakeLimit: 20,
    });
    expect(report).toContain("source-vanished");
    expect(report).toContain(sourceCommit.value);
    expect(readFileSync(join(vault, "analysis/dependent.md"), "utf-8")).toBe(dependentBefore);

    md(vault, "refs/source.md");
    await commitPaths(vault, ["refs/source.md"], "restore source");
    const restored = await runSleepCycle(vault, NOW);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.wake.map((candidate) => candidate.path)).not.toContain(
      "analysis/dependent.md",
    );
  });

  it("wakes from a vanished unit in the artifact's current compiled edge group", async () => {
    md(vault, "refs/compiled-source.md");
    md(vault, "analysis/artifact.md");
    await commitPaths(
      vault,
      ["refs/compiled-source.md", "analysis/artifact.md"],
      "compile artifact",
    );
    const sourceCommit = await headFullSha(vault);
    expect(sourceCommit.ok).toBe(true);
    if (!sourceCommit.ok) return;
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(
      join(vault, ".daftari", "consumes.jsonl"),
      `${JSON.stringify({
        artifact: "analysis/artifact.md",
        unit: "refs/compiled-source.md",
        edge_type: "whole-doc-read",
        fields: ["*"],
        run_id: "run-1",
        compile_ts: "2026-08-20T00:00:00.000Z",
      })}\n`,
    );
    rmSync(join(vault, "refs/compiled-source.md"));
    await commitPaths(vault, ["refs/compiled-source.md"], "delete compiled source");

    const result = await runSleepCycle(vault, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const task = result.value.wake.find((candidate) => candidate.path === "analysis/artifact.md");
    expect(task?.reason).toContain("source-vanished");
    expect(task?.reason).toContain(sourceCommit.value);
  });

  it("distinguishes a source absent from available history", async () => {
    md(vault, "analysis/dependent.md", { sources: ["vault:refs/never-tracked.md"] });
    await commitPaths(vault, ["analysis/dependent.md"], "add dependent");

    const result = await runSleepCycle(vault, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const task = result.value.wake.find((candidate) => candidate.path === "analysis/dependent.md");
    expect(task?.reason).toContain("source-vanished");
    expect(task?.reason).toContain("not found in available git history");
    expect(task?.reason).toContain("gone-forever in available history");
    expect(task?.reason).not.toContain("(recoverable via asof)");
  });

  it("keeps unavailable Git history distinct from a gone-forever result", async () => {
    md(vault, "analysis/dependent.md", { sources: ["vault:refs/missing.md"] });

    const result = await runSleepCycle(vault, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const task = result.value.wake.find((candidate) => candidate.path === "analysis/dependent.md");
    expect(task?.reason).toContain("git history unavailable");
    expect(task?.reason).not.toContain("gone-forever");
  });

  it("escapes source-path pipes in the Morning Report table", async () => {
    md(vault, "analysis/dependent.md", { sources: ["vault:refs/weird|name.md"] });

    const result = await runSleepCycle(vault, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = renderMarkdown({
      generatedAt: NOW.toISOString(),
      vault,
      cycle: result.value,
      wakeQueuePath: null,
      wakeLimit: 20,
    });
    expect(report).toContain("refs/weird\\|name.md");
    expect(report).not.toContain("refs/weird|name.md");
  });

  it("ignores vanished units from superseded compiled edge groups", async () => {
    md(vault, "refs/live.md");
    md(vault, "analysis/artifact.md");
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(
      join(vault, ".daftari", "consumes.jsonl"),
      `${[
        {
          artifact: "analysis/artifact.md",
          unit: "refs/old-missing.md",
          edge_type: "whole-doc-read",
          fields: ["*"],
          run_id: "run-old",
          compile_ts: "2026-08-19T00:00:00.000Z",
        },
        {
          artifact: "analysis/artifact.md",
          unit: "refs/live.md",
          edge_type: "whole-doc-read",
          fields: ["*"],
          run_id: "run-current",
          compile_ts: "2026-08-20T00:00:00.000Z",
        },
      ]
        .map((edge) => JSON.stringify(edge))
        .join("\n")}\n`,
    );

    const result = await runSleepCycle(vault, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.wake).toEqual([]);
  });

  it("ranks vanished-source wakes by the existing blast-first order", async () => {
    md(vault, "analysis/high-blast.md", { sources: ["vault:refs/missing-high.md"] });
    md(vault, "analysis/low-blast.md", { sources: ["vault:refs/missing-low.md"] });
    md(vault, "analysis/downstream.md", { sources: ["vault:analysis/high-blast.md"] });
    await commitPaths(
      vault,
      ["analysis/high-blast.md", "analysis/low-blast.md", "analysis/downstream.md"],
      "add ranked dependents",
    );

    const result = await runSleepCycle(vault, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.wake.map((task) => task.path)).toEqual([
      "analysis/high-blast.md",
      "analysis/low-blast.md",
    ]);
  });

  it("does not classify legacy, repository, or distill references as vanished vault sources", async () => {
    md(vault, "analysis/legacy.md", { sources: ["refs/missing.md"] });
    md(vault, "analysis/repo.md", { sources: ["repo:refs/missing.md"] });
    md(vault, "analysis/distill.md", { sources: ["distill:discarded-input"] });
    await commitPaths(
      vault,
      ["analysis/legacy.md", "analysis/repo.md", "analysis/distill.md"],
      "add external references",
    );

    const result = await runSleepCycle(vault, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.wake).toEqual([]);
  });

  it("keeps the canonical accumulation domain gate", async () => {
    md(vault, "analysis/generative.md", {
      domain: "generative",
      sources: ["vault:refs/missing.md"],
    });
    md(vault, "analysis/draft.md", {
      status: "draft",
      sources: ["vault:refs/missing.md"],
    });
    await commitPaths(vault, ["analysis/generative.md", "analysis/draft.md"], "add gated docs");

    const result = await runSleepCycle(vault, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.wake).toEqual([]);
  });
});
