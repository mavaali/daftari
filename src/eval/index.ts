// src/eval/index.ts
// Top-level CLI dispatcher for `daftari eval`. Parses flags, routes to
// generate/run/score/top-level, translates Result<T, CortexEvalError> to exit
// codes (2 = config, 3 = runtime/llm).

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";
import { generateQuestions } from "./generate.js";
import { createAnthropicClient, type LlmClient } from "./llm.js";
import { createOpenRouterClient, resolveTransport } from "./llm-openrouter.js";
import { PROMPT_VERSION } from "./prompts.js";
import { type DirPruneResult, type PruneRules, parseOlderThan, prune } from "./prune.js";
import { runAnswerer } from "./run.js";
import { aggregateScore, gradeAnswer } from "./score.js";
import {
  appendHistory,
  readQuestionSet,
  readResults,
  resultsExists,
  writeQuestionSet,
  writeResults,
  writeScore,
} from "./storage.js";
import { sampleSubgraph } from "./subgraph.js";
import {
  type EvalRun,
  type Grade,
  type HistoryEntry,
  SPEC_VERSION,
  TIERS,
  type Trace,
} from "./types.js";

const HELP = `daftari eval — cortex quality metric.

Usage:
  daftari eval [--vault <path>] [--n <count>] [--k <count>] [--seed <str>] [--max-nodes <count>] [--transport <t>]
  daftari eval generate [--vault <path>] [--n <count>] [--seed <str>] [--max-nodes <count>] [--transport <t>]
  daftari eval run      [--questions <id>] [--vault <path>] [--model <id>] [--k <count>] [--resume <results-id>] [--transport <t>]
  daftari eval score    [--results <id>] [--vault <path>] [--grader-model <id>] [--transport <t>]
  daftari eval prune    [--vault <path>] [--keep <count>] [--older-than <age>] [--dry-run]

  (--questions and --results take the artifact id printed by a prior stage,
   not a file path; artifacts live under .daftari/eval/.)

Defaults:
  --n 15         total questions across three tiers (5 each)
  --k 2          runs per question for variance estimation
  --model        claude-sonnet-4-6 (DEFAULT_MODEL in src/eval/index.ts);
                 anthropic/claude-sonnet-4.6 under --transport openrouter
  --vault        current working directory
  --max-nodes 5  subgraph size cap for question generation
  --transport    anthropic (default, ANTHROPIC_API_KEY) or openrouter
                 (OPENROUTER_API_KEY); env fallback DAFTARI_LLM_TRANSPORT —
                 the same selection rules as daftari sleep/consolidate

Environment:
  ANTHROPIC_API_KEY    required for LLM-mediated stages on the anthropic transport
  OPENROUTER_API_KEY   required for LLM-mediated stages on the openrouter transport

Disk usage:
  .daftari/eval/results/ and scores/ grow without bound across runs. Use
  daftari eval prune to reclaim space: --keep <count> retains the N most
  recent artifacts per directory, --older-than <age> (30d, 12h) retains
  anything younger, and a file survives if EITHER given rule retains it.
  At least one rule is required; --dry-run lists deletions without acting.
  history.json and questions/ are never touched. Selection is by file
  mtime. Prune needs no API key.

Exit codes:
  0 — eval completed
  2 — config error (missing API key, bad flags, no vault)
  3 — runtime/LLM error (retries exhausted, vault I/O failure)
`;

export async function runEval(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  // runEval is the CLI boundary and must not throw: a bad integer flag
  // (intFlag) or any unexpected error becomes a config-error exit code (2).
  try {
    const [mode, ...rest] = argv;
    switch (mode) {
      case "generate":
        return await runGenerate(rest);
      case "run":
        return await runRun(rest);
      case "score":
        return await runScore(rest);
      case "prune":
        return runPrune(rest);
      default:
        return await runTopLevel(argv);
    }
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}
function intFlag(argv: string[], name: string, def: number): number {
  const v = flag(argv, name);
  if (v === undefined) return def;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`--${name} must be an integer`);
  return n;
}

