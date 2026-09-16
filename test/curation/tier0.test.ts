import { describe, expect, it } from "vitest";
import { tier0DeprecateGate, tier0Findings, tier0PromoteGate } from "../../src/curation/tier0.js";
import type { LoadedDoc } from "../../src/curation/vault-docs.js";
import type { Frontmatter, ValidationIssue } from "../../src/frontmatter/types.js";

// Constructs a LoadedDoc inline — tier0 is pure over the loaded doc set, so
// no filesystem fixtures are needed for the unit-level cases.
function doc(
  path: string,
  over: Partial<Frontmatter> = {},
  issues: ValidationIssue[] = [],
): LoadedDoc {
  const frontmatter: Frontmatter = {
    title: path,
    domain: "accumulation",
    collection: path.split("/")[0] ?? "docs",
    status: "canonical",
    confidence: "high",
    created: "2026-01-01",
    updated: "2026-05-01",
    updated_by: "human:test",
    provenance: "direct",
    tier: null,
    sources: [],
    superseded_by: null,
    ttl_days: null,
    tags: [],
    describes: [],
    questions_answered: [],
    questions_raised: [],
    positions: null,
    org_position: null,
    contested: null,
    ...over,
  };
  return {
    path,
    frontmatter,
    content: `# ${path}\n`,
    validation: { valid: issues.length === 0, issues },
  };
}

describe("tier0Findings", () => {
  it("does not flag a canonical doc citing a superseded source (forwarding exists)", () => {
    const docs = [
      doc("a/old.md", { status: "superseded", superseded_by: "a/new.md" }),
      doc("a/new.md"),
      doc("a/reader.md", { sources: ["a/old.md"] }),
    ];
    const t0 = tier0Findings(docs);
    expect(t0.lifecycleConflicts).toEqual([]);
    expect(t0.brokenSourceRefs).toEqual([]);
  });

  it("flags canonical docs citing deprecated and archived sources", () => {
    const docs = [
      doc("a/dead.md", { status: "deprecated" }),
      doc("a/cold.md", { status: "archived" }),
      doc("a/reader.md", { sources: ["a/dead.md", "a/cold.md"] }),
    ];
    const t0 = tier0Findings(docs);
    expect(t0.lifecycleConflicts).toHaveLength(1);
    expect(t0.lifecycleConflicts[0]?.path).toBe("a/reader.md");
    expect(t0.lifecycleConflicts[0]?.detail).toContain("a/dead.md (deprecated)");
    expect(t0.lifecycleConflicts[0]?.detail).toContain("a/cold.md (archived)");
  });

  it("only holds canonical dependents to the lifecycle rule", () => {
    const docs = [
      doc("a/wip.md", { status: "draft" }),
      doc("a/other-wip.md", { status: "draft", sources: ["a/wip.md"] }),
    ];
    expect(tier0Findings(docs).lifecycleConflicts).toEqual([]);
  });

  it("flags a superseded_by pointing nowhere", () => {
    const docs = [doc("a/old.md", { status: "superseded", superseded_by: "a/gone.md" })];
    const t0 = tier0Findings(docs);
    expect(t0.brokenSourceRefs).toHaveLength(1);
    expect(t0.brokenSourceRefs[0]?.detail).toContain("superseded_by: a/gone.md");
  });

  it("resolves bare-basename sources before judging them", () => {
    const docs = [doc("a/base.md"), doc("b/reader.md", { sources: ["base"] })];
    const t0 = tier0Findings(docs);
    expect(t0.brokenSourceRefs).toEqual([]);
    expect(t0.lifecycleConflicts).toEqual([]);
  });

  it("flags an explicit vault source whose target vanished despite a same-basename survivor", () => {
    const docs = [doc("b/foo.md"), doc("readers/consumer.md", { sources: ["vault:a/foo.md"] })];
    const t0 = tier0Findings(docs);
    expect(t0.brokenSourceRefs).toEqual([
      {
        path: "readers/consumer.md",
        detail: "unresolvable reference(s): vault:a/foo.md",
      },
    ]);
  });

  it("does not treat repository, web, distill, or unresolved legacy citations as vault deps", () => {
    const docs = [
      doc("sketches/idea.md", { status: "draft", domain: "generative" }),
      doc("readers/consumer.md", {
        sources: [
          "repo:sketches/idea.md",
          "https://example.com/evidence",
          "distill:source-1#claim-2",
          "opaque/slash-shaped-citation",
        ],
      }),
    ];
    const findings = tier0Findings(docs);
    expect(findings.brokenSourceRefs).toEqual([]);
    expect(findings.lifecycleConflicts).toEqual([]);
    expect(findings.domainLeaks).toEqual([]);
  });
});

