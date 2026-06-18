// Axis-decorrelation report (brief item 8). Runs the v1 prompt-framing
// templates against a ground-truth-labeled fixture and asks: does the panel
// beat its best single axis? If not, the axes are decorative — multi-model
// must land inside Stage 2, not be deferred to Stage 5.
//
// THE FIXTURE IS THE GATE — not this code. This module ships the math + the
// CLI surface; the real ~50-pair hand-built fixture lives in
// tests/fixtures/decorrelation-fixture.json and is built in a separate
// session (see the chunk-6 handoff). Until it exists, the gate cannot fire
// meaningfully and the report is exercise-only.
//
// Verdict space: the fixture ground truth is the 3-class {derives, depends,
// neither} directional claim. The report now elicits with the SHARED
// foundational-ordering prompt birth runs (derivation-prompt.ts, closing F3) and
// maps its {related, premise} verdict onto that 3-class truth (+ a 4th
// "symmetric" vote that never matches a directional truth, so a fabricated
// mutual answer is correctly scored wrong).
//
// NOTE (axes are now redundant): the foundational prompt is order-agnostic and
// temperature-0 deterministic, so the three prompt-framing axes send an
// identical prompt and agree by construction — the report measures the
// foundational prompt's per-edge ACCURACY (spec §5), not prompt-framing
// decorrelation (which the verdict doc already found decorative). Collapsing the
// axes loop to a single judgment is a follow-up; the structure is retained here
// to keep the report/CLI surface stable.

import { readFileSync } from "node:fs";
import type { CompleteJsonResult, LlmClient } from "../eval/llm.js";
import type { CortexEvalError } from "../eval/types.js";
import { err, ok, type Result } from "../frontmatter/types.js";
// Import birth's reconciliation so the report measures EXACTLY what birth ships.
import { reconcileDirection } from "./birth.js";
import {
  CONSOLIDATE_DECORRELATION_MIN_LIFT,
  CONSOLIDATE_DIRECTION_MIN_ACCURACY,
  CONSOLIDATE_PROMPT_TEMPLATES,
  type ConsolidatePromptTemplate,
} from "./constants.js";
import {
  DERIVATION_SYSTEM,
  DERIVATION_VERDICT_SCHEMA,
  type DerivationVerdict,
  derivationUserBody,
  parseDerivationVerdict,
} from "./derivation-prompt.js";

// --- fixture shape -----------------------------------------------------------

export type FixtureTruth = "derives" | "depends" | "neither";

export interface DecorrelationFixtureEdge {
  id: string;
  fromPath: string;
  toPath: string;
  fromContent: string;
  toContent: string;
  truth: FixtureTruth;
  // Optional: §10.3 edge class label so the report can stratify accuracy across
  // forward-temporal vs backward-causal vs symmetric-re-examine.
  edgeClass?: "forward-temporal" | "backward-causal" | "symmetric";
  // Optional: human-written rationale for the truth label (kept so the report
  // can surface DISPUTED edges where the panel disagrees with the labeler —
  // those are the ones worth re-labeling).
  rationale?: string;
}

export interface DecorrelationFixture {
  version: 1;
  edges: DecorrelationFixtureEdge[];
}

// --- vote + result shapes ----------------------------------------------------

// A vote can be one of the 3 directional classes, "symmetric" (the model said
// neither doc is THE premise — never matches a directional truth), or "error".
export type VoteVerdict = FixtureTruth | "symmetric";

export interface DecorrelationVote {
  axis: ConsolidatePromptTemplate;
  verdict: VoteVerdict | "error";
  reason?: string;
}

export interface DecorrelationPerEdge {
  id: string;
  truth: FixtureTruth;
  votes: DecorrelationVote[];
  majorityVerdict: VoteVerdict | "tie" | "all-error";
  majorityCorrect: boolean;
}

export interface DecorrelationMetrics {
  // Per-axis accuracy: of the times this axis voted (not errored), how often
  // did it match truth?
  singleVoteAccuracy: Record<ConsolidatePromptTemplate, number>;
  // Majority-vote accuracy across the full fixture.
  majorityAccuracy: number;
  // Lift = majority − max(single). The gate's load-bearing number.
  liftOverBestSingle: number;
  // Inter-axis agreement: of fixture edges where ALL axes returned a verdict
  // (no errors), fraction where they all matched each other.
  axisAgreementRate: number;
  // Error correlation: of fixture edges where >=2 axes were WRONG (vs truth),
  // fraction where those wrong axes all returned the SAME wrong verdict.
  // High = the axes share a failure mode → not independent → kill condition
  // fires even if `lift` looks ok.
  errorCorrelation: number;
}

