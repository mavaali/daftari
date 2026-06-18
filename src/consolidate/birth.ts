// Birth mode (spec §4.0, brief item 1). For an unprocessed doc, retrieve its
// top-K embedding neighbors and ask the LLM — with a foundational-ordering
// prompt, both docs' content loaded — whether it has a load-bearing derivation
// with each neighbor and which is the premise; emit edge_observe for survivors,
// log the full top-K + outcomes to the birth trace for post-hoc recall@K
// evaluation, and return the content hash so the caller can advance
// `consolidate-state.json`'s birth-processed map.
//
// Direction is elicited in BOTH orders per neighbor (option c, design §3.1
// amendment): agreement ⇒ a trusted directed edge; an explicit `symmetric` or
// an order-disagreement ⇒ a canonical-sorted *pending* edge (premiseVote
// "symmetric", direction-unconfirmed) plus an interpretive tension for human
// adjudication. The gate showed ambiguous real-prose pairs return a confident
// but order-dependent direction rather than `symmetric`, so both orders are
// required to catch that.
//
// One pass per neighbor — NOT a panel (the panel is revision-mode, §4.1).
// Birth seeds k=0 candidates; subsequent revision passes earn strength.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, posix } from "node:path";
import type { DerivesFromEdge, ObserveEdgeInput } from "../curation/edges.js";
import type { TensionInput } from "../curation/tension.js";
import type { LlmClient } from "../eval/llm.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { CONSOLIDATE_AGENT, type ConsolidatePromptTemplate } from "./constants.js";
import {
  DERIVATION_SYSTEM,
  DERIVATION_VERDICT_SCHEMA,
  type DerivationVerdict,
  derivationUserBody,
  parseDerivationVerdict,
} from "./derivation-prompt.js";

// --- public surface ----------------------------------------------------------

export interface BirthDeps {
  llm: LlmClient;
  // Returns vault-relative paths for the doc's top-K embedding neighbors.
  // The CLI wires this to `vaultSearchRelated`; tests stub it.
  searchNeighbors: (docPath: string, k: number) => Promise<Result<string[], Error>>;
  // Load a neighbor's content (vault-relative path) for the DOC B side of the
  // foundational-ordering prompt. Live wiring reads the in-process docs map (no
  // disk read); tests stub it. An error skips the neighbor (recorded in trace).
  loadNeighborContent: (path: string) => Promise<Result<string, Error>>;
  // Observe an edge. Live wiring calls `observeEdge(vaultRoot, input)`; the
  // shadow-mode wrapper (chunk 4) intercepts and writes to shadow-actions.jsonl
  // instead. Injecting this means birth.ts knows nothing about shadow.
  observe: (input: ObserveEdgeInput) => Promise<Result<DerivesFromEdge, Error>>;
  // Record a direction-pending tension (mutual or order-contested). Live wiring
  // calls `addTension(vaultRoot, ...)`; tests collect in memory.
  recordTension: (input: TensionInput) => Promise<Result<unknown, Error>>;
  // Append one trace row per birth-processed doc (top-K + verdicts). The CLI
  // wires this to `.daftari/birth-trace.jsonl`; tests collect rows in memory.
  recordBirthTrace: (row: BirthTraceRow) => Promise<Result<void, Error>>;
}

export interface BirthOpts {
  vaultRoot: string;
  agent: string;
  axis: ConsolidatePromptTemplate;
  // Max LLM calls this birth pass may make. Decremented by the caller across
  // docs; birth.ts itself just caps THIS doc's neighbor count by it. Each
  // neighbor now costs 2 calls (both orders, option c).
  budgetRemaining: number;
  model: string;
}

export interface BirthVerdict {
  neighbor: string;
  related: boolean;
  // Reconciled direction outcome for this neighbor.
  direction: "directed" | "symmetric" | "none";
  // Which doc is the load-bearing premise, when directed. null otherwise.
  premise: "doc" | "neighbor" | null;
  reason: string;
}

