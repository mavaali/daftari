// `daftari review-stats` (bead 9mpe) — read-only aggregate over the review
// journal: decisions by kind, time-to-decision, changed share, tension weeks.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendReviewEvents, type ReviewEvent } from "../../src/curation/review-log.js";
import {
  parseSince,
  renderReviewStats,
  reviewStats,
  runReviewStats,
} from "../../src/curation/review-stats.js";

const NOW = new Date("2026-11-18T12:00:00Z"); // a Wednesday

function decision(
  item: string,
  at: string,
  kind: "human" | "agent" | "unknown",
  changed: boolean,
  surface = "staged",
): ReviewEvent {
  return {
    ev: "decision",
    surface,
    item,
    action: changed ? "ratified" : "rejected",
    decided_by_kind: kind,
    changed_anything: changed,
    at,
  };
}

function shown(item: string, at: string, kind: "human" | "agent" | "unknown"): ReviewEvent {
  return { ev: "shown", surface: "board", item, viewer_kind: kind, at };
}

describe("parseSince", () => {
  it("accepts Nd, Nw and an ISO date", () => {
    expect(parseSince("30d", NOW)?.toISOString()).toBe("2026-10-19T12:00:00.000Z");
    expect(parseSince("2w", NOW)?.toISOString()).toBe("2026-11-04T12:00:00.000Z");
    expect(parseSince("2026-11-01", NOW)?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
  it("rejects garbage", () => {
    expect(parseSince("soon", NOW)).toBeNull();
    expect(parseSince("0d", NOW)).toBeNull();
    expect(parseSince("-3d", NOW)).toBeNull();
  });
});

describe("reviewStats", () => {
  const events: ReviewEvent[] = [
    // Human: shown 10:00, decided 11:00 (1h) and shown 10:00, decided 13:00 (3h).
    shown("stage-001", "2026-11-10T10:00:00Z", "human"),
    decision("stage-001", "2026-11-10T11:00:00Z", "human", true),
    shown("stage-002", "2026-11-10T10:00:00Z", "human"),
    decision("stage-002", "2026-11-10T13:00:00Z", "human", false),
    // Agent: shown to the agent at 09:00 and decided 09:06 (0.1h). An earlier
    // HUMAN surfacing is ignored — the agent's own clock is used.
    shown("stage-003", "2026-11-09T09:00:00Z", "human"),
    shown("stage-003", "2026-11-11T09:00:00Z", "agent"),
    decision("stage-003", "2026-11-11T09:06:00Z", "agent", false),
    // Never shown: counted, but unmeasured for timing.
    decision("stage-004", "2026-11-12T00:00:00Z", "unknown", false, "board"),
    // Outside the window.
    decision("stage-000", "2026-09-01T00:00:00Z", "human", true),
    // Tensions: 2 opened week of 11-09, 1 resolved week of 11-16.
    { ev: "tension_open", item: "tension-001", at: "2026-11-09T08:00:00Z" },
    { ev: "tension_open", item: "tension-002", at: "2026-11-10T08:00:00Z" },
    decision("tension-001", "2026-11-17T08:00:00Z", "human", false, "tension"),
  ];

  const stats = reviewStats(events, new Date("2026-11-04T00:00:00Z"), NOW);

  it("counts decisions by kind and surface inside the window", () => {
    expect(stats.decisions.total).toBe(5);
    expect(stats.decisions.byKind).toEqual({ human: 3, agent: 1, unknown: 1 });
    expect(stats.decisions.bySurface.staged).toEqual({ human: 2, agent: 1, unknown: 0 });
    expect(stats.decisions.bySurface.board).toEqual({ human: 0, agent: 0, unknown: 1 });
    expect(stats.decisions.bySurface.tension).toEqual({ human: 1, agent: 0, unknown: 0 });
  });

  it("reports the changed share", () => {
    expect(stats.decisions.changed).toBe(1);
    expect(stats.decisions.changedPct).toBe(20);
  });

  it("times shown → decided per decider kind, nearest-rank", () => {
    expect(stats.timeToDecision.measured).toBe(3);
    expect(stats.timeToDecision.unmeasured).toBe(2);
    expect(stats.timeToDecision.byKind.human).toEqual({ n: 2, p50Hours: 1, p90Hours: 3 });
    expect(stats.timeToDecision.byKind.agent).toEqual({ n: 1, p50Hours: 0.1, p90Hours: 0.1 });
    expect(stats.timeToDecision.byKind.unknown).toEqual({ n: 0, p50Hours: null, p90Hours: null });
    expect(stats.timeToDecision.overall).toEqual({ n: 3, p50Hours: 1, p90Hours: 3 });
  });

  it("buckets tension lifecycle by Monday-start week with a running backlog", () => {
    expect(stats.tensions.weeks).toEqual([
      { weekStart: "2026-11-02", opened: 0, resolved: 0, backlog: 0 },
      { weekStart: "2026-11-09", opened: 2, resolved: 0, backlog: 2 },
      { weekStart: "2026-11-16", opened: 0, resolved: 1, backlog: 1 },
    ]);
  });

  it("an empty journal yields zeros, not NaN", () => {
    const empty = reviewStats([], new Date("2026-11-04T00:00:00Z"), NOW);
    expect(empty.decisions.total).toBe(0);
    expect(empty.decisions.changedPct).toBeNull();
    expect(empty.timeToDecision.overall.p50Hours).toBeNull();
  });

  it("renders plain text with the headline numbers", () => {
    const text = renderReviewStats(stats);
    expect(text).toContain("Decisions: 5");
    expect(text).toContain("human 3");
    expect(text).toContain("changed the vault: 1 (20%)");
    expect(text).toContain("2026-11-09");
  });
});

describe("runReviewStats", () => {
  let vault: string;
  let out: string;
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-rs-"));
    out = "";
    spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out += String(s);
      return true;
    });
  });
  afterEach(() => {
    spy.mockRestore();
    rmSync(vault, { recursive: true, force: true });
  });

  it("--json prints the aggregate and exits 0", async () => {
    appendReviewEvents(vault, [decision("stage-001", new Date().toISOString(), "human", true)]);
    expect(await runReviewStats(["--vault", vault, "--json"])).toBe(0);
    const parsed = JSON.parse(out) as { decisions: { byKind: Record<string, number> } };
    expect(parsed.decisions.byKind.human).toBe(1);
  });

  it("plain text on an empty vault exits 0", async () => {
    expect(await runReviewStats(["--vault", vault])).toBe(0);
    expect(out).toContain("Decisions: 0");
  });

  it("a bad --since is a usage error (exit 2)", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await runReviewStats(["--vault", vault, "--since", "soon"])).toBe(2);
    } finally {
      err.mockRestore();
    }
  });
});