describe("domainLeaks (#4)", () => {
  it("flags an accumulation doc citing a generative source", () => {
    const findings = tier0Findings([
      doc("canon/settled.md", { sources: ["sketches/idea.md"] }),
      doc("sketches/idea.md", { domain: "generative", status: "draft" }),
    ]);
    expect(findings.domainLeaks.map((f) => f.path)).toEqual(["canon/settled.md"]);
    expect(findings.domainLeaks[0]?.detail).toContain("sketches/idea.md");
  });

  it("does not flag generative-to-generative or accumulation-to-accumulation citations", () => {
    const findings = tier0Findings([
      doc("sketches/a.md", { domain: "generative", status: "draft", sources: ["sketches/b.md"] }),
      doc("sketches/b.md", { domain: "generative", status: "draft" }),
      doc("canon/x.md", { sources: ["canon/y.md"] }),
      doc("canon/y.md"),
    ]);
    expect(findings.domainLeaks).toEqual([]);
  });

  it("holds non-canonical accumulation docs to the boundary too", () => {
    // Unlike lifecycleConflicts (canonical-only), the epistemic boundary
    // applies to the whole accumulation domain — a draft in canon must not
    // cite sketches either.
    const findings = tier0Findings([
      doc("canon/wip.md", { status: "draft", sources: ["sketches/idea.md"] }),
      doc("sketches/idea.md", { domain: "generative", status: "draft" }),
    ]);
    expect(findings.domainLeaks.map((f) => f.path)).toEqual(["canon/wip.md"]);
  });
});

describe("tier0PromoteGate", () => {
  it("passes a clean target", () => {
    const docs = [
      doc("a/base.md"),
      doc("a/target.md", { status: "draft", sources: ["a/base.md"] }),
    ];
    expect(tier0PromoteGate(docs, "a/target.md")).toEqual({
      violations: [],
      hiddenConflicts: 0,
    });
  });

  it("names a draft source as a violation (post-state check)", () => {
    const docs = [
      doc("a/wip.md", { status: "draft" }),
      doc("a/target.md", { status: "draft", sources: ["a/wip.md"] }),
    ];
    const gate = tier0PromoteGate(docs, "a/target.md");
    expect(gate.violations).toEqual(["source a/wip.md is draft"]);
  });

  it("counts a conflict on an unreadable source as hidden instead of naming it", () => {
    const docs = [
      doc("intel/wip.md", { status: "draft" }),
      doc("pricing/target.md", { status: "draft", sources: ["intel/wip.md"] }),
    ];
    const gate = tier0PromoteGate(
      docs,
      "pricing/target.md",
      (d) => d.frontmatter.collection === "pricing",
    );
    expect(gate.violations).toEqual([]);
    expect(gate.hiddenConflicts).toBe(1);
  });

  it("flags an unresolvable explicit vault source and a schema-invalid target", () => {
    const docs = [
      doc("a/target.md", { status: "draft", sources: ["vault:a/gone.md"] }, [
        { field: "ttl_days", message: "expected number or null, got string" },
      ]),
    ];
    const gate = tier0PromoteGate(docs, "a/target.md");
    expect(gate.violations.some((v) => v.includes("unresolvable source: vault:a/gone.md"))).toBe(
      true,
    );
    expect(gate.violations.some((v) => v.includes("schema-invalid"))).toBe(true);
  });

  it("returns no violations for a missing target (dispatch reports that)", () => {
    expect(tier0PromoteGate([], "a/ghost.md")).toEqual({ violations: [], hiddenConflicts: 0 });
  });

  it("allows repository, distill, and opaque citations through ratification", () => {
    const docs = [
      doc("a/target.md", {
        status: "draft",
        sources: [
          "repo:docs/evidence.md",
          "distill:session-42#claim-7",
          "opaque/slash-shaped-citation",
        ],
      }),
    ];
    expect(tier0PromoteGate(docs, "a/target.md")).toEqual({
      violations: [],
      hiddenConflicts: 0,
    });
  });
});

describe("tier0DeprecateGate", () => {
  it("finds canonical dependents via the sources channel, ignoring drafts", () => {
    const docs = [
      doc("a/lib.md"),
      doc("a/user.md", { sources: ["a/lib.md"] }),
      doc("a/wip.md", { status: "draft", sources: ["a/lib.md"] }),
    ];
    const gate = tier0DeprecateGate(docs, "a/lib.md");
    expect(gate.dependents).toEqual(["a/user.md"]);
    expect(gate.hiddenDependents).toBe(0);
  });

  it("splits dependents into nameable and hidden under a visibility predicate", () => {
    const docs = [
      doc("pricing/lib.md"),
      doc("pricing/user.md", { sources: ["pricing/lib.md"] }),
      doc("intel/user.md", { sources: ["pricing/lib.md"] }),
    ];
    const gate = tier0DeprecateGate(
      docs,
      "pricing/lib.md",
      (d) => d.frontmatter.collection === "pricing",
    );
    expect(gate.dependents).toEqual(["pricing/user.md"]);
    expect(gate.hiddenDependents).toBe(1);
  });

  it("recognizes explicit vault refs but ignores same-shaped repository refs", () => {
    const docs = [
      doc("a/lib.md"),
      doc("a/vault-user.md", { sources: ["vault:a/lib.md"] }),
      doc("a/repo-user.md", { sources: ["repo:a/lib.md"] }),
    ];
    expect(tier0DeprecateGate(docs, "a/lib.md").dependents).toEqual(["a/vault-user.md"]);
  });
});
