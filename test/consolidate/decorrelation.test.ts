// Decorrelation report math + fixture parsing (brief item 8).
// Toy 5-pair fixture exercises every code path. The REAL ~50-pair hand-built
// fixture lives in tests/fixtures/decorrelation-fixture.json and is the
// subject of a separate session (chunk-6 handoff).

import { describe, expect, it, vi } from "vitest";
import {
  computeMetrics,
  type DecorrelationFixture,
  type DecorrelationFixtureEdge,
  type DecorrelationPerEdge,
  formatDecorrelationReport,
  majorityVerdict,
  parseFixture,
  runDecorrelation,
} from "../../src/consolidate/decorrelation.js";
import type { LlmClient } from "../../src/eval/llm.js";
import { ok } from "../../src/frontmatter/types.js";

function toyFixture(): DecorrelationFixture {
  const make = (
    id: string,
    truth: "derives" | "depends" | "neither",
  ): DecorrelationFixtureEdge => ({
    id,
    fromPath: `${id}-from.md`,
    toPath: `${id}-to.md`,
    fromContent: `from-${id}`,
    toContent: `to-${id}`,
    truth,
  });
  return {
    version: 1,
    edges: [
      make("e1", "derives"),
      make("e2", "depends"),
      make("e3", "neither"),
      make("e4", "derives"),
      make("e5", "neither"),
    ],
  };
}

type FT = "derives" | "depends" | "neither";
// A foundational {related, premise} verdict that maps to the given fixture truth
// (derives ⇒ premise B; depends ⇒ premise A; neither ⇒ related:false).
function truthVerdict(truth: FT): { related: boolean; premise: string | null; reason: string } {
  if (truth === "neither") return { related: false, premise: null, reason: "neither" };
  return { related: true, premise: truth === "derives" ? "B" : "A", reason: truth };
}

// LLM that returns a verdict per (edgeId, axisIndex). The foundational prompt
// has no [template:] marker now (axes send identical prompts), so we recover the
// edgeId from "from-${id}" and the axis position from a per-edge call counter
// (axes run in CONSOLIDATE_PROMPT_TEMPLATES order: 0=forward, 1=reverse, 2=contrast).
function scriptedLlm(
  fn: (
    edgeId: string,
    axisIndex: number,
  ) => { related: boolean; premise: string | null; reason: string } | "ERROR",
): LlmClient {
  const counter = new Map<string, number>();
  return {
    complete: vi.fn(),
    completeJson: vi.fn(async (opts: { user: string }) => {
      const idM = opts.user.match(/from-(e\d+)/);
      if (!idM) throw new Error("scripted LLM: could not parse id from prompt");
      const id = idM[1];
      const idx = counter.get(id) ?? 0;
      counter.set(id, idx + 1);
      const spec = fn(id, idx);
      if (spec === "ERROR") {
        return {
          ok: false,
          error: { kind: "llm" as const, message: "scripted error", retryable: false },
        };
      }
      return ok({
        text: JSON.stringify(spec),
        parsed: spec,
        input_tokens: 10,
        output_tokens: 5,
        stop_reason: "end_turn",
      });
    }),
    completeWithTools: vi.fn(),
  };
}

