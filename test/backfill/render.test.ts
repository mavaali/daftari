import { describe, expect, it } from "vitest";
import type { ApplyResult } from "../../src/backfill/apply.js";
import { renderApplyResult, renderSummary } from "../../src/backfill/index.js";
import type { BackfillSummary } from "../../src/backfill/types.js";

describe("renderSummary", () => {
  it("prints per-scope coverage and a collisions section", () => {
    const summary: BackfillSummary = {
      missing: 0,
      partial: 1,
      conformant: 0,
      rootSkipped: 0,
      byScope: { decisions: 1 },
      planned: 1,
      coverage: {
        decisions: { planned: 1, willCatalog: 0, blockedByCollision: 1, blockedByOther: 0 },
      },
      collisions: [
        {
          path: "decisions/d.md",
          field: "status",
          value: "ACTIVE",
          expected: ["draft", "canonical"],
        },
      ],
    };
    const out = renderSummary(summary, "/v/.daftari/backfill-plan.jsonl");
    expect(out).toContain("will catalog");
    expect(out).toContain("blocked by collisions");
    expect(out).toContain("Field-name collisions (1)");
    expect(out).toContain("decisions/d.md");
    expect(out).toContain("status: ACTIVE");
  });
});

describe("renderApplyResult", () => {
  it("prints an actual-coverage line (cataloged = applied + unchanged)", () => {
    const r: ApplyResult = {
      scope: "decisions",
      applied: ["decisions/a.md"],
      unchanged: [],
      skipped: [{ path: "decisions/b.md", reason: "collision: ..." }],
      commit: "abc1234",
    };
    const out = renderApplyResult(r);
    expect(out).toContain("cataloged 1 of 2");
    expect(out).toContain("1 skipped");
    expect(out).toContain("decisions/b.md");
  });
});