export interface DecorrelationReport {
  fixtureSize: number;
  fixtureSource: string;
  axes: readonly ConsolidatePromptTemplate[];
  model: string;
  metrics: DecorrelationMetrics;
  // PASS gate (spec §5): majorityAccuracy >= CONSOLIDATE_DIRECTION_MIN_ACCURACY.
  // `passes=true` means the foundational prompt recovers direction accurately
  // enough on the fixture; `false` means direction recovery is below the bar and
  // the elicitation/fixture needs work before any auto-write graduation. (Lift is
  // still reported but no longer gates — the axes are identical now.)
  passes: boolean;
  perEdge: DecorrelationPerEdge[];
  // Per-axis verdict counts (incl. errors) — for the report's narrative.
  axisCounts: Record<
    ConsolidatePromptTemplate,
    { correct: number; wrong: number; errored: number }
  >;
}

// --- fixture I/O -------------------------------------------------------------

export function parseFixture(raw: unknown): Result<DecorrelationFixture, Error> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err(new Error("fixture: expected an object with `version` and `edges`"));
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    return err(new Error(`fixture: unsupported version ${JSON.stringify(obj.version)}`));
  }
  if (!Array.isArray(obj.edges)) {
    return err(new Error("fixture: `edges` must be an array"));
  }
  const edges: DecorrelationFixtureEdge[] = [];
  for (let i = 0; i < obj.edges.length; i++) {
    const e = obj.edges[i] as Record<string, unknown>;
    if (
      typeof e.id !== "string" ||
      typeof e.fromPath !== "string" ||
      typeof e.toPath !== "string" ||
      typeof e.fromContent !== "string" ||
      typeof e.toContent !== "string" ||
      (e.truth !== "derives" && e.truth !== "depends" && e.truth !== "neither")
    ) {
      return err(
        new Error(
          `fixture: edge[${i}] malformed (need id, fromPath, toPath, fromContent, toContent, truth)`,
        ),
      );
    }
    edges.push({
      id: e.id,
      fromPath: e.fromPath,
      toPath: e.toPath,
      fromContent: e.fromContent,
      toContent: e.toContent,
      truth: e.truth,
      ...(typeof e.edgeClass === "string" &&
      (e.edgeClass === "forward-temporal" ||
        e.edgeClass === "backward-causal" ||
        e.edgeClass === "symmetric")
        ? { edgeClass: e.edgeClass }
        : {}),
      ...(typeof e.rationale === "string" ? { rationale: e.rationale } : {}),
    });
  }
  return ok({ version: 1, edges });
}

