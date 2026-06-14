import { describe, expect, it } from "vitest";
import type { DueEdge } from "../../src/consolidate/clocks.js";
import { prioritize } from "../../src/consolidate/priority.js";

function due(from: string, reason: DueEdge["reason"], strength = 1): DueEdge {
  return { fromPath: from, toPath: "p.md", strength, reason };
}

describe("prioritize", () => {
  it("dedups an edge due for multiple reasons into the strongest tier", () => {
    const out = prioritize({
      edgeDue: [due("a.md", "event"), due("a.md", "backstop")],
      birth: [],
      budget: 10,
      ages: {},
    });
    const a = out.queue.filter((q) => q.kind === "edge" && q.fromPath === "a.md");
    expect(a).toHaveLength(1);
    expect(a[0]?.slice).toBe("backstop");
  });

  it("reserves a periphery slice so a low-fragility stale edge still appears under load", () => {
    const main = Array.from({ length: 20 }, (_, i) => due(`m${i}.md`, "decay", 0.1)); // high-fragility
    const peripheral = due("p1.md", "decay", 4.9); // low fragility, but oldest
    const out = prioritize({
      edgeDue: [...main, peripheral],
      birth: [],
      budget: 6,
      ages: { "p1.md": 1000 }, // very stale → wins the periphery slice
    });
    expect(
      out.queue.some((q) => q.kind === "edge" && q.fromPath === "p1.md" && q.slice === "periphery"),
    ).toBe(true);
  });

  it("reserves a birth slice and respects the total ceiling", () => {
    const out = prioritize({
      edgeDue: Array.from({ length: 20 }, (_, i) => due(`e${i}.md`, "decay")),
      birth: ["b1.md", "b2.md", "b3.md"],
      budget: 8,
      ages: {},
    });
    expect(out.queue.length).toBeLessThanOrEqual(8);
    expect(out.queue.some((q) => q.kind === "birth")).toBe(true);
    expect(out.backstopOverdueRemaining).toBe(0);
  });

  it("backstop overflow steals from main but NOT from the reserved periphery/birth slices", () => {
    // 6 backstop-overdue (cap 2 → +4 overflow) + 3 decay + 2 birth, budget 8.
    // Overflow must eat main (decay), leaving ≥1 periphery and ≥1 birth (§3.3.1/§3.3.4).
    const out = prioritize({
      edgeDue: [
        ...Array.from({ length: 6 }, (_, i) => due(`bk${i}.md`, "backstop")),
        ...Array.from({ length: 3 }, (_, i) => due(`dk${i}.md`, "decay")),
      ],
      birth: ["b1.md", "b2.md"],
      budget: 8,
      ages: {},
    });
    expect(out.queue.length).toBeLessThanOrEqual(8);
    expect(out.queue.some((q) => q.slice === "periphery")).toBe(true);
    expect(out.queue.some((q) => q.kind === "birth")).toBe(true);
    expect(out.backstopOverdueRemaining).toBe(0);
  });

  it("reports unserved backstop work (the exit-4 cron-alert driver) under total starvation", () => {
    // 6 backstop-overdue, budget 4: only 4 fit, 2 left unserved → caller exits 4.
    const out = prioritize({
      edgeDue: Array.from({ length: 6 }, (_, i) => due(`bk${i}.md`, "backstop")),
      birth: [],
      budget: 4,
      ages: {},
    });
    expect(out.queue.length).toBe(4);
    expect(out.backstopOverdueRemaining).toBe(2);
  });

  it("ranks event above decay in the main slice", () => {
    // A stale `filler` takes the (reason-blind) periphery slot so ev + dk both
    // reach main, where event must outrank decay regardless of fragility.
    const out = prioritize({
      edgeDue: [due("ev.md", "event", 5), due("dk.md", "decay", 0), due("filler.md", "decay", 0)],
      birth: [],
      budget: 3,
      ages: { "filler.md": 1000 },
    });
    const main = out.queue.filter((q) => q.kind === "edge" && q.slice === "main");
    expect(main[0]?.kind === "edge" && main[0].fromPath).toBe("ev.md");
  });

  it("treats two edges sharing a fromPath but different toPath as distinct work", () => {
    const out = prioritize({
      edgeDue: [
        { fromPath: "a.md", toPath: "b.md", strength: 1, reason: "decay" },
        { fromPath: "a.md", toPath: "c.md", strength: 1, reason: "decay" },
      ],
      birth: [],
      budget: 10,
      ages: {},
    });
    const aEdges = out.queue.filter((q) => q.kind === "edge" && q.fromPath === "a.md");
    expect(aEdges).toHaveLength(2);
  });
});