// --max-nodes (#102): subgraph size cap, default 5 (the v1 hardcode). The
// throw lands in runEval's catch → config exit 2, like any bad flag.
function maxNodesFlag(argv: string[]): number {
  const n = intFlag(argv, "max-nodes", 5);
  if (n <= 0) throw new Error("--max-nodes must be a positive integer");
  return n;
}

// Persists an artifact, translating a throw into the RUNTIME exit code.
// Storage writes run after config validation succeeded: a failure here is
// disk-full/permissions (#102), and letting it bubble to runEval's catch-all
// would mislabel it as a config error (2). Returns 0 on success so callers
// can `if (code) return code;`.
async function persistOrRuntimeExit(what: string, op: () => Promise<void>): Promise<number> {
  try {
    await op();
    return 0;
  } catch (e) {
    process.stderr.write(
      `failed to write ${what}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 3;
  }
}

function vaultHash(vault: string): string {
  return createHash("sha256").update(resolve(vault)).digest("hex").slice(0, 12);
}

function defaultSeed(vault: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${vaultHash(vault)}-${today}`;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
// OpenRouter slug of the same judge — mirrors sleep's
// TENSION_SCAN_DEFAULT_MODEL / TENSION_SCAN_DEFAULT_MODEL_OPENROUTER pairing.
const DEFAULT_MODEL_OPENROUTER = "anthropic/claude-sonnet-4.6";

// Shared transport gate for every LLM-mediated stage: resolve --transport
// (env fallback DAFTARI_LLM_TRANSPORT, anthropic default — same rules as
// `daftari sleep`), require the matching key, construct the matching client.
// Any failure here is a config error (exit 2) at the caller.
interface EvalLlm {
  client: LlmClient;
  defaultModel: string;
  // Kept so the one-shot flow can forward the resolved transport to the
  // score stage it invokes in-process.
  transport: "anthropic" | "openrouter";
}

function resolveEvalLlm(argv: string[]): Result<EvalLlm, Error> {
  const transportRes = resolveTransport(flag(argv, "transport"));
  if (!transportRes.ok) return transportRes;
  const transport = transportRes.value;
  const keyVar = transport === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY";
  if (!process.env[keyVar]) return err(new Error(`${keyVar} required`));
  try {
    return ok({
      client: transport === "openrouter" ? createOpenRouterClient() : createAnthropicClient(),
      defaultModel: transport === "openrouter" ? DEFAULT_MODEL_OPENROUTER : DEFAULT_MODEL,
      transport,
    });
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

async function runGenerate(argv: string[]): Promise<number> {
  const llm = resolveEvalLlm(argv);
  if (!llm.ok) {
    process.stderr.write(`${llm.error.message}\n`);
    return 2;
  }
  const vault = flag(argv, "vault") ?? process.cwd();
  const n = intFlag(argv, "n", 15);
  const seed = flag(argv, "seed") ?? defaultSeed(vault);
  const maxNodes = maxNodesFlag(argv);

  const sg = await sampleSubgraph(vault, seed, { maxNodes });
  if (!sg.ok) {
    process.stderr.write(`${sg.error.message}\n`);
    return 3;
  }
  const qs = await generateQuestions(sg.value, llm.value.client, {
    n,
    model: llm.value.defaultModel,
    vaultHash: vaultHash(vault),
    seed,
  });
  if (!qs.ok) {
    process.stderr.write(`${qs.error.message}\n`);
    return 3;
  }
  qs.value.timestamp = new Date().toISOString();
  qs.value.id = `${qs.value.vault_hash}-${qs.value.seed}-${qs.value.timestamp}`;
  const wrote = await persistOrRuntimeExit("question set", () => writeQuestionSet(vault, qs.value));
  if (wrote) return wrote;
  process.stdout.write(
    `wrote question set ${qs.value.id} (${qs.value.questions.length} questions)\n`,
  );
  return 0;
}

async function runRun(argv: string[]): Promise<number> {
  const llm = resolveEvalLlm(argv);
  if (!llm.ok) {
    process.stderr.write(`${llm.error.message}\n`);
    return 2;
  }
  const vault = flag(argv, "vault") ?? process.cwd();
  const questionsId = flag(argv, "questions");
  if (!questionsId) {
    process.stderr.write("--questions required\n");
    return 2;
  }
  const k = intFlag(argv, "k", 2);
  const model = flag(argv, "model") ?? llm.value.defaultModel;

  const qsRead = await readQuestionSet(vault, questionsId);
  if (!qsRead.ok) {
    process.stderr.write(`${qsRead.error.message}\n`);
    return 3;
  }

  let resumeFrom: EvalRun | undefined;
  const resumeId = flag(argv, "resume");
  if (resumeId) {
    // A NONEXISTENT --resume id is a config error (#102): silently starting
    // a FRESH run would discard the partial work the caller was explicitly
    // trying to continue. A read failure on a file that EXISTS (corruption
    // from a crashed write, permissions) is a runtime error like every other
    // artifact-read failure here — readResults flattens both to one kind, so
    // existence is checked separately.
    if (!resultsExists(vault, resumeId)) {
      process.stderr.write(`--resume ${resumeId}: no such results id\n`);
      return 2;
    }
    const r = await readResults(vault, resumeId);
    if (!r.ok) {
      process.stderr.write(`--resume ${resumeId}: ${r.error.message}\n`);
      return 3;
    }
    resumeFrom = r.value;
  }

  // Mint the stable id + timestamp up front so the on-disk file path is stable
  // across the run and any later --resume; persist incrementally so a mid-run
  // failure leaves a resumable partial file.
  const timestamp = new Date().toISOString();
  const runId = resumeFrom ? resumeFrom.id : `${qsRead.value.id}-${model}-${timestamp}`;
  const run = await runAnswerer(qsRead.value, vault, llm.value.client, {
    k,
    model,
    resumeFrom,
    runId,
    timestamp,
    persist: makeBestEffortPersist(vault),
  });
  if (!run.ok) {
    process.stderr.write(`${run.error.message}\n`);
    process.stderr.write(
      `partial results saved as ${runId}; resume with: daftari eval run --questions ${questionsId} --resume ${runId}\n`,
    );
    return 3;
  }
  // Final write (covers the zero-question edge where persist never fired).
  const wrote = await persistOrRuntimeExit("results", () => writeResults(vault, run.value));
  if (wrote) return wrote;
  process.stdout.write(`wrote results ${run.value.id}\n`);
  return 0;
}

// Mid-run incremental persistence is best-effort: a transient write failure
// must not abort a healthy run (the final write reports failures with the
// runtime exit code). Warns once PER RUN — the flag lives in the closure, not
// at module scope, so an in-process re-invocation of runEval warns afresh.
function makeBestEffortPersist(vault: string): (r: EvalRun) => Promise<void> {
  let warned = false;
  return async (r: EvalRun) => {
    try {
      await writeResults(vault, r);
    } catch (e) {
      if (!warned) {
        warned = true;
        process.stderr.write(
          `warning: incremental results write failed (will retry at end): ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
  };
}

async function runScore(argv: string[]): Promise<number> {
  const vault = flag(argv, "vault") ?? process.cwd();
  const resultsId = flag(argv, "results");
  if (!resultsId) {
    process.stderr.write("--results required\n");
    return 2;
  }
  const llm = resolveEvalLlm(argv);
  if (!llm.ok) {
    process.stderr.write(`${llm.error.message}\n`);
    return 2;
  }
  const graderModel = flag(argv, "grader-model") ?? llm.value.defaultModel;

  const runRead = await readResults(vault, resultsId);
  if (!runRead.ok) {
    process.stderr.write(`${runRead.error.message}\n`);
    return 3;
  }
  const run = runRead.value;
  const qsRead = await readQuestionSet(vault, run.questions_id);
  if (!qsRead.ok) {
    process.stderr.write(`${qsRead.error.message}\n`);
    return 3;
  }
  const qs = qsRead.value;

  const grader = llm.value.client;
  const grades: Grade[] = [];
  const traces = new Map<string, Trace>();
  // Dropped-run accounting (#102): a run can fall out of the score because it
  // never completed, because grading failed, or because it was NEVER
  // ATTEMPTED — a process killed between two incremental persists leaves no
  // entry at all for the remaining (question, k) pairs, so the denominator
  // must be the PLANNED grid, not whatever happens to be in the file. All
  // three buckets are counted and reported, so a thin score cannot be
  // mistaken for a complete one.
  const plannedRuns = qs.questions.length * run.k;
  let skippedIncomplete = 0;
  let skippedGradeFailures = 0;
  let presentRuns = 0;
  for (const [, pr] of Object.entries(run.runs)) {
    presentRuns += 1;
    if (pr.status !== "complete" || !pr.trace) {
      skippedIncomplete += 1;
      continue;
    }
    const q = qs.questions[pr.question_index];
    if (!q) {
      skippedIncomplete += 1;
      continue;
    }
    const g = await gradeAnswer(q, pr.question_index, pr.k_index, pr.trace, grader, {
      model: graderModel,
    });
    if (g.ok) {
      grades.push(g.value);
      traces.set(`${q.id}:${pr.k_index}`, pr.trace);
    } else {
      skippedGradeFailures += 1;
    }
  }
  const score = aggregateScore(grades, qs.questions, { traces });
  score.models = {
    generator: qs.generator_model,
    answerer: run.answerer_model,
    grader: graderModel,
  };
  score.prompt_version = PROMPT_VERSION;
  score.spec_version = SPEC_VERSION;
  score.questions_id = qs.id;
  score.results_id = run.id;
  score.vault_hash = qs.vault_hash;
  score.k = run.k;
  score.n = qs.questions.length;
  score.timestamp = new Date().toISOString();
  const wroteScore = await persistOrRuntimeExit("score", () => writeScore(vault, score));
  if (wroteScore) return wroteScore;

  const histEntry: HistoryEntry = {
    score_id: score.results_id,
    score: score.score,
    score_std: score.score_std,
    by_tier: {
      retrieval: score.by_tier.retrieval.mean,
      cross_reference: score.by_tier.cross_reference.mean,
      contradiction: score.by_tier.contradiction.mean,
    },
    vault_hash: score.vault_hash,
    timestamp: score.timestamp,
    n: score.n,
    k: score.k,
    models: score.models,
    prompt_version: score.prompt_version,
    spec_version: score.spec_version,
  };
  const wroteHistory = await persistOrRuntimeExit("history", () => appendHistory(vault, histEntry));
  if (wroteHistory) return wroteHistory;

  // Pretty-print headline + per-tier means, and the coverage line (#102):
  // how many answerer runs the score actually stands on.
  process.stdout.write(`score: ${score.score.toFixed(3)} ± ${score.score_std.toFixed(3)}\n`);
  for (const t of TIERS) {
    const ts = score.by_tier[t];
    process.stdout.write(
      `  ${t.padEnd(16)}: ${ts.mean.toFixed(3)} (n=${ts.n}, efficiency=${ts.trace_efficiency.toFixed(1)} calls)\n`,
    );
  }
  const neverAttempted = Math.max(0, plannedRuns - presentRuns);
  process.stdout.write(`graded ${grades.length}/${plannedRuns} runs\n`);
  if (skippedIncomplete > 0 || skippedGradeFailures > 0 || neverAttempted > 0) {
    process.stderr.write(
      `warning: score is PARTIAL — ${skippedIncomplete} incomplete run(s), ` +
        `${skippedGradeFailures} grading failure(s), and ${neverAttempted} ` +
        `never-attempted run(s) were skipped; resume the run to complete it\n`,
    );
  }
  return 0;
}

// `daftari eval prune` (#100): explicit local housekeeping — no API key
// gate, unlike every LLM-mediated stage. Synchronous by design (small
// directory listings + unlinks).
function runPrune(argv: string[]): number {
  const vault = flag(argv, "vault") ?? process.cwd();
  const keepRaw = flag(argv, "keep");
  const olderRaw = flag(argv, "older-than");
  const dryRun = argv.includes("--dry-run");
  if (keepRaw === undefined && olderRaw === undefined) {
    process.stderr.write(
      "eval prune: at least one retention rule is required (--keep <count> and/or --older-than <age>)\n",
    );
    return 2;
  }
  const rules: PruneRules = {};
  if (keepRaw !== undefined) {
    const keep = intFlag(argv, "keep", 0);
    if (keep < 0) throw new Error("--keep must be a non-negative integer");
    rules.keep = keep;
  }
  if (olderRaw !== undefined) rules.maxAgeMs = parseOlderThan(olderRaw);

  // Deletion failures are runtime errors (exit 3), same class as every other
  // artifact-IO failure in this CLI.
  let dirResults: DirPruneResult[];
  try {
    dirResults = prune(vault, rules, { dryRun, nowMs: Date.now() });
  } catch (e) {
    process.stderr.write(`prune failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 3;
  }

  const verb = dryRun ? "would delete" : "deleted";
  for (const { dir, plan } of dirResults) {
    const bytes = plan.deleted.reduce((acc, c) => acc + c.size, 0);
    process.stdout.write(
      `${dir}: ${verb} ${plan.deleted.length} file(s) (${bytes} bytes), kept ${plan.kept.length}\n`,
    );
    if (dryRun) {
      for (const c of plan.deleted) process.stdout.write(`  ${c.name}\n`);
    }
  }
  return 0;
}

async function runTopLevel(argv: string[]): Promise<number> {
  // Spec §3 "Top-level convenience": runs generate → run → score in one shot.
  // We thread the IDs in-memory rather than re-reading from disk, so a
  // failure mid-pipeline still leaves the on-disk artifacts that did
  // succeed for forensic / resume use.
  const llm = resolveEvalLlm(argv);
  if (!llm.ok) {
    process.stderr.write(`${llm.error.message}\n`);
    return 2;
  }
  const vault = flag(argv, "vault") ?? process.cwd();
  const n = intFlag(argv, "n", 15);
  const k = intFlag(argv, "k", 2);
  const seed = flag(argv, "seed") ?? defaultSeed(vault);
  const model = flag(argv, "model") ?? llm.value.defaultModel;
  const maxNodes = maxNodesFlag(argv);

  // 1. Generate
  const sg = await sampleSubgraph(vault, seed, { maxNodes });
  if (!sg.ok) {
    process.stderr.write(`${sg.error.message}\n`);
    return 3;
  }
  const apiClient = llm.value.client;
  const qsRes = await generateQuestions(sg.value, apiClient, {
    n,
    model,
    vaultHash: vaultHash(vault),
    seed,
  });
  if (!qsRes.ok) {
    process.stderr.write(`${qsRes.error.message}\n`);
    return 3;
  }
  const qs = qsRes.value;
  qs.timestamp = new Date().toISOString();
  qs.id = `${qs.vault_hash}-${qs.seed}-${qs.timestamp}`;
  const wroteQs = await persistOrRuntimeExit("question set", () => writeQuestionSet(vault, qs));
  if (wroteQs) return wroteQs;
  process.stdout.write(`generated ${qs.questions.length} questions (id=${qs.id})\n`);

  // 2. Run — mint the stable id + timestamp up front and persist incrementally
  // so a mid-run failure leaves a resumable partial file.
  const runTimestamp = new Date().toISOString();
  const runId = `${qs.id}-${model}-${runTimestamp}`;
  const runRes = await runAnswerer(qs, vault, apiClient, {
    k,
    model,
    runId,
    timestamp: runTimestamp,
    persist: makeBestEffortPersist(vault),
  });
  if (!runRes.ok) {
    process.stderr.write(`${runRes.error.message}\n`);
    process.stderr.write(
      `partial results saved as ${runId}; resume with: daftari eval run --questions ${qs.id} --resume ${runId}\n`,
    );
    return 3;
  }
  const run = runRes.value;
  // Final write (covers the zero-question edge where persist never fired).
  const wroteRun = await persistOrRuntimeExit("results", () => writeResults(vault, run));
  if (wroteRun) return wroteRun;
  process.stdout.write(`ran ${Object.keys(run.runs).length} answerer invocations (id=${run.id})\n`);

  // 3. Score — invoke the same grading logic runScore uses, in-process. The
  // resolved transport is forwarded explicitly so the grader bills the same
  // key the answerer did.
  return await runScore([
    "--vault",
    vault,
    "--results",
    run.id,
    "--grader-model",
    model,
    "--transport",
    llm.value.transport,
  ]);
}
