import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ageInDays,
  computeStaleness,
  listStaleFiles,
} from "../../src/curation/staleness.js";

const LINT_VAULT = resolve("test/fixtures/lint-vault");
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

  describe("listStaleFiles", () => {
    it("reports only documents at or past their TTL by default", async () => {
      const result = await listStaleFiles(LINT_VAULT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.map((f) => f.path)).toEqual(["stale-doc.md"]);
      expect(result.value[0]?.staleness.expired).toBe(true);
    });

    it("returns every document, most stale first, at threshold 0", async () => {
      const result = await listStaleFiles(LINT_VAULT, 0);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(6);
      expect(result.value[0]?.path).toBe("stale-doc.md");
    });
  });
});
