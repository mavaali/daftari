// Revision mode (spec §4.1, brief item 2). Cast a panel of M independent votes
// on a due edge — each vote uses a distinct prompt template so §11.3's replay
// guard counts them all as independent in one sitting. Each vote either
// survives (→ edge_observe, strength accrues) or fails-case-2 (→ edge_contest,
// revoke + tension). The §11.3 replay guard handles "same (observer, axis)
// pair within EDGE_REPLAY_GAP_DAYS"; this code uses distinct axes within the
// panel so the gap never trips.
//
// Case-1 vs case-2 simplification (v1): the LLM is asked to produce
// survives | fails — we treat every "fails" as case-2 (contest). The spec
// distinguishes case-1 (an endpoint *changed*, so failure isn't a fault of the
// derivation) but C's event clock already marks such edges due via git-diff;
// running the panel on them is the same retry path. If shadow data shows we're
// contesting edges whose endpoints had recent commits, add a case-1 detector
// (`git log --since=<lastRederived>` on each endpoint) and skip the contest.
// Tracked for Stage 5 calibration.

import { appendFileSync, mkdirSync } from "node:fs";
import { join, posix } from "node:path";
import {
  type ContestEdgeInput,
  type DerivesFromEdge,
  EDGE_AXES,
  type ObserveEdgeInput,
} from "../curation/edges.js";
import type { LlmClient } from "../eval/llm.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { CONSOLIDATE_PROMPT_TEMPLATES, type ConsolidatePromptTemplate } from "./constants.js";
import type { Admit, EnvelopeVerdict } from "./envelope.js";

// --- public surface ----------------------------------------------------------

export interface RevisionDeps {
  llm: LlmClient;
  // Load a doc's content for a re-derivation prompt. CLI wires `loadDocuments`;
  // tests stub it (avoids fs + frontmatter parsing in the unit).
  loadDoc: (path: string) => Promise<Result<{ path: string; content: string }, Error>>;
  // Consult the two-gate envelope ONCE per panel decision (per the aggregated
  // contest or observe-loop), BEFORE any write. On refuse the decision becomes
  // "gated" and nothing is written. Live wiring is the CLI's makeAdmit.
  admit: Admit;
  observe: (input: ObserveEdgeInput) => Promise<Result<DerivesFromEdge, Error>>;
  contest: (input: ContestEdgeInput) => Promise<Result<DerivesFromEdge, Error>>;
  recordRevisionTrace: (row: RevisionTraceRow) => Promise<Result<void, Error>>;
}

export interface RevisionOpts {
  vaultRoot: string;
  agent: string;
  panelSize: number;
  budgetRemaining: number;
  model: string;
}

export interface RevisionVote {
  axis: ConsolidatePromptTemplate;
  verdict: "survives" | "fails";
  reason: string;
}

export interface RevisionVoteError {
  axis: ConsolidatePromptTemplate;
  error: string;
}

// The panel's aggregated decision (majority-decides). "tie" and "no-vote" apply
// no write — they surface for human attention instead of churning edge state.
// "gated" means a majority WAS reached (survives/fails) but the envelope refused
// the write — the vote stands in the trace, but nothing was applied.
export type RevisionDecision = "survives" | "fails" | "tie" | "no-vote" | "gated";

export interface RevisionTraceRow {
  at: string;
  fromPath: string;
  toPath: string;
  edgeStrengthAtStart: number;
  kSurvivedAtStart: number;
  lastRederivedAtStart: string;
  model: string;
  votes: Array<RevisionVote | RevisionVoteError>;
  // The aggregated decision + how many writes it produced — so the recall@K
  // evaluator reads what the store actually honored, not raw vote counts.
  decision: RevisionDecision;
  observedCount: number;
  contestedCount: number;
  // When decision === "gated": which gate refused + its reason (mirrors
  // EnvelopeVerdict). Absent otherwise.
  gate?: "invariants" | "budget" | null;
  gateReason?: string;
}