export function loadFixture(path: string): Result<DecorrelationFixture, Error> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    return err(
      new Error(`fixture: cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return err(new Error(`fixture: invalid JSON: ${e instanceof Error ? e.message : String(e)}`));
  }
  return parseFixture(parsed);
}

// --- prompt + verdict mapping (shared foundational prompt, closing F3) --------

const MAX_DOC_CHARS = 1500;
function truncate(s: string): string {
  return s.length <= MAX_DOC_CHARS ? s : `${s.slice(0, MAX_DOC_CHARS)}\n…[truncated]`;
}

// Map the foundational {related, premise} verdict onto the fixture's 3-class
// directional truth (DOC A = fromPath/fromContent, DOC B = toPath/toContent):
//   related:false        → neither
//   premise === "B"      → A derives from B            → "derives"
//   premise === "A"      → B derives from A            → "depends"
//   premise === "symmetric" → "symmetric" (never matches a directional truth)
export function mapDerivationToFixture(v: DerivationVerdict): VoteVerdict {
  if (!v.related) return "neither";
  if (v.premise === "symmetric") return "symmetric";
  return v.premise === "B" ? "derives" : "depends";
}

type Elicit = (
  aPath: string,
  aContent: string,
  bPath: string,
  bContent: string,
) => Promise<Result<CompleteJsonResult, CortexEvalError>>;

// Run BOTH presentation orders and reconcile via birth's reconcileDirection
// (doc=from, neighbor=to), then map to the 3-class fixture truth:
//   directed, premise=neighbor(to) → A derives from B            → "derives"
//   directed, premise=doc(from)    → B derives from A            → "depends"
//   symmetric / order-contested    → "symmetric" (no directional truth matches)
//   unrelated                      → "neither"
// Any LLM/parse failure in either order yields "error".
async function reconcileEdgeToFixture(
  edge: DecorrelationFixtureEdge,
  elicit: Elicit,
): Promise<{ verdict: VoteVerdict | "error"; reason?: string }> {
  // Order 1: DOC A = from, DOC B = to.
  const r1 = await elicit(edge.fromPath, edge.fromContent, edge.toPath, edge.toContent);
  if (!r1.ok) return { verdict: "error", reason: r1.error.message };
  const p1 = parseDerivationVerdict(r1.value.parsed);
  if (!p1.ok) return { verdict: "error", reason: p1.error.message };
  // Order 2: DOC A = to, DOC B = from.
  const r2 = await elicit(edge.toPath, edge.toContent, edge.fromPath, edge.fromContent);
  if (!r2.ok) return { verdict: "error", reason: r2.error.message };
  const p2 = parseDerivationVerdict(r2.value.parsed);
  if (!p2.ok) return { verdict: "error", reason: p2.error.message };

  const outcome = reconcileDirection(p1.value, p2.value);
  const reason = p1.value.reason;
  if (outcome.kind === "unrelated") return { verdict: "neither", reason };
  if (outcome.kind === "symmetric") return { verdict: "symmetric", reason };
  // directed: premise "neighbor" (=to) ⇒ derives; "doc" (=from) ⇒ depends.
  return { verdict: outcome.premise === "neighbor" ? "derives" : "depends", reason };
}

// --- runner ------------------------------------------------------------------

export interface DecorrelationRunDeps {
  llm: LlmClient;
}

export interface DecorrelationRunOpts {
  model: string;
  // Optional override of the axis set; defaults to ALL v1 templates (this is
  // the decorrelation report — the point is to see EVERY axis on EVERY edge,
  // not the M-vote subset the live revision panel uses).
  axes?: readonly ConsolidatePromptTemplate[];
  fixtureSource: string;
}

export async function runDecorrelation(
  fixture: DecorrelationFixture,
  deps: DecorrelationRunDeps,
  opts: DecorrelationRunOpts,
): Promise<Result<DecorrelationReport, Error>> {
  const axes = opts.axes ?? CONSOLIDATE_PROMPT_TEMPLATES;
  const perEdge: DecorrelationPerEdge[] = [];
  const axisCounts: Record<string, { correct: number; wrong: number; errored: number }> = {};
  for (const a of axes) axisCounts[a] = { correct: 0, wrong: 0, errored: 0 };

  // One foundational elicitation per (edge, order) at temp 0. Birth runs BOTH
  // orders and reconciles (option c), abstaining → symmetric on order-disagreement;
  // the report mirrors that EXACTLY via birth's reconcileDirection so its accuracy
  // is birth's trusted-directed rate, not a single-order upper bound (closes F3).
  const elicit = (aPath: string, aContent: string, bPath: string, bContent: string) =>
    deps.llm.completeJson({
      model: opts.model,
      system: DERIVATION_SYSTEM,
      user: derivationUserBody(aPath, truncate(aContent), bPath, truncate(bContent)),
      schema: DERIVATION_VERDICT_SCHEMA,
      temperature: 0,
    });

  for (const edge of fixture.edges) {
    // Reconcile ONCE per edge (the prompt-framing axes are identical under the
    // deterministic prompt), then emit the same vote for every axis so the
    // per-axis/majority/lift machinery is preserved.
    const verdict = await reconcileEdgeToFixture(edge, elicit);
    const votes: DecorrelationVote[] = axes.map((axis) => ({
      axis,
      verdict: verdict.verdict,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
    }));
    for (const axis of axes) {
      if (verdict.verdict === "error") axisCounts[axis].errored++;
      else if (verdict.verdict === edge.truth) axisCounts[axis].correct++;
      else axisCounts[axis].wrong++;
    }

    const majority = majorityVerdict(votes);
    perEdge.push({
      id: edge.id,
      truth: edge.truth,
      votes,
      majorityVerdict: majority,
      majorityCorrect: majority === edge.truth,
    });
  }

  const metrics = computeMetrics(perEdge, axes);
  return ok({
    fixtureSize: fixture.edges.length,
    fixtureSource: opts.fixtureSource,
    axes,
    model: opts.model,
    metrics,
    passes: metrics.majorityAccuracy >= CONSOLIDATE_DIRECTION_MIN_ACCURACY,
    perEdge,
    axisCounts: axisCounts as Record<
      ConsolidatePromptTemplate,
      { correct: number; wrong: number; errored: number }
    >,
  });
}

// --- math (exported for unit testing) ---------------------------------------

// Most common non-error verdict. Returns "tie" when the top two are tied (the
// panel can't decide), or "all-error" when every vote errored.
export function majorityVerdict(votes: DecorrelationVote[]): VoteVerdict | "tie" | "all-error" {
  const counts = new Map<VoteVerdict, number>();
  let nonErrors = 0;
  for (const v of votes) {
    if (v.verdict === "error") continue;
    counts.set(v.verdict, (counts.get(v.verdict) ?? 0) + 1);
    nonErrors++;
  }
  if (nonErrors === 0) return "all-error";
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return "tie";
  return sorted[0][0];
}

export function computeMetrics(
  perEdge: DecorrelationPerEdge[],
  axes: readonly ConsolidatePromptTemplate[],
): DecorrelationMetrics {
  const singleVoteAccuracy: Record<string, number> = {};
  for (const a of axes) {
    let correct = 0;
    let nonError = 0;
    for (const row of perEdge) {
      const v = row.votes.find((x) => x.axis === a);
      if (!v || v.verdict === "error") continue;
      nonError++;
      if (v.verdict === row.truth) correct++;
    }
    singleVoteAccuracy[a] = nonError === 0 ? 0 : correct / nonError;
  }

  const majCorrect = perEdge.filter((p) => p.majorityCorrect).length;
  const majorityAccuracy = perEdge.length === 0 ? 0 : majCorrect / perEdge.length;

  const bestSingle = Math.max(0, ...axes.map((a) => singleVoteAccuracy[a]));
  const liftOverBestSingle = majorityAccuracy - bestSingle;

  // Axis agreement: of rows where ALL axes returned a verdict, fraction where
  // all verdicts matched.
  let allVoted = 0;
  let allAgreed = 0;
  for (const row of perEdge) {
    const nonErr = row.votes.filter((v) => v.verdict !== "error");
    if (nonErr.length < axes.length) continue;
    allVoted++;
    const unique = new Set(nonErr.map((v) => v.verdict));
    if (unique.size === 1) allAgreed++;
  }
  const axisAgreementRate = allVoted === 0 ? 0 : allAgreed / allVoted;

  // Error correlation: of rows where >=2 axes were wrong, fraction where ALL
  // the wrong axes gave the SAME wrong verdict. High = the axes share a
  // failure mode (not independent), even if `lift` looked acceptable.
  let multiWrong = 0;
  let multiWrongAgreed = 0;
  for (const row of perEdge) {
    const wrong = row.votes.filter((v) => v.verdict !== "error" && v.verdict !== row.truth);
    if (wrong.length < 2) continue;
    multiWrong++;
    const uniqueWrong = new Set(wrong.map((v) => v.verdict));
    if (uniqueWrong.size === 1) multiWrongAgreed++;
  }
  const errorCorrelation = multiWrong === 0 ? 0 : multiWrongAgreed / multiWrong;

  return {
    singleVoteAccuracy: singleVoteAccuracy as Record<ConsolidatePromptTemplate, number>,
    majorityAccuracy,
    liftOverBestSingle,
    axisAgreementRate,
    errorCorrelation,
  };
}

// --- text report ------------------------------------------------------------

export function formatDecorrelationReport(report: DecorrelationReport): string {
  const lines: string[] = [];
  lines.push(`decorrelation report — fixture: ${report.fixtureSource}`);
  lines.push(
    `  size: ${report.fixtureSize} edges | axes: ${report.axes.join(", ")} | model: ${report.model}`,
  );
  lines.push(`  per-axis accuracy:`);
  for (const a of report.axes) {
    const c = report.axisCounts[a];
    lines.push(
      `    ${a}: ${(report.metrics.singleVoteAccuracy[a] * 100).toFixed(1)}%  (correct ${c.correct} / wrong ${c.wrong} / errored ${c.errored})`,
    );
  }
  lines.push(`  majority accuracy:  ${(report.metrics.majorityAccuracy * 100).toFixed(1)}%`);
  lines.push(
    `  lift over best single:  ${(report.metrics.liftOverBestSingle * 100).toFixed(2)} pp  (informational; min-lift ${(CONSOLIDATE_DECORRELATION_MIN_LIFT * 100).toFixed(1)} pp — axes identical under the foundational prompt)`,
  );
  lines.push(`  axis agreement rate: ${(report.metrics.axisAgreementRate * 100).toFixed(1)}%`);
  lines.push(`  error correlation:   ${(report.metrics.errorCorrelation * 100).toFixed(1)}%`);
  lines.push(
    `  VERDICT: ${report.passes ? "PASS — foundational prompt recovers direction" : "FAIL — direction recovery below the accuracy bar"}  (accuracy gate: >= ${(CONSOLIDATE_DIRECTION_MIN_ACCURACY * 100).toFixed(0)}%)`,
  );
  return `${lines.join("\n")}\n`;
}
