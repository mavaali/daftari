import { describe, expect, it } from "vitest";
import { resolveCanon } from "../../src/canon/resolve.js";
import type { CanonDoc } from "../../src/canon/types.js";
import { buildRegistry } from "../../src/holders/registry.js";

const reg = buildRegistry({});
const doc = (p: string, holder: string, from: string | null, until: string | null): CanonDoc => ({
  path: p,
  holder,
  valid_from: from,
  valid_until: until,
  updated: from ?? "2026-01-01",
  collection: "x",
});

describe("resolveCanon", () => {
  it("returns settled when currently-valid docs share no tension", () => {
    const docs = [
      doc("A.md", "human:alice", "2026-01-01", null),
      doc("B.md", "human:bob", "2026-01-01", null),
    ];
    const r = resolveCanon(docs, ["human:alice", "human:bob"], "2026-07-01", reg, []);
    expect(r.contested).toHaveLength(0);
    expect(r.settled.length).toBeGreaterThan(0);
  });

  it("returns a contested trajectory (sorted by valid_from) when a tension links two valid docs", () => {
    const docs = [
      doc("A.md", "human:alice", "2026-06-01", null),
      doc("B.md", "human:bob", "2026-01-01", null),
    ];
    const tensions = [{ sourceA: "A.md", sourceB: "B.md" }];
    const r = resolveCanon(docs, ["human:alice", "human:bob"], "2026-07-01", reg, tensions);
    expect(r.settled).toHaveLength(0);
    expect(r.contested).toHaveLength(1);
    expect(r.contested[0].trajectory.map((t) => t.path)).toEqual(["B.md", "A.md"]); // earlier valid_from first
  });

  it("excludes fossils (expired valid_until) from canon", () => {
    const docs = [doc("A.md", "human:alice", "2026-01-01", "2026-03-01")]; // expired before asOf
    const r = resolveCanon(docs, ["human:alice"], "2026-07-01", reg, []);
    expect(r.settled).toHaveLength(0);
    expect(r.contested).toHaveLength(0);
  });

  it("v1 contract: two non-contested valid docs with the same holder string produce two SettledClaims", () => {
    const docs = [
      doc("A.md", "human:alice", "2026-01-01", null),
      doc("B.md", "human:alice", "2026-01-01", null),
    ];
    const r = resolveCanon(docs, ["human:alice"], "2026-07-01", reg, []);
    expect(r.contested).toHaveLength(0);
    expect(r.settled).toHaveLength(2); // one per doc, not grouped
  });

  it("flags ghost holders when registry is non-empty and holder is unregistered", () => {
    const regWithEntries = buildRegistry({ x: "agent:x" });
    const docs = [doc("G.md", "human:ghost", "2026-01-01", null)];
    const r = resolveCanon(docs, ["human:ghost"], "2026-07-01", regWithEntries, []);
    expect(r.flags.ghost_holder_warning).toBeDefined();
    expect(r.flags.ghost_holder_warning?.strings).toContain("human:ghost");
    expect(r.flags.ghost_holder_warning?.count).toBe(1);
  });
});