export interface BirthVerdictError {
  neighbor: string;
  error: string;
}

export interface BirthTraceRow {
  at: string;
  docPath: string;
  contentHash: string;
  // The FULL top-K from the embedding pass — recorded even if budget cut the
  // re-derivation pass short, so the recall@K evaluator (Stage 6) sees what
  // the embedding model returned, not the truncated subset we scored.
  topK: string[];
  axis: ConsolidatePromptTemplate;
  model: string;
  verdicts: Array<BirthVerdict | BirthVerdictError>;
}

export interface BirthOutcome {
  docPath: string;
  contentHash: string;
  neighbors: string[]; // the full top-K, canonicalized
  verdicts: Array<BirthVerdict | BirthVerdictError>;
  observations: Array<{ from: string; to: string }>;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  // The trace is load-bearing for the recall@K post-hoc evaluator (Stage 6 +
  // brief item 8 decorrelation report). Silent trace-write failure here means
  // the evaluation has no data — surface to the caller, which exits non-zero
  // when any trace write fails this session.
  traceWritten: boolean;
  traceError?: string;
}

// --- canonicalization --------------------------------------------------------

// Same canon() as src/consolidate/index.ts uses. Path-aliasing is the bug
// class that bit edge store + merge + Stage 1; every keyed boundary
// canonicalizes (memory: canonicalize-path-keys).
function canon(p: string): string {
  return posix.normalize(p).replace(/^\.\//, "");
}

// --- legacy parser (retained for decorrelation until Task 7) -----------------

// DEPRECATED: the derives/depends/neither token is replaced by the foundational
// ordering {related, premise} verdict (see derivation-prompt.ts). This parser
// is retained ONLY because src/consolidate/decorrelation.ts still imports it;
// Task 7 swaps decorrelation to the shared prompt and removes this.
const VALID_VERDICTS: ReadonlySet<string> = new Set(["derives", "depends", "neither"]);

export function parseBirthVerdict(
  raw: unknown,
): Result<{ verdict: "derives" | "depends" | "neither"; reason: string }, Error> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err(new Error("verdict: expected object"));
  }
  const obj = raw as Record<string, unknown>;
  const v = obj.verdict;
  const r = obj.reason;
  if (typeof v !== "string" || !VALID_VERDICTS.has(v)) {
    return err(
      new Error(`verdict: expected one of derives|depends|neither, got ${JSON.stringify(v)}`),
    );
  }
  if (typeof r !== "string" || r.trim().length === 0) {
    return err(new Error("verdict: 'reason' is required (and non-empty)"));
  }
  return ok({ verdict: v as "derives" | "depends" | "neither", reason: r });
}

// --- direction reconciliation (option c) -------------------------------------

export type ReconcileOutcome =
  | { kind: "unrelated" }
  | { kind: "directed"; premise: "doc" | "neighbor" }
  | { kind: "symmetric"; contested: boolean };

// Map an order-1 verdict (A=doc, B=neighbor) to a real-world premise.
function realWorldPremise1(v: DerivationVerdict): "doc" | "neighbor" | "symmetric" | "unrelated" {
  if (!v.related) return "unrelated";
  if (v.premise === "symmetric") return "symmetric";
  if (v.premise === "A") return "doc";
  if (v.premise === "B") return "neighbor";
  return "unrelated";
}

// Map an order-2 verdict (A=neighbor, B=doc) to a real-world premise.
function realWorldPremise2(v: DerivationVerdict): "doc" | "neighbor" | "symmetric" | "unrelated" {
  if (!v.related) return "unrelated";
  if (v.premise === "symmetric") return "symmetric";
  if (v.premise === "A") return "neighbor";
  if (v.premise === "B") return "doc";
  return "unrelated";
}