export interface RevisionOutcome {
  fromPath: string;
  toPath: string;
  votes: Array<RevisionVote | RevisionVoteError>;
  decision: RevisionDecision;
  observedCount: number;
  contestedCount: number;
  // Populated when decision === "gated": the envelope refused the write.
  gate?: "invariants" | "budget" | null;
  gateReason?: string;
  // Vote landed but the downstream write (observe / contest) failed. The vote
  // itself is valid (the LLM said what it said); the durable record didn't
  // land. Separated from `votes` so the trace doesn't carry a phantom vote
  // entry for the same axis on top of the genuine one.
  writeErrors: Array<{ axis: ConsolidatePromptTemplate; error: string }>;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  traceWritten: boolean;
  traceError?: string;
}

// --- canon -------------------------------------------------------------------

function canon(p: string): string {
  return posix.normalize(p).replace(/^\.\//, "");
}

// Defensive wrapper around the injected admit (same rationale as birth.ts): the
// live makeAdmit does I/O and can throw; a thrown admit must NOT crash the panel
// (losing the votes + trace). Fail closed — a throw is a refusal on invariants.
async function safeAdmit(
  admit: Admit,
  action: { action: "edge-observe" | "edge-contest"; fromPath: string; toPath: string },
): Promise<EnvelopeVerdict> {
  try {
    return await admit(action);
  } catch (e) {
    return {
      admit: false,
      gate: "invariants",
      reason: `admit threw: ${e instanceof Error ? e.message : String(e)}`,
      impact: 0,
    };
  }
}

// --- verdict parsing ---------------------------------------------------------

const VALID_REVISION_VERDICTS: ReadonlySet<string> = new Set(["survives", "fails"]);

export function parseRevisionVerdict(
  raw: unknown,
): Result<{ verdict: "survives" | "fails"; reason: string }, Error> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err(new Error("revision verdict: expected object"));
  }
  const obj = raw as Record<string, unknown>;
  const v = obj.verdict;
  const r = obj.reason;
  if (typeof v !== "string" || !VALID_REVISION_VERDICTS.has(v)) {
    return err(
      new Error(`revision verdict: expected 'survives' | 'fails', got ${JSON.stringify(v)}`),
    );
  }
  if (typeof r !== "string" || r.trim().length === 0) {
    return err(new Error("revision verdict: 'reason' is required"));
  }
  return ok({ verdict: v as "survives" | "fails", reason: r });
}

// --- prompt construction -----------------------------------------------------

const VERDICT_SCHEMA = {
  type: "object",
  required: ["verdict", "reason"],
  properties: {
    verdict: { enum: ["survives", "fails"] },
    reason: { type: "string", minLength: 1 },
  },
} as const;

const SYSTEM_BASE =
  "You re-evaluate whether one document's central claim still derives from another. " +
  "You have re-derived this edge before — your job is to do it independently now, " +
  "from the documents alone. Be conservative: only return 'survives' if the dependence is " +
  "clear and load-bearing in the current text. Return 'fails' if the premise no longer " +
  "supports the conclusion as previously claimed.";

const MAX_DOC_CHARS = 1500;
function truncate(s: string): string {
  return s.length <= MAX_DOC_CHARS ? s : `${s.slice(0, MAX_DOC_CHARS)}\n…[truncated]`;
}

