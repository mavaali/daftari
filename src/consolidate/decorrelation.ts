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
// Verdict space: birth-mode {derives, depends, neither}. We deliberately use
// the birth surface (not revision's {survives, fails}) because the fixture's
// ground truth IS a directional derivation claim — the natural match.

import { readFileSync } from "node:fs";
import type { LlmClient } from "../eval/llm.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { parseBirthVerdict } from "./birth.js";
import {
  CONSOLIDATE_DECORRELATION_MIN_LIFT,
  CONSOLIDATE_PROMPT_TEMPLATES,
  type ConsolidatePromptTemplate,
} from "./constants.js";

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

export interface DecorrelationVote {
  axis: ConsolidatePromptTemplate;
  verdict: FixtureTruth | "error";
  reason?: string;
}

export interface DecorrelationPerEdge {
  id: string;
  truth: FixtureTruth;
  votes: DecorrelationVote[];
  majorityVerdict: FixtureTruth | "tie" | "all-error";
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
  // Kill condition: liftOverBestSingle >= CONSOLIDATE_DECORRELATION_MIN_LIFT.
  // `passes=true` means the prompt-framing axis is doing real work and
  // multi-model can stay deferred. `false` means multi-model must land
  // INSIDE Stage 2 before any auto-write graduation.
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

// --- prompts (shared with birth — the verdict space matches) ----------------

const VERDICT_SCHEMA = {
  type: "object",
  required: ["verdict", "reason"],
  properties: {
    verdict: { enum: ["derives", "depends", "neither"] },
    reason: { type: "string", minLength: 1 },
  },
} as const;

const SYSTEM_BASE =
  "You evaluate whether one document's central claim derives from another's. " +
  "A 'derivation' means the first claim depends on the second as a load-bearing premise — " +
  "not a passing reference, not a citation, not a co-occurrence. " +
  "Be conservative: when the dependence is shallow or ambiguous, return 'neither'.";

const MAX_DOC_CHARS = 1500;
function truncate(s: string): string {
  return s.length <= MAX_DOC_CHARS ? s : `${s.slice(0, MAX_DOC_CHARS)}\n…[truncated]`;
}

function userBody(
  axis: ConsolidatePromptTemplate,
  fromPath: string,
  fromContent: string,
  toPath: string,
  toContent: string,
): string {
  const tag = `[template:${axis}]`;
  const a = `${tag}\nDOC A (path: ${fromPath}):\n${truncate(fromContent)}`;
  const b = `DOC B (path: ${toPath}):\n${truncate(toContent)}`;
  switch (axis) {
    case "forward":
      return `${a}\n\n${b}\n\nDoes the central claim of DOC A derive from / depend on the central claim of DOC B? Return JSON.`;
    case "reverse":
      return `${tag}\n${b}\n\n${a}\n\nDoes the central claim of DOC A depend on the central claim of DOC B as a load-bearing premise? Return JSON.`;
    case "contrast":
      return `${a}\n\n${b}\n\nWhat is the relationship between the central claims of DOC A and DOC B? If A derives from B, answer 'derives'. If B derives from A, answer 'depends'. Otherwise 'neither'. Return JSON.`;
  }
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

  for (const edge of fixture.edges) {
    const votes: DecorrelationVote[] = [];
    for (const axis of axes) {
      const r = await deps.llm.completeJson({
        model: opts.model,
        system: SYSTEM_BASE,
        user: userBody(axis, edge.fromPath, edge.fromContent, edge.toPath, edge.toContent),
        schema: VERDICT_SCHEMA,
      });
      if (!r.ok) {
        votes.push({ axis, verdict: "error", reason: r.error.message });
        axisCounts[axis].errored++;
        continue;
      }
      const parsed = parseBirthVerdict(r.value.parsed);
      if (!parsed.ok) {
        votes.push({ axis, verdict: "error", reason: parsed.error.message });
        axisCounts[axis].errored++;
        continue;
      }
      votes.push({ axis, verdict: parsed.value.verdict, reason: parsed.value.reason });
      if (parsed.value.verdict === edge.truth) axisCounts[axis].correct++;
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
    passes: metrics.liftOverBestSingle >= CONSOLIDATE_DECORRELATION_MIN_LIFT,
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
export function majorityVerdict(votes: DecorrelationVote[]): FixtureTruth | "tie" | "all-error" {
  const counts = new Map<FixtureTruth, number>();
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
    `  lift over best single:  ${(report.metrics.liftOverBestSingle * 100).toFixed(2)} pp  (kill condition: >= ${(CONSOLIDATE_DECORRELATION_MIN_LIFT * 100).toFixed(1)} pp)`,
  );
  lines.push(`  axis agreement rate: ${(report.metrics.axisAgreementRate * 100).toFixed(1)}%`);
  lines.push(`  error correlation:   ${(report.metrics.errorCorrelation * 100).toFixed(1)}%`);
  lines.push(
    `  VERDICT: ${report.passes ? "PASS — prompt-framing axes are doing real work" : "FAIL — multi-model must land inside Stage 2"}`,
  );
  return `${lines.join("\n")}\n`;
}
