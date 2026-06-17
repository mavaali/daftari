// Birth mode (spec §4.0, brief item 1). For an unprocessed doc, retrieve its
// top-K embedding neighbors and ask the LLM which (if any) it derives from /
// depends on; emit edge_observe for survivors, log the full top-K + outcomes
// to the birth trace for post-hoc recall@K evaluation, and return the content
// hash so the caller can advance `consolidate-state.json`'s birth-processed
// map.
//
// One pass per neighbor — NOT a panel (the panel is revision-mode, §4.1).
// Birth seeds k=0 candidates; subsequent revision passes earn strength.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, posix } from "node:path";
import type { DerivesFromEdge, ObserveEdgeInput } from "../curation/edges.js";
import type { LlmClient } from "../eval/llm.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { CONSOLIDATE_AGENT, type ConsolidatePromptTemplate } from "./constants.js";

// --- public surface ----------------------------------------------------------

export interface BirthDeps {
  llm: LlmClient;
  // Returns vault-relative paths for the doc's top-K embedding neighbors.
  // The CLI wires this to `vaultSearchRelated`; tests stub it.
  searchNeighbors: (docPath: string, k: number) => Promise<Result<string[], Error>>;
  // Observe an edge. Live wiring calls `observeEdge(vaultRoot, input)`; the
  // shadow-mode wrapper (chunk 4) intercepts and writes to shadow-actions.jsonl
  // instead. Injecting this means birth.ts knows nothing about shadow.
  observe: (input: ObserveEdgeInput) => Promise<Result<DerivesFromEdge, Error>>;
  // Append one trace row per birth-processed doc (top-K + verdicts). The CLI
  // wires this to `.daftari/birth-trace.jsonl`; tests collect rows in memory.
  recordBirthTrace: (row: BirthTraceRow) => Promise<Result<void, Error>>;
}

export interface BirthOpts {
  vaultRoot: string;
  agent: string;
  axis: ConsolidatePromptTemplate;
  // Max LLM calls this birth pass may make. Decremented by the caller across
  // docs; birth.ts itself just caps THIS doc's neighbor count by it.
  budgetRemaining: number;
  model: string;
}

export interface BirthVerdict {
  neighbor: string;
  verdict: "derives" | "depends" | "neither";
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

// --- verdict parsing ---------------------------------------------------------

// The LLM is asked to return {verdict, reason}; this guards against silently
// accepting unknown verdicts that would poison the edge_observe call.
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

// --- prompt construction -----------------------------------------------------

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

function userBody(
  axis: ConsolidatePromptTemplate,
  docA: string,
  docAPath: string,
  docB: string,
  docBPath: string,
): string {
  const a = `DOC A (path: ${docAPath}):\n${truncate(docA)}`;
  const b = `DOC B (path: ${docBPath}):\n${truncate(docB)}`;
  switch (axis) {
    case "forward":
      return `${a}\n\n${b}\n\nDoes the central claim of DOC A derive from / depend on the central claim of DOC B? Return JSON.`;
    case "reverse":
      // Same question, asked from the other side: does B underlie A?
      return `${b}\n\n${a}\n\nDoes the central claim of DOC A depend on the central claim of DOC B as a load-bearing premise? Return JSON.`;
    case "contrast":
      return `${a}\n\n${b}\n\nWhat is the relationship between the central claims of DOC A and DOC B? If A derives from B, answer 'derives'. If B derives from A, answer 'depends'. Otherwise 'neither'. Return JSON.`;
  }
}

// Truncate doc content for the prompt. Birth doesn't need the whole doc —
// the central claim is usually in the first ~1500 chars; a longer corpus
// is calibration noise + cost. Tunable from constants if needed.
const MAX_DOC_CHARS = 1500;
function truncate(s: string): string {
  return s.length <= MAX_DOC_CHARS ? s : `${s.slice(0, MAX_DOC_CHARS)}\n…[truncated]`;
}

// --- birth pass --------------------------------------------------------------

export async function birthOne(
  doc: { relPath: string; content: string },
  deps: BirthDeps,
  opts: BirthOpts,
): Promise<Result<BirthOutcome, Error>> {
  const docPath = canon(doc.relPath);
  const contentHash = createHash("sha256").update(doc.content).digest("hex").slice(0, 16);

  const neighborsRes = await deps.searchNeighbors(docPath, 20);
  if (!neighborsRes.ok) return neighborsRes;
  const neighbors = neighborsRes.value.map(canon).filter((n) => n !== docPath);

  const verdicts: Array<BirthVerdict | BirthVerdictError> = [];
  const observations: Array<{ from: string; to: string }> = [];
  let llmCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const neighbor of neighbors) {
    if (llmCalls >= opts.budgetRemaining) break;

    // We don't have the neighbor's content here — the caller has docs map, but
    // birth passes through one doc at a time. For v1 we pass the neighbor path
    // only; the LLM evaluates structural plausibility from titles + the path's
    // own semantic signal. Loading neighbor contents inflates cost ~20× per
    // doc (one re-read per neighbor) and is the obvious calibration knob.
    // Tracked: load on demand when shadow data shows path-only verdicts
    // disagree with content-loaded verdicts on the decorrelation fixture.
    const r = await deps.llm.completeJson({
      model: opts.model,
      system: SYSTEM_BASE,
      user: userBody(opts.axis, doc.content, docPath, "", neighbor),
      schema: VERDICT_SCHEMA,
    });
    llmCalls++;
    if (!r.ok) {
      verdicts.push({ neighbor, error: r.error.message });
      continue;
    }
    inputTokens += r.value.input_tokens;
    outputTokens += r.value.output_tokens;

    const parsed = parseBirthVerdict(r.value.parsed);
    if (!parsed.ok) {
      verdicts.push({ neighbor, error: parsed.error.message });
      continue;
    }
    verdicts.push({ neighbor, verdict: parsed.value.verdict, reason: parsed.value.reason });

    if (parsed.value.verdict === "neither") continue;

    const [from, to] =
      parsed.value.verdict === "derives" ? [docPath, neighbor] : [neighbor, docPath];
    const obs = await deps.observe({
      fromPath: from,
      toPath: to,
      observedBy: opts.agent,
      blind: true,
      axis: "prompt",
      note: `birth/${opts.axis}: ${parsed.value.reason}`,
    });
    if (!obs.ok) {
      // Don't fail the pass — surface in the trace, move on.
      verdicts.push({ neighbor, error: `observe failed: ${obs.error.message}` });
      continue;
    }
    observations.push({ from, to });
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