describe("parseFixture", () => {
  it("accepts a well-formed fixture", () => {
    const r = parseFixture({
      version: 1,
      edges: [
        {
          id: "x",
          fromPath: "a.md",
          toPath: "b.md",
          fromContent: "x",
          toContent: "y",
          truth: "derives",
        },
      ],
    });
    expect(r.ok).toBe(true);
  });
  it("rejects unknown version", () => {
    expect(parseFixture({ version: 2, edges: [] }).ok).toBe(false);
  });
  it("rejects missing edges array", () => {
    expect(parseFixture({ version: 1 }).ok).toBe(false);
  });
  it("rejects an edge with bad truth", () => {
    const r = parseFixture({
      version: 1,
      edges: [
        { id: "x", fromPath: "a", toPath: "b", fromContent: "x", toContent: "y", truth: "maybe" },
      ],
    });
    expect(r.ok).toBe(false);
  });
  it("preserves edgeClass + rationale when present", () => {
    const r = parseFixture({
      version: 1,
      edges: [
        {
          id: "x",
          fromPath: "a",
          toPath: "b",
          fromContent: "x",
          toContent: "y",
          truth: "derives",
          edgeClass: "forward-temporal",
          rationale: "A explicitly cites B as the basis for its definition",
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.edges[0].edgeClass).toBe("forward-temporal");
    expect(r.value.edges[0].rationale).toContain("explicitly cites");
  });
});

describe("majorityVerdict", () => {
  it("returns the most common non-error verdict", () => {
    expect(
      majorityVerdict([
        { axis: "forward", verdict: "derives" },
        { axis: "reverse", verdict: "derives" },
        { axis: "contrast", verdict: "neither" },
      ]),
    ).toBe("derives");
  });
  it("returns 'tie' when top two are tied", () => {
    expect(
      majorityVerdict([
        { axis: "forward", verdict: "derives" },
        { axis: "reverse", verdict: "neither" },
      ]),
    ).toBe("tie");
  });
  it("returns 'all-error' when every vote errored", () => {
    expect(
      majorityVerdict([
        { axis: "forward", verdict: "error" },
        { axis: "reverse", verdict: "error" },
      ]),
    ).toBe("all-error");
  });
});

describe("computeMetrics", () => {
  // Helper: build a DecorrelationPerEdge from a verdict map.
  function perEdge(
    truth: "derives" | "depends" | "neither",
    votes: Record<"forward" | "reverse" | "contrast", "derives" | "depends" | "neither" | "error">,
  ): DecorrelationPerEdge {
    const voteArr = (["forward", "reverse", "contrast"] as const).map((axis) => ({
      axis,
      verdict: votes[axis],
    }));
    const maj = majorityVerdict(voteArr);
    return {
      id: "x",
      truth,
      votes: voteArr,
      majorityVerdict: maj,
      majorityCorrect: maj === truth,
    };
  }

  it("identity case: all axes always correct → singleAcc=1, majAcc=1, lift=0, errorCorrelation=0", () => {
    const rows = [
      perEdge("derives", { forward: "derives", reverse: "derives", contrast: "derives" }),
      perEdge("neither", { forward: "neither", reverse: "neither", contrast: "neither" }),
    ];
    const m = computeMetrics(rows, ["forward", "reverse", "contrast"]);
    expect(m.singleVoteAccuracy.forward).toBe(1);
    expect(m.majorityAccuracy).toBe(1);
    expect(m.liftOverBestSingle).toBe(0);
    expect(m.axisAgreementRate).toBe(1);
    expect(m.errorCorrelation).toBe(0);
  });

  it("wisdom-of-crowds case: each axis independently wrong sometimes, majority is right → lift > 0", () => {
    // 3 edges, each truth=derives. forward gets e1 wrong; reverse gets e2
    // wrong; contrast gets e3 wrong. Each single axis is 2/3. The majority of
    // the three on every edge is `derives` (the two right axes outvote the
    // wrong one) → majority is 3/3.
    const rows = [
      perEdge("derives", { forward: "neither", reverse: "derives", contrast: "derives" }),
      perEdge("derives", { forward: "derives", reverse: "neither", contrast: "derives" }),
      perEdge("derives", { forward: "derives", reverse: "derives", contrast: "neither" }),
    ];
    const m = computeMetrics(rows, ["forward", "reverse", "contrast"]);
    expect(m.singleVoteAccuracy.forward).toBeCloseTo(2 / 3);
    expect(m.majorityAccuracy).toBe(1);
    expect(m.liftOverBestSingle).toBeCloseTo(1 / 3);
  });

  it("correlated-failure case: all axes wrong together → singleAcc=0, majAcc=0, errorCorrelation=1", () => {
    const rows = [
      perEdge("derives", { forward: "neither", reverse: "neither", contrast: "neither" }),
      perEdge("derives", { forward: "neither", reverse: "neither", contrast: "neither" }),
    ];
    const m = computeMetrics(rows, ["forward", "reverse", "contrast"]);
    expect(m.singleVoteAccuracy.forward).toBe(0);
    expect(m.majorityAccuracy).toBe(0);
    expect(m.errorCorrelation).toBe(1); // every wrong axis gave the same wrong answer
  });

  it("uncorrelated-failure case: axes wrong in DIFFERENT directions → errorCorrelation < 1", () => {
    const rows = [
      perEdge("derives", { forward: "neither", reverse: "depends", contrast: "derives" }),
      perEdge("derives", { forward: "depends", reverse: "neither", contrast: "derives" }),
    ];
    const m = computeMetrics(rows, ["forward", "reverse", "contrast"]);
    // For each row, the two wrong axes disagree → errorCorrelation should be
    // 0 (no row has all wrong-axes giving the same wrong verdict).
    expect(m.errorCorrelation).toBe(0);
  });

  it("axis-agreement excludes rows where any axis errored (it's a quality-of-the-panel metric)", () => {
    const rows = [
      perEdge("derives", { forward: "derives", reverse: "derives", contrast: "derives" }),
      perEdge("derives", { forward: "derives", reverse: "derives", contrast: "error" }),
    ];
    const m = computeMetrics(rows, ["forward", "reverse", "contrast"]);
    // Only the first row has all-non-error votes → 1/1 = 1.
    expect(m.axisAgreementRate).toBe(1);
  });
});

describe("runDecorrelation — toy fixture, scripted LLM (foundational prompt)", () => {
  it("happy path: maps {related, premise} → fixture truth, majority correct", async () => {
    const fixture = toyFixture();
    const truthById = new Map(fixture.edges.map((e) => [e.id, e.truth]));
    const llm = scriptedLlm((id) => truthVerdict(truthById.get(id) as FT));
    const r = await runDecorrelation(fixture, { llm }, { model: "test", fixtureSource: "toy" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.fixtureSize).toBe(5);
    expect(r.value.metrics.majorityAccuracy).toBe(1);
    expect(r.value.passes).toBe(true); // gate is accuracy now (1.0 >= 0.85)
    expect(r.value.perEdge.every((p) => p.majorityCorrect)).toBe(true);
  });

  it("a fabricated 'symmetric' answer never matches a directional truth (scored wrong)", async () => {
    const fixture = toyFixture();
    // Always answer symmetric → maps to the "symmetric" vote, which equals no
    // 3-class truth → every directional edge is wrong.
    const llm = scriptedLlm(() => ({ related: true, premise: "symmetric", reason: "mutual" }));
    const r = await runDecorrelation(fixture, { llm }, { model: "test", fixtureSource: "toy" });
    if (!r.ok) throw r.error;
    // e1,e2,e4 are directional truths → wrong; e3,e5 are neither → also wrong.
    expect(r.value.metrics.majorityAccuracy).toBe(0);
    expect(r.value.perEdge.every((p) => p.majorityVerdict === "symmetric")).toBe(true);
  });

  it("kill condition fires: the prompt always gives the SAME wrong verdict → fail", async () => {
    const fixture = toyFixture();
    // Always related:false → "neither". Correct for e3/e5, wrong-same for the rest.
    const llm = scriptedLlm(() => ({ related: false, premise: null, reason: "x" }));
    const r = await runDecorrelation(fixture, { llm }, { model: "test", fixtureSource: "toy" });
    if (!r.ok) throw r.error;
    expect(r.value.metrics.errorCorrelation).toBeGreaterThan(0);
    expect(r.value.metrics.liftOverBestSingle).toBeLessThanOrEqual(0);
    expect(r.value.passes).toBe(false);
  });

  it("LLM errors are recorded as 'error' votes, not propagated as failure", async () => {
    const fixture = toyFixture();
    const truthById = new Map(fixture.edges.map((e) => [e.id, e.truth]));
    // axisIndex 0 = forward → error; the other two axes vote truth.
    const llm = scriptedLlm((id, idx) =>
      idx === 0 ? "ERROR" : truthVerdict(truthById.get(id) as FT),
    );
    const r = await runDecorrelation(fixture, { llm }, { model: "test", fixtureSource: "toy" });
    if (!r.ok) throw r.error;
    expect(r.value.axisCounts.forward.errored).toBe(5);
    expect(r.value.axisCounts.reverse.errored).toBe(0);
  });
});

describe("formatDecorrelationReport", () => {
  it("renders accuracy + lift + verdict", async () => {
    const fixture = toyFixture();
    const truthById = new Map(fixture.edges.map((e) => [e.id, e.truth]));
    const llm = scriptedLlm((id) => truthVerdict(truthById.get(id) as FT));
    const r = await runDecorrelation(
      fixture,
      { llm },
      { model: "test-model", fixtureSource: "toy" },
    );
    if (!r.ok) throw r.error;
    const text = formatDecorrelationReport(r.value);
    expect(text).toContain("decorrelation report");
    expect(text).toContain("test-model");
    expect(text).toContain("majority accuracy");
    expect(text).toContain("VERDICT:");
  });
});