// Reconcile both orders into a single edge decision. Conservative on existence
// (either order saying "unrelated" ⇒ no edge); any explicit symmetric ⇒ pending;
// agreement on the premise ⇒ directed; disagreement (one says doc, the other
// neighbor) ⇒ pending-contested.
export function reconcileDirection(
  order1: DerivationVerdict,
  order2: DerivationVerdict,
): ReconcileOutcome {
  const r1 = realWorldPremise1(order1);
  const r2 = realWorldPremise2(order2);
  if (r1 === "unrelated" || r2 === "unrelated") return { kind: "unrelated" };
  if (r1 === "symmetric" || r2 === "symmetric") return { kind: "symmetric", contested: false };
  if (r1 === r2) return { kind: "directed", premise: r1 };
  return { kind: "symmetric", contested: true };
}

// --- prompt input bounding ---------------------------------------------------

// Truncate doc content for the prompt. Birth doesn't need the whole doc —
// the central claim is usually in the first ~1500 chars; a longer corpus
// is calibration noise + cost. Tunable from constants if needed.
const MAX_DOC_CHARS = 1500;
function truncate(s: string): string {
  return s.length <= MAX_DOC_CHARS ? s : `${s.slice(0, MAX_DOC_CHARS)}\n…[truncated]`;
}

// A non-empty one-line claim snippet for the tension record (addTension rejects
// empty claims). Falls back to the path when the content is blank.
function claimSnippet(content: string, fallback: string): string {
  const line = content.split("\n").find((l) => l.trim().length > 0);
  const snip = (line ?? "").trim().slice(0, 200);
  return snip.length > 0 ? snip : `(no readable content: ${fallback})`;
}

// --- birth pass --------------------------------------------------------------

