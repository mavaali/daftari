import { describe, expect, it } from "vitest";
import { ageInDays, computeStaleness, olderSeriesMembers } from "../../src/curation/staleness.js";

const NOW = new Date("2026-02-15T12:00:00Z");

describe("staleness", () => {
  describe("ageInDays", () => {
    it("counts whole days since an ISO date", () => {
      expect(ageInDays("2026-02-01", NOW)).toBe(14);
      expect(ageInDays("2026-02-15", NOW)).toBe(0);
    });

    it("returns 0 for an unparseable date", () => {
      expect(ageInDays("", NOW)).toBe(0);
    });
  });

  describe("computeStaleness", () => {
    it("scores a freshly updated document at 0", () => {
      const r = computeStaleness({ updated: "2026-02-15", ttl_days: 30 }, NOW);
      expect(r.score).toBe(0);
      expect(r.expired).toBe(false);
    });

    it("scores a document halfway through its TTL at ~0.5", () => {
      const r = computeStaleness({ updated: "2026-01-31", ttl_days: 30 }, NOW);
      expect(r.ageDays).toBe(15);
      expect(r.score).toBeCloseTo(0.5, 5);
      expect(r.expired).toBe(false);
    });

    it("scores a document at its TTL as fully stale and expired", () => {
      const r = computeStaleness({ updated: "2026-01-16", ttl_days: 30 }, NOW);
      expect(r.score).toBe(1);
      expect(r.expired).toBe(true);
    });

    it("caps the score at 1.0 well past the TTL", () => {
      const r = computeStaleness({ updated: "2024-01-01", ttl_days: 30 }, NOW);
      expect(r.score).toBe(1);
      expect(r.expired).toBe(true);
    });

    it("never goes stale when there is no TTL", () => {
      const r = computeStaleness({ updated: "2010-01-01", ttl_days: null }, NOW);
      expect(r.score).toBe(0);
      expect(r.expired).toBe(false);
      expect(r.ttlDays).toBeNull();
    });
  });

  describe("olderSeriesMembers", () => {
    const member = (
      path: string,
      created: string,
      over: { series?: string | null; status?: string; updated?: string } = {},
    ) => ({
      path,
      frontmatter: {
        series: "s" as string | null,
        status: "canonical",
        created,
        updated: created,
        ...over,
      },
    });

    it("returns every member but the newest by created", () => {
      const older = olderSeriesMembers([
        member("b.md", "2026-01-08"),
        member("c.md", "2026-01-15"),
        member("a.md", "2026-01-01"),
      ]);
      expect([...older].sort()).toEqual(["a.md", "b.md"]);
    });

    it("ignores documents outside a series, including a blank name", () => {
      const older = olderSeriesMembers([
        member("a.md", "2026-01-01", { series: null }),
        member("b.md", "2026-01-02", { series: null }),
        member("c.md", "2026-01-01", { series: "  " }),
        member("d.md", "2026-01-02", { series: "  " }),
      ]);
      expect(older.size).toBe(0);
    });

    it("does not order by updated", () => {
      const older = olderSeriesMembers([
        member("old.md", "2026-01-01", { updated: "2026-02-15" }),
        member("new.md", "2026-01-08"),
      ]);
      expect([...older]).toEqual(["old.md"]);
    });

    it("breaks a created tie on path, descending", () => {
      const older = olderSeriesMembers([
        member("w-01.md", "2026-01-01"),
        member("w-02.md", "2026-01-01"),
      ]);
      expect([...older]).toEqual(["w-01.md"]);
    });

    it("falls back to updated when created is missing or malformed", () => {
      const older = olderSeriesMembers([
        member("a.md", "", { updated: "2026-01-08" }),
        member("b.md", "2026-01-01"),
        member("c.md", "not a date", { updated: "not a date" }),
      ]);
      expect([...older].sort()).toEqual(["b.md", "c.md"]);
    });

    it("still breaks the tie when no member has a usable date", () => {
      const older = olderSeriesMembers([
        member("a.md", "not a date", { updated: "not a date" }),
        member("b.md", "not a date", { updated: "not a date" }),
      ]);
      expect([...older]).toEqual(["a.md"]);
    });

    for (const status of ["deprecated", "superseded", "archived"]) {
      it(`passes over a ${status} member as newest, and keeps it out of the head`, () => {
        const older = olderSeriesMembers([
          member("a.md", "2026-01-01"),
          member("b.md", "2026-01-08"),
          member("c.md", "2026-01-15", { status }),
        ]);
        expect([...older].sort()).toEqual(["a.md", "c.md"]);
      });
    }

    it("lets a draft be the newest member", () => {
      const older = olderSeriesMembers([
        member("a.md", "2026-01-01"),
        member("b.md", "2026-01-08", { status: "draft" }),
      ]);
      expect([...older]).toEqual(["a.md"]);
    });

    it("treats a fully retired series as having no head", () => {
      const older = olderSeriesMembers([
        member("a.md", "2026-01-01", { status: "archived" }),
        member("b.md", "2026-01-08", { status: "archived" }),
      ]);
      expect([...older].sort()).toEqual(["a.md", "b.md"]);
    });
  });
});
