import { describe, expect, it } from "vitest";
import { birthQueue, decayBackstopDue, eventDue } from "../../src/consolidate/clocks.js";
import { docContentHash } from "../../src/consolidate/state.js";
import type { DerivesFromEdge, DirectionVerdict } from "../../src/curation/edges.js";

const NOW = new Date("2026-06-13T00:00:00Z");
function edge(
  from: string,
  to: string,
  strength: number,
  lastRederived: string,
  directionVerdict: DirectionVerdict = "directed",
): DerivesFromEdge {
  return {
    fromPath: from,
    toPath: to,
    strength,
    kSurvived: 1,
    firstObserved: lastRederived,
    lastRederived,
    status: "trigger-bearing",
    directionVerdict,
    observations: 1,
    contestedAt: null,
    contestReason: null,
  };
}

describe("decayBackstopDue", () => {
  it("flags an edge past its strength-scaled interval as decay-due", () => {
    const fresh = edge("a.md", "b.md", 0, "2026-06-12T00:00:00Z"); // 1 day, interval(0)=1 → due
    const due = decayBackstopDue([fresh], NOW);
    expect(due.map((d) => d.reason)).toContain("decay");
  });
  it("flags an edge past MAX_INTERVAL as backstop, even if strong", () => {
    const old = edge("a.md", "b.md", 5, "2026-01-01T00:00:00Z"); // ~163 days > 90
    const due = decayBackstopDue([old], NOW);
    expect(due.find((d) => d.fromPath === "a.md")?.reason).toBe("backstop");
  });
  it("does not flag a strong, recently-reviewed edge", () => {
    const ok = edge("a.md", "b.md", 5, "2026-06-12T00:00:00Z");
    expect(decayBackstopDue([ok], NOW)).toEqual([]);
  });
  it("never flags a direction-symmetric edge, even when otherwise backstop-overdue", () => {
    const sym = edge("a.md", "b.md", 5, "2026-01-01T00:00:00Z", "symmetric");
    expect(decayBackstopDue([sym], NOW)).toEqual([]);
  });
});

describe("eventDue", () => {
  it("marks dependents of a changed premise due, attenuating by path strength", () => {
    // c derives_from b derives_from a; a changed. strengths high enough to propagate.
    const edges = [
      edge("b.md", "a.md", 5, "2026-06-12T00:00:00Z"),
      edge("c.md", "b.md", 5, "2026-06-12T00:00:00Z"),
    ];
    const due = eventDue(["a.md"], edges);
    expect(due.map((d) => d.fromPath).sort()).toEqual(["b.md", "c.md"]);
  });
  it("symmetric edges do not propagate event triggers", () => {
    // b derives_from a, but direction is unconfirmed (symmetric): a changing
    // must NOT make b due.
    const due = eventDue(["a.md"], [edge("b.md", "a.md", 5, "2026-06-12T00:00:00Z", "symmetric")]);
    expect(due.map((d) => d.fromPath)).not.toContain("b.md");
    expect(due).toEqual([]);
  });
  it("stops propagation where the strength product drops below the floor", () => {
    const edges = [edge("b.md", "a.md", 0.05, "2026-06-12T00:00:00Z")];
    expect(eventDue(["a.md"], edges)).toEqual([]);
  });
  it("normalizes attenuation by EDGE_K_CAP (factor = strength/5): 0.5 passes, 0.4 stops", () => {
    const T = "2026-06-12T00:00:00Z";
    // factor 0.5/5 = 0.1 == floor → due; 0.4/5 = 0.08 < 0.1 → not due.
    expect(eventDue(["a.md"], [edge("b.md", "a.md", 0.5, T)]).map((d) => d.fromPath)).toEqual([
      "b.md",
    ]);
    expect(eventDue(["a.md"], [edge("b.md", "a.md", 0.4, T)])).toEqual([]);
  });
  it("relaxes on max product: a descendant reachable only via the STRONGER path is still due", () => {
    const T = "2026-06-12T00:00:00Z";
    // d reachable from a weakly (d←a, factor .2) and strongly (a→c→d, factors 1·1=1).
    // e (e←d, factor .2): weak path .2·.2=.04 < floor; strong path 1·.2=.2 ≥ floor.
    // First-touch pruning would mark d at .2 and drop e; max-product keeps e due.
    const edges = [
      edge("d.md", "a.md", 1, T), // weak 1-hop to d (factor .2)
      edge("c.md", "a.md", 5, T), // strong
      edge("d.md", "c.md", 5, T), // strong 2-hop to d (factor 1)
      edge("e.md", "d.md", 1, T), // d → e (factor .2)
    ];
    const fromPaths = eventDue(["a.md"], edges).map((d) => d.fromPath);
    expect(fromPaths).toContain("e.md");
  });
  it("treats two edges sharing a fromPath but different premise as distinct", () => {
    const T = "2026-06-12T00:00:00Z";
    const edges = [edge("a.md", "b.md", 5, T), edge("a.md", "c.md", 5, T)];
    const due = eventDue(["b.md", "c.md"], edges);
    expect(due.map((d) => d.toPath).sort()).toEqual(["b.md", "c.md"]);
  });
});

describe("birthQueue", () => {
  it("includes unprocessed docs and edited (hash-changed) docs", () => {
    const docs = [
      { relPath: "a.md", content: "A" },
      { relPath: "b.md", content: "B" },
    ];
    const q = birthQueue(docs, { "a.md": "stale-hash" });
    expect(q.sort()).toEqual(["a.md", "b.md"]); // a: hash differs, b: absent
  });
  it("excludes a doc whose hash matches", () => {
    const docs = [{ relPath: "a.md", content: "A" }];
    expect(birthQueue(docs, { "a.md": docContentHash("A") })).toEqual([]);
  });
});
