// nlzr: the "grounding at risk" primitive — pure classification. One test per
// reason kind, the healthy baseline (no false positive), and the banner/summary
// rendering every surface shares.

import { describe, expect, it } from "vitest";
import {
  assessGrounding,
  type GroundingSourceState,
  groundingSummary,
  sourceRiskReasons,
} from "../../src/curation/grounding.js";

const NOW = new Date("2026-12-20T12:00:00Z");

function src(overrides: Partial<GroundingSourceState> = {}): GroundingSourceState {
  return {
    path: "competitive-intel/a1.md",
    status: "canonical",
    supersededBy: null,
    updated: "2026-12-01",
    ttlDays: 30,
    validFrom: null,
    validUntil: null,
    tensionIds: [],
    tensionCount: 0,
    ...overrides,
  };
}

describe("sourceRiskReasons — one reason per kind", () => {
  it("healthy source: no reasons (fresh TTL, in-window, uncontested, canonical)", () => {
    expect(
      sourceRiskReasons(src({ validFrom: "2026-10-01", validUntil: "2027-06-01" }), NOW),
    ).toEqual([]);
  });

  it("no TTL and no interval is healthy, never 'expired'", () => {
    expect(sourceRiskReasons(src({ ttlDays: null, updated: "2020-01-01" }), NOW)).toEqual([]);
  });

  it("contested: names the tension ids and the true count", () => {
    const r = sourceRiskReasons(src({ tensionIds: ["t-1", "t-2"], tensionCount: 2 }), NOW);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      source: "competitive-intel/a1.md",
      kind: "contested",
      tensionIds: ["t-1", "t-2"],
    });
    expect(r[0]?.detail).toContain("2 unresolved tensions");
    expect(r[0]?.detail).toContain("t-1");
  });

  it("contested via a legacy tension (no id) still counts", () => {
    const r = sourceRiskReasons(src({ tensionIds: [], tensionCount: 1 }), NOW);
    expect(r.map((x) => x.kind)).toEqual(["contested"]);
  });

  it("ttl-expired: computed from updated + ttl_days, with the expiry date", () => {
    const r = sourceRiskReasons(src({ updated: "2026-11-18", ttlDays: 30 }), NOW);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "ttl-expired", expiredOn: "2026-12-18" });
    expect(r[0]?.detail).toContain("30d TTL");
    expect(r[0]?.detail).toContain("2026-12-18");
  });

  it("ttl boundary matches computeStaleness: expired exactly at age == ttl", () => {
    const at = sourceRiskReasons(src({ updated: "2026-11-20", ttlDays: 30 }), NOW);
    expect(at.map((x) => x.kind)).toEqual(["ttl-expired"]);
    const before = sourceRiskReasons(src({ updated: "2026-11-21", ttlDays: 30 }), NOW);
    expect(before).toEqual([]);
  });

  it("validity-ended: past valid_until (half-open), with the end date", () => {
    const r = sourceRiskReasons(src({ validFrom: "2026-01-01", validUntil: "2026-12-01" }), NOW);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "validity-ended", expiredOn: "2026-12-01" });
  });

  it("an inverted/malformed interval is unknown, not ended", () => {
    expect(
      sourceRiskReasons(src({ validFrom: "2026-12-01", validUntil: "2026-01-01" }), NOW),
    ).toEqual([]);
    expect(sourceRiskReasons(src({ validUntil: "not-a-date" }), NOW)).toEqual([]);
  });

  it("superseded: status superseded or a superseded_by pointer", () => {
    expect(sourceRiskReasons(src({ status: "superseded" }), NOW).map((x) => x.kind)).toEqual([
      "superseded",
    ]);
    expect(
      sourceRiskReasons(src({ supersededBy: "competitive-intel/a1-v2.md" }), NOW).map(
        (x) => x.kind,
      ),
    ).toEqual(["superseded"]);
  });

  it("retracted: deprecated or archived", () => {
    for (const status of ["deprecated", "archived"]) {
      const r = sourceRiskReasons(src({ status }), NOW);
      expect(r.map((x) => x.kind)).toEqual(["retracted"]);
      expect(r[0]?.detail).toContain(status);
    }
  });

  it("a retired source does not also report its lapsed TTL or interval", () => {
    const r = sourceRiskReasons(
      src({ status: "deprecated", updated: "2020-01-01", validUntil: "2021-01-01" }),
      NOW,
    );
    expect(r.map((x) => x.kind)).toEqual(["retracted"]);
  });

  it("several kinds on one source are all reported, in a stable order", () => {
    const r = sourceRiskReasons(
      src({
        updated: "2026-01-01",
        validUntil: "2026-06-01",
        tensionIds: ["t-9"],
        tensionCount: 1,
      }),
      NOW,
    );
    expect(r.map((x) => x.kind)).toEqual(["contested", "ttl-expired", "validity-ended"]);
  });
});

describe("assessGrounding", () => {
  it("returns null when every source is healthy (no false positive)", () => {
    expect(assessGrounding([src(), src({ path: "b.md" })], NOW)).toBeNull();
    expect(assessGrounding([], NOW)).toBeNull();
  });

  it("collects reasons across sources, sorted by source path, with a banner naming each", () => {
    const g = assessGrounding(
      [
        src({ path: "z/expired.md", updated: "2026-01-01" }),
        src({ path: "a/healthy.md" }),
        src({ path: "m/contested.md", tensionIds: ["t-7"], tensionCount: 1 }),
      ],
      NOW,
    );
    expect(g).not.toBeNull();
    expect(g?.reasons.map((r) => [r.source, r.kind])).toEqual([
      ["m/contested.md", "contested"],
      ["z/expired.md", "ttl-expired"],
    ]);
    expect(g?.banner).toContain("GROUNDING AT RISK");
    expect(g?.banner).toContain("m/contested.md — ");
    expect(g?.banner).toContain("z/expired.md — ");
    expect(g?.banner).not.toContain("a/healthy.md");
  });

  it("groundingSummary is a one-line 'grounding at risk: <source> — <reason>' with overflow", () => {
    const g = assessGrounding(
      [
        src({ path: "a.md", updated: "2026-01-01" }),
        src({ path: "b.md", status: "deprecated" }),
        src({ path: "c.md", status: "superseded" }),
      ],
      NOW,
    );
    if (!g) throw new Error("expected at-risk");
    const line = groundingSummary(g);
    expect(line.startsWith("grounding at risk: a.md — ")).toBe(true);
    expect(line).toContain("+2 more");
    expect(line).not.toContain("\n");
  });
});
