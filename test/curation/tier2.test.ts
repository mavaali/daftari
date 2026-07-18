import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProvenanceEntry } from "../../src/curation/provenance.js";
import {
  accumulateFieldChanges,
  coveringVerdict,
  extractUsageSpan,
  latestUnitChangeTs,
  readTier2Verdicts,
  recordTier2Verdict,
  type Tier2Verdict,
} from "../../src/curation/tier2.js";

function entry(over: Partial<ProvenanceEntry>): ProvenanceEntry {
  return {
    timestamp: "2026-07-10T00:00:00.000Z",
    tool: "vault_write",
    file: "a/unit.md",
    agent: "agent:x",
    action: "update",
    body_changed: false,
    ...over,
  };
}

function verdict(over: Partial<Tier2Verdict>): Tier2Verdict {
  return {
    timestamp: "2026-07-11T00:00:00.000Z",
    artifact: "a/dep.md",
    unit: "a/unit.md",
    edge_class: "declared",
    judged_change_ts: "2026-07-10T00:00:00.000Z",
    verdict: "still-valid",
    reasoning: "checked",
    agent: "agent:judge",
    ...over,
  };
}

describe("tier2 primitives (#232)", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-tier2-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("verdicts round-trip through the append-only store", async () => {
    const empty = await readTier2Verdicts(vault);
    expect(empty.ok && empty.value).toEqual([]);

    const first = await recordTier2Verdict(vault, {
      artifact: "a/dep.md",
      unit: "a/unit.md",
      edge_class: "earned",
      judged_change_ts: "2026-07-10T00:00:00.000Z",
      verdict: "broken",
      tension_kind: "factual",
      tension_id: "t-042",
      reasoning: "scope narrowed",
      agent: "agent:judge",
      run_id: "run-9",
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.timestamp).toBeTruthy();

    const back = await readTier2Verdicts(vault);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value).toHaveLength(1);
    expect(back.value[0]?.tension_id).toBe("t-042");
    expect(back.value[0]?.run_id).toBe("run-9");
  });

  it("latestUnitChangeTs ignores rejected writes and other files", () => {
    const prov = [
      entry({ timestamp: "2026-07-01T00:00:00.000Z" }),
      entry({ timestamp: "2026-07-05T00:00:00.000Z" }),
      entry({ timestamp: "2026-07-09T00:00:00.000Z", action: "rejected_stale" }),
      entry({ timestamp: "2026-07-08T00:00:00.000Z", file: "a/other.md" }),
    ];
    expect(latestUnitChangeTs(prov, "a/unit.md")).toBe("2026-07-05T00:00:00.000Z");
    expect(latestUnitChangeTs(prov, "a/none.md")).toBeNull();
  });

  it("coveringVerdict: exact pair+class, current change only, newest wins", () => {
    const verdicts = [
      verdict({ timestamp: "2026-07-11T00:00:00.000Z", verdict: "still-valid" }),
      verdict({ timestamp: "2026-07-12T00:00:00.000Z", verdict: "broken" }),
      verdict({ edge_class: "earned" }), // wrong class
      verdict({ artifact: "a/other.md" }), // wrong pair
    ];
    const key = {
      artifact: "a/dep.md",
      unit: "a/unit.md",
      edgeClass: "declared" as const,
      latestChangeTs: "2026-07-10T00:00:00.000Z",
    };
    expect(coveringVerdict(verdicts, key)?.verdict).toBe("broken"); // newest of the two

    // The unit changed again after the judgments: nothing covers.
    expect(
      coveringVerdict(verdicts, { ...key, latestChangeTs: "2026-07-13T00:00:00.000Z" }),
    ).toBeNull();
  });

  it("accumulateFieldChanges nets first-before to last-after and flags body", () => {
    const prov = [
      entry({
        timestamp: "2026-07-06T00:00:00.000Z",
        frontmatter_diff: { scope: { before: "all", after: "most" } },
      }),
      entry({
        timestamp: "2026-07-07T00:00:00.000Z",
        frontmatter_diff: { scope: { before: "most", after: "some" } },
        body_changed: true,
      }),
      entry({ timestamp: "2026-07-01T00:00:00.000Z", body_changed: true }), // before baseline
    ];
    const changes = accumulateFieldChanges(prov, "a/unit.md", "2026-07-05T00:00:00.000Z");
    expect(changes.scope).toEqual({ before: "all", after: "some" });
    expect(changes.body).toEqual({ before: null, after: null });
  });

  it("extractUsageSpan pulls mentioning lines with context, null when absent", () => {
    const body = [
      "# Dep",
      "",
      "Intro paragraph.",
      "The Metric value drives this analysis.",
      "Unrelated middle.",
      "More unrelated.",
      "Even more filler.",
      "Also filler.",
      "See pricing/metric.md for details.",
      "Tail.",
    ].join("\n");
    const span = extractUsageSpan(body, { path: "pricing/metric.md", title: "Metric" });
    expect(span).toContain("The Metric value drives this analysis.");
    expect(span).toContain("See pricing/metric.md for details.");
    expect(span).toContain("…"); // the gap between the two mentions

    expect(extractUsageSpan("nothing relevant here", { path: "pricing/metric.md" })).toBeNull();
  });
});
