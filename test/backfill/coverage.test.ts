import { describe, expect, it } from "vitest";
import { projectCoverage } from "../../src/backfill/coverage.js";
import type { PlanEntry } from "../../src/backfill/types.js";
import type { Frontmatter } from "../../src/frontmatter/types.js";

const validProposed: Frontmatter = {
  title: "T",
  domain: "accumulation",
  collection: "specs",
  status: "canonical",
  confidence: "medium",
  created: "2026-01-01",
  updated: "2026-01-01",
  updated_by: "human:x",
  provenance: "direct",
  sources: [],
  superseded_by: null,
  ttl_days: null,
  tags: [],
  questions_answered: [],
  questions_raised: [],
};

function entry(over: Partial<Frontmatter>, collisions: PlanEntry["collisions"] = []): PlanEntry {
  return {
    path: "specs/x.md",
    current: {},
    proposed: { ...validProposed, ...over },
    derivation: {},
    scope: "specs",
    collisions,
  };
}

describe("projectCoverage", () => {
  it("buckets clean / collision / other and sums to planned", () => {
    const clean = entry({});
    const collision = entry({ status: "ACTIVE" as unknown as Frontmatter["status"] }, [
      { field: "status", value: "ACTIVE", expected: ["draft", "canonical"] },
    ]);
    const other = entry({ created: "not-a-date" });
    const cov = projectCoverage([clean, collision, other]);
    expect(cov).toEqual({ planned: 3, willCatalog: 1, blockedByCollision: 1, blockedByOther: 1 });
  });

  it("counts a doc with both a collision and another fault once, under collision", () => {
    const both = entry(
      { status: "ACTIVE" as unknown as Frontmatter["status"], created: "not-a-date" },
      [{ field: "status", value: "ACTIVE", expected: ["draft", "canonical"] }],
    );
    const cov = projectCoverage([both]);
    expect(cov).toEqual({ planned: 1, willCatalog: 0, blockedByCollision: 1, blockedByOther: 0 });
  });
});