// User body. The leading `[template:NAME]` marker is the post-hoc audit hook —
// it's how the trace + the decorrelation report (brief item 8) reconstruct
// which template each vote used without parsing prose. Tests rely on it too.
function userBody(
  axis: ConsolidatePromptTemplate,
  from: string,
  fromContent: string,
  to: string,
  toContent: string,
  edge: { kSurvived: number; lastRederived: string },
): string {
  const tag = `[template:${axis}]`;
  const meta = `Edge: ${from} derives_from ${to}. k_survived=${edge.kSurvived}, last_rederived=${edge.lastRederived}.`;
  const fromBlock = `DOC FROM (${from}):\n${truncate(fromContent)}`;
  const toBlock = `DOC TO (${to}):\n${truncate(toContent)}`;
  switch (axis) {
    case "forward":
      return `${tag}\n${meta}\n\n${fromBlock}\n\n${toBlock}\n\nDoes DOC FROM still derive its central claim from DOC TO? Return JSON.`;
    case "reverse":
      return `${tag}\n${meta}\n\n${toBlock}\n\n${fromBlock}\n\nIs DOC FROM's central claim still load-bearing on DOC TO? Return JSON.`;
    case "contrast":
      return `${tag}\n${meta}\n\n${fromBlock}\n\n${toBlock}\n\nIf you had to defend or refute the edge "FROM derives_from TO" today, which would you do? Return JSON: 'survives' to defend, 'fails' to refute.`;
  }
}

// --- panel -------------------------------------------------------------------

// Pick the first N distinct prompt templates so M votes get M distinct
// (observer, axis) pairs. Validated by the constants test: panelSize cannot
// exceed CONSOLIDATE_PROMPT_TEMPLATES.length. We still defend at runtime in
// case a caller passes a runaway value.
function axesForPanel(panelSize: number): ConsolidatePromptTemplate[] {
  const k = Math.max(1, Math.min(panelSize, CONSOLIDATE_PROMPT_TEMPLATES.length));
  return CONSOLIDATE_PROMPT_TEMPLATES.slice(0, k);
}

