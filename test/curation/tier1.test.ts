import { describe, expect, it } from "vitest";
import type { ConsumesEdge } from "../../src/curation/consumes.js";
import type { ProvenanceEntry } from "../../src/curation/provenance.js";
import {
  changedFieldsFromProvenance,
  contentChangedFields,
  tier1Dispatch,
  tier1Summary,
} from "../../src/curation/tier1.js";

function compiledEdge(artifact: string, fields: string[] = ["*"]): ConsumesEdge {
  return {
    artifact,
    unit: "a/unit.md",
    edge_type: "whole-doc-read",
    fields,
    run_id: "run-1",
    compile_ts: "2026-07-01T00:00:00.000Z",
  };
}

describe("tier1 dispatch (#232)", () => {
  it("a bookkeeping-only change is unaffected across every class", () => {
    const verdicts = tier1Dispatch({
      unit: "a/unit.md",
      changedFields: ["updated", "updated_by"],
      compiled: [compiledEdge("a/compiled.md")],
      declaredDependents: ["a/declared.md"],
      earnedDependents: ["a/earned.md"],
    });
    expect(verdicts.every((v) => v.verdict === "unaffected")).toBe(true);
    expect(tier1Summary(verdicts).resolved_at_tier1).toBe(true);
  });

  it("class-bounded verdicts: compiled decides, declared claims, earned routes", () => {
    const verdicts = tier1Dispatch({
      unit: "a/unit.md",
      changedFields: ["body"],
      compiled: [compiledEdge("a/compiled.md")],
      declaredDependents: ["a/declared.md"],
      earnedDependents: ["a/earned.md"],
    });
    const byArtifact = new Map(verdicts.map((v) => [v.artifact, v]));
    expect(byArtifact.get("a/compiled.md")?.verdict).toBe("affected");
    expect(byArtifact.get("a/declared.md")?.verdict).toBe("possibly-affected");
    expect(byArtifact.get("a/earned.md")?.verdict).toBe("semantic-review");

    const summary = tier1Summary(verdicts);
    expect(summary).toEqual({
      unaffected: 0,
      affected: 1,
      possibly_affected: 1,
      semantic_review: 1,
      resolved_at_tier1: false,
    });
  });

  it("field-scoped compiled edges license the certain skip (#232's core case)", () => {
    // The dependent consumed only `formula`; only `description` changed.
    const skip = tier1Dispatch({
      unit: "a/unit.md",
      changedFields: ["description"],
      compiled: [compiledEdge("a/uses-formula.md", ["formula"])],
      declaredDependents: [],
      earnedDependents: [],
    });
    expect(skip[0]?.verdict).toBe("unaffected");
    expect(skip[0]?.reason).toContain("formula");

    const hit = tier1Dispatch({
      unit: "a/unit.md",
      changedFields: ["formula", "description"],
      compiled: [compiledEdge("a/uses-formula.md", ["formula"])],
      declaredDependents: [],
      earnedDependents: [],
    });
    expect(hit[0]?.verdict).toBe("affected");
  });

  it("an artifact reachable via several classes keeps the highest-certainty verdict", () => {
    const verdicts = tier1Dispatch({
      unit: "a/unit.md",
      changedFields: ["description"],
      compiled: [compiledEdge("a/dep.md", ["formula"])], // certain skip
      declaredDependents: ["a/dep.md"], // would be possibly-affected
      earnedDependents: ["a/dep.md"], // would be semantic-review
    });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.verdict).toBe("unaffected");
    expect(verdicts[0]?.edge_class).toBe("compiled");
    expect(tier1Summary(verdicts).resolved_at_tier1).toBe(true);
  });

  it("contentChangedFields dedupes and strips bookkeeping", () => {
    expect(contentChangedFields(["updated", "tags", "tags", "body", "updated_by"])).toEqual([
      "tags",
      "body",
    ]);
  });

  it("changedFieldsFromProvenance joins the frontmatter diff and the body flag", () => {
    const entry = (over: Partial<ProvenanceEntry>): ProvenanceEntry => ({
      timestamp: "2026-07-17T00:00:00.000Z",
      tool: "vault_write",
      file: "a/unit.md",
      agent: "agent:x",
      action: "update",
      ...over,
    });

    expect(
      changedFieldsFromProvenance(
        entry({
          frontmatter_diff: {
            tags: { before: [], after: ["x"] },
            updated: { before: "a", after: "b" },
          },
          body_changed: false,
        }),
      ),
    ).toEqual(["tags"]);

    expect(
      changedFieldsFromProvenance(entry({ body_changed: true, frontmatter_diff: {} })),
    ).toEqual(["body"]);

    // A legacy entry without the flag over-approximates: a content write's
    // body counts as changed rather than silently skipped.
    expect(changedFieldsFromProvenance(entry({}))).toEqual(["body"]);
    // ...but a frontmatter-only lifecycle action does not.
    expect(
      changedFieldsFromProvenance(
        entry({
          action: "promote",
          frontmatter_diff: { status: { before: "draft", after: "canonical" } },
        }),
      ),
    ).toEqual(["status"]);
  });
});