export async function birthOne(
  doc: { relPath: string; content: string },
  deps: BirthDeps,
  opts: BirthOpts,
): Promise<Result<BirthOutcome, Error>> {
  const docPath = canon(doc.relPath);
  const contentHash = createHash("sha256").update(doc.content).digest("hex").slice(0, 16);
  const docContent = truncate(doc.content);

  const neighborsRes = await deps.searchNeighbors(docPath, 20);
  if (!neighborsRes.ok) return neighborsRes;
  const neighbors = neighborsRes.value.map(canon).filter((n) => n !== docPath);

  const verdicts: Array<BirthVerdict | BirthVerdictError> = [];
  const observations: Array<{ from: string; to: string }> = [];
  let llmCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const neighbor of neighbors) {
    // Each neighbor needs both orders; stop if we can't afford the pair.
    if (llmCalls + 2 > opts.budgetRemaining) break;

    const nc = await deps.loadNeighborContent(neighbor);
    if (!nc.ok) {
      verdicts.push({ neighbor, error: `load failed: ${nc.error.message}` });
      continue;
    }
    const neighborContent = truncate(nc.value);

    // Order 1: DOC A = this doc, DOC B = neighbor.
    const r1 = await deps.llm.completeJson({
      model: opts.model,
      system: DERIVATION_SYSTEM,
      user: derivationUserBody(docPath, docContent, neighbor, neighborContent),
      schema: DERIVATION_VERDICT_SCHEMA,
      temperature: 0,
    });
    llmCalls++;
    if (!r1.ok) {
      verdicts.push({ neighbor, error: r1.error.message });
      continue;
    }
    inputTokens += r1.value.input_tokens;
    outputTokens += r1.value.output_tokens;
    const p1 = parseDerivationVerdict(r1.value.parsed);
    if (!p1.ok) {
      verdicts.push({ neighbor, error: p1.error.message });
      continue;
    }

    // Order 2: DOC A = neighbor, DOC B = this doc.
    const r2 = await deps.llm.completeJson({
      model: opts.model,
      system: DERIVATION_SYSTEM,
      user: derivationUserBody(neighbor, neighborContent, docPath, docContent),
      schema: DERIVATION_VERDICT_SCHEMA,
      temperature: 0,
    });
    llmCalls++;
    if (!r2.ok) {
      verdicts.push({ neighbor, error: r2.error.message });
      continue;
    }
    inputTokens += r2.value.input_tokens;
    outputTokens += r2.value.output_tokens;
    const p2 = parseDerivationVerdict(r2.value.parsed);
    if (!p2.ok) {
      verdicts.push({ neighbor, error: p2.error.message });
      continue;
    }

    const outcome = reconcileDirection(p1.value, p2.value);
    const reason = p1.value.reason;

    if (outcome.kind === "unrelated") {
      verdicts.push({ neighbor, related: false, direction: "none", premise: null, reason });
      continue;
    }

    if (outcome.kind === "directed") {
      // Premise is materialized on `to` (clocks: from depends on to). doc-premise
      // ⇒ to=doc, from=neighbor; neighbor-premise ⇒ to=neighbor, from=doc.
      const [from, to] = outcome.premise === "doc" ? [neighbor, docPath] : [docPath, neighbor];
      verdicts.push({
        neighbor,
        related: true,
        direction: "directed",
        premise: outcome.premise,
        reason,
      });
      const obs = await deps.observe({
        fromPath: from,
        toPath: to,
        observedBy: opts.agent,
        blind: true,
        axis: "prompt",
        premiseVote: "to",
        note: `birth: ${reason}`,
      });
      if (!obs.ok) {
        verdicts.push({ neighbor, error: `observe failed: ${obs.error.message}` });
        continue;
      }
      observations.push({ from, to });
      continue;
    }

    // symmetric — a canonical-sorted pending edge (direction unconfirmed) so
    // re-observation lands on the same key, plus an interpretive tension.
    const [from, to] = [docPath, neighbor].sort();
    const which = outcome.contested ? "contested" : "mutual";
    verdicts.push({ neighbor, related: true, direction: "symmetric", premise: null, reason });
    const obs = await deps.observe({
      fromPath: from,
      toPath: to,
      observedBy: opts.agent,
      blind: true,
      axis: "prompt",
      premiseVote: "symmetric",
      note: `birth/symmetric(${which}): ${reason}`,
    });
    if (!obs.ok) {
      verdicts.push({ neighbor, error: `observe failed: ${obs.error.message}` });
      continue;
    }
    observations.push({ from, to });
    const tension = await deps.recordTension({
      title: `direction-pending (${which}): ${from} ↔ ${to}`,
      kind: "interpretive",
      sourceA: docPath,
      claimA: claimSnippet(doc.content, docPath),
      sourceB: neighbor,
      claimB: claimSnippet(nc.value, neighbor),
      loggedBy: opts.agent,
    });
    if (!tension.ok) {
      verdicts.push({ neighbor, error: `tension failed: ${tension.error.message}` });
    }
  }

  const traceRes = await deps.recordBirthTrace({
    at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    docPath,
    contentHash,
    topK: neighbors,
    axis: opts.axis,
    model: opts.model,
    verdicts,
  });

  return ok({
    docPath,
    contentHash,
    neighbors,
    verdicts,
    observations,
    llmCalls,
    inputTokens,
    outputTokens,
    traceWritten: traceRes.ok,
    ...(traceRes.ok ? {} : { traceError: traceRes.error.message }),
  });
}

// --- the CLI-wired trace recorder --------------------------------------------

export function birthTracePath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "birth-trace.jsonl");
}

export async function appendBirthTrace(
  vaultRoot: string,
  row: BirthTraceRow,
): Promise<Result<void, Error>> {
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    appendFileSync(birthTracePath(vaultRoot), `${JSON.stringify(row)}\n`);
    return ok(undefined);
  } catch (e) {
    return err(
      new Error(`cannot record birth trace: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
}

// Re-exported so the CLI doesn't have to import it from constants alone.
export { CONSOLIDATE_AGENT };