export async function revisionPanel(
  edge: {
    fromPath: string;
    toPath: string;
    strength: number;
    kSurvived: number;
    lastRederived: string;
  },
  deps: RevisionDeps,
  opts: RevisionOpts,
): Promise<Result<RevisionOutcome, Error>> {
  const fromPath = canon(edge.fromPath);
  const toPath = canon(edge.toPath);

  const fromRes = await deps.loadDoc(fromPath);
  if (!fromRes.ok) return fromRes;
  const toRes = await deps.loadDoc(toPath);
  if (!toRes.ok) return toRes;

  const axes = axesForPanel(opts.panelSize);
  const votes: Array<RevisionVote | RevisionVoteError> = [];
  const writeErrors: Array<{ axis: ConsolidatePromptTemplate; error: string }> = [];
  let llmCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  // --- Phase 1: ELICIT all M votes (no writes). Aggregation must see the whole
  // panel before deciding — applying writes per-vote let a single dissent revoke
  // a healthy edge and a later survive re-seed it (order-dependent churn). ---
  const surviving: Array<{ axis: ConsolidatePromptTemplate; reason: string }> = [];
  let failsCount = 0;
  let firstFailReason = "re-derivation failed";
  for (const axis of axes) {
    if (llmCalls >= opts.budgetRemaining) break;
    const r = await deps.llm.completeJson({
      model: opts.model,
      system: SYSTEM_BASE,
      user: userBody(axis, fromPath, fromRes.value.content, toPath, toRes.value.content, edge),
      schema: VERDICT_SCHEMA,
    });
    llmCalls++;
    if (!r.ok) {
      votes.push({ axis, error: r.error.message });
      continue;
    }
    inputTokens += r.value.input_tokens;
    outputTokens += r.value.output_tokens;
    const parsed = parseRevisionVerdict(r.value.parsed);
    if (!parsed.ok) {
      votes.push({ axis, error: parsed.error.message });
      continue;
    }
    votes.push({ axis, verdict: parsed.value.verdict, reason: parsed.value.reason });
    if (parsed.value.verdict === "survives") {
      surviving.push({ axis, reason: parsed.value.reason });
    } else {
      if (failsCount === 0) firstFailReason = parsed.value.reason;
      failsCount++;
    }
  }

  // --- Phase 2: AGGREGATE, then apply ONE decision (majority-decides). ---
  const survivesCount = surviving.length;
  let decision: RevisionDecision;
  let observedCount = 0;
  let contestedCount = 0;
  let gate: "invariants" | "budget" | null | undefined;
  let gateReason: string | undefined;

  if (survivesCount === 0 && failsCount === 0) {
    decision = "no-vote"; // all errored / budget-starved — surface, write nothing
  } else if (failsCount > survivesCount) {
    // Majority fails ⇒ ONE contest (revoke + tension). Satisfies the spec's
    // multi-pass-agreement-for-contests: a lone dissent can no longer revoke.
    // Consult the envelope ONCE for this panel decision (not per vote) before
    // writing; on refuse the decision is gated and nothing is contested.
    const verdict = await safeAdmit(deps.admit, { action: "edge-contest", fromPath, toPath });
    if (!verdict.admit) {
      decision = "gated";
      gate = verdict.gate;
      gateReason = verdict.reason;
    } else {
      decision = "fails";
      const con = await deps.contest({
        fromPath,
        toPath,
        contestedBy: opts.agent,
        reason: `revision panel (${failsCount}/${survivesCount + failsCount} fail): ${firstFailReason}`,
      });
      if (con.ok) contestedCount = 1;
      else writeErrors.push({ axis: axes[0], error: `contest failed: ${con.error.message}` });
    }
  } else if (survivesCount > failsCount) {
    // Majority survives ⇒ accrue strength: each surviving vote observes with a
    // DISTINCT store axis (EDGE_AXES), so the §11.3 replay guard counts them as
    // independent in one sitting (panelSize ≤ EDGE_AXES.length ⇒ no collision).
    // Consult the envelope ONCE for this panel decision (the per-vote observe
    // loop is the mechanical accrual of the ONE admitted action); on refuse the
    // decision is gated and NO observes are applied.
    const verdict = await safeAdmit(deps.admit, { action: "edge-observe", fromPath, toPath });
    if (!verdict.admit) {
      decision = "gated";
      gate = verdict.gate;
      gateReason = verdict.reason;
      surviving.length = 0; // ensure the loop below applies nothing
    } else {
      decision = "survives";
      for (let i = 0; i < surviving.length; i++) {
        const storeAxis = EDGE_AXES[i % EDGE_AXES.length];
        const obs = await deps.observe({
          fromPath,
          toPath,
          observedBy: opts.agent,
          blind: true,
          axis: storeAxis,
          note: `revision/${surviving[i].axis}: ${surviving[i].reason}`,
        });
        if (obs.ok) observedCount++;
        else
          writeErrors.push({
            axis: surviving[i].axis,
            error: `observe failed: ${obs.error.message}`,
          });
      }
    }
  } else {
    // Tie (survives === fails, both > 0): no majority ⇒ surface, write nothing.
    decision = "tie";
  }

  const traceRes = await deps.recordRevisionTrace({
    at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    fromPath,
    toPath,
    edgeStrengthAtStart: edge.strength,
    kSurvivedAtStart: edge.kSurvived,
    lastRederivedAtStart: edge.lastRederived,
    model: opts.model,
    votes,
    decision,
    observedCount,
    contestedCount,
    ...(decision === "gated" ? { gate, gateReason } : {}),
  });

  return ok({
    fromPath,
    toPath,
    votes,
    decision,
    observedCount,
    contestedCount,
    ...(decision === "gated" ? { gate, gateReason } : {}),
    writeErrors,
    llmCalls,
    inputTokens,
    outputTokens,
    traceWritten: traceRes.ok,
    ...(traceRes.ok ? {} : { traceError: traceRes.error.message }),
  });
}

// --- the CLI-wired trace recorder --------------------------------------------

export function revisionTracePath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "revision-trace.jsonl");
}

export async function appendRevisionTrace(
  vaultRoot: string,
  row: RevisionTraceRow,
): Promise<Result<void, Error>> {
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    appendFileSync(revisionTracePath(vaultRoot), `${JSON.stringify(row)}\n`);
    return ok(undefined);
  } catch (e) {
    return err(
      new Error(`cannot record revision trace: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
}
