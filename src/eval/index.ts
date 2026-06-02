// src/eval/index.ts
// Top-level CLI dispatcher for `daftari eval`. Parses flags, routes to
// generate/run/score/top-level, translates Result<T, CortexEvalError> to exit
// codes (2 = config, 3 = runtime/llm).

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { generateQuestions } from "./generate.js";
import { createAnthropicClient } from "./llm.js";
import { PROMPT_VERSION } from "./prompts.js";
import { runAnswerer } from "./run.js";
import { aggregateScore, gradeAnswer } from "./score.js";
import {
  appendHistory,
  readQuestionSet,
  readResults,
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
  daftari eval [--vault <path>] [--n <count>] [--k <count>] [--seed <str>]
  daftari eval generate [--vault <path>] [--n <count>] [--seed <str>]
  daftari eval run      [--questions <id>] [--vault <path>] [--model <id>] [--k <count>] [--resume <results-id>]
  daftari eval score    [--results <id>] [--vault <path>] [--grader-model <id>]

  (--questions and --results take the artifact id printed by a prior stage,
   not a file path; artifacts live under .daftari/eval/.)

Defaults:
  --n 15      total questions across three tiers (5 each)
  --k 2       runs per question for variance estimation
  --model     claude-sonnet-4-6 (DEFAULT_MODEL in src/eval/index.ts)
  --vault     current working directory

Environment:
  ANTHROPIC_API_KEY   required for any LLM-mediated stage

Disk usage:
  .daftari/eval/results/ and scores/ grow without bound across runs. v1
  recovery is a manual rm -rf .daftari/eval/results/; rerunning regenerates
  what's needed. A daftari eval prune command is the planned v2 follow-up.

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

function vaultHash(vault: string): string {
  return createHash("sha256").update(resolve(vault)).digest("hex").slice(0, 12);
}

function defaultSeed(vault: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${vaultHash(vault)}-${today}`;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

async function runGenerate(argv: string[]): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write("ANTHROPIC_API_KEY required\n");
    return 2;
  }
  const vault = flag(argv, "vault") ?? process.cwd();
  const n = intFlag(argv, "n", 15);
  const seed = flag(argv, "seed") ?? defaultSeed(vault);

  const sg = await sampleSubgraph(vault, seed, { maxNodes: 5 });
  if (!sg.ok) {
    process.stderr.write(`${sg.error.message}\n`);
    return 3;
  }
  const client = createAnthropicClient();
  const qs = await generateQuestions(sg.value, client, {
    n,
    model: DEFAULT_MODEL,
    vaultHash: vaultHash(vault),
    seed,
  });
  if (!qs.ok) {
    process.stderr.write(`${qs.error.message}\n`);
    return 3;
  }
  qs.value.timestamp = new Date().toISOString();
  qs.value.id = `${qs.value.vault_hash}-${qs.value.seed}-${qs.value.timestamp}`;
  await writeQuestionSet(vault, qs.value);
  process.stdout.write(
    `wrote question set ${qs.value.id} (${qs.value.questions.length} questions)\n`,
  );
  return 0;
}

async function runRun(argv: string[]): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write("ANTHROPIC_API_KEY required\n");
    return 2;
  }
  const vault = flag(argv, "vault") ?? process.cwd();
  const questionsId = flag(argv, "questions");
  if (!questionsId) {
    process.stderr.write("--questions required\n");
    return 2;
  }
  const k = intFlag(argv, "k", 2);
  const model = flag(argv, "model") ?? DEFAULT_MODEL;

  const qsRead = await readQuestionSet(vault, questionsId);
  if (!qsRead.ok) {
    process.stderr.write(`${qsRead.error.message}\n`);
    return 3;
  }

  let resumeFrom: EvalRun | undefined;
  const resumeId = flag(argv, "resume");
  if (resumeId) {
    const r = await readResults(vault, resumeId);
    if (r.ok) resumeFrom = r.value;
  }

  // Mint the stable id + timestamp up front so the on-disk file path is stable
  // across the run and any later --resume; persist incrementally so a mid-run
  // failure leaves a resumable partial file.
  const timestamp = new Date().toISOString();
  const runId = resumeFrom ? resumeFrom.id : `${qsRead.value.id}-${model}-${timestamp}`;
  const client = createAnthropicClient();
  const run = await runAnswerer(qsRead.value, vault, client, {
    k,
    model,
    resumeFrom,
    runId,
    timestamp,
    persist: (r) => writeResults(vault, r),
  });
  if (!run.ok) {
    process.stderr.write(`${run.error.message}\n`);
    process.stderr.write(
      `partial results saved as ${runId}; resume with: daftari eval run --questions ${questionsId} --resume ${runId}\n`,
    );
    return 3;
  }
  await writeResults(vault, run.value); // final write (covers the zero-question edge where persist never fired)
  process.stdout.write(`wrote results ${run.value.id}\n`);
  return 0;
}

async function runScore(argv: string[]): Promise<number> {
  const vault = flag(argv, "vault") ?? process.cwd();
  const resultsId = flag(argv, "results");
  if (!resultsId) {
    process.stderr.write("--results required\n");
    return 2;
  }
  const graderModel = flag(argv, "grader-model") ?? DEFAULT_MODEL;
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write("ANTHROPIC_API_KEY required\n");
    return 2;
  }

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

  const grader = createAnthropicClient();
  const grades: Grade[] = [];
  const traces = new Map<string, Trace>();
  for (const [, pr] of Object.entries(run.runs)) {
    if (pr.status !== "complete" || !pr.trace) continue;
    const q = qs.questions[pr.question_index];
    if (!q) continue;
    const g = await gradeAnswer(q, pr.question_index, pr.k_index, pr.trace, grader, {
      model: graderModel,
    });
    if (g.ok) {
      grades.push(g.value);
      traces.set(`${q.id}:${pr.k_index}`, pr.trace);
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
  await writeScore(vault, score);

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
  await appendHistory(vault, histEntry);

  // Pretty-print headline + per-tier means.
  process.stdout.write(`score: ${score.score.toFixed(3)} ± ${score.score_std.toFixed(3)}\n`);
  for (const t of TIERS) {
    const ts = score.by_tier[t];
    process.stdout.write(
      `  ${t.padEnd(16)}: ${ts.mean.toFixed(3)} (n=${ts.n}, efficiency=${ts.trace_efficiency.toFixed(1)} calls)\n`,
    );
  }
  return 0;
}

async function runTopLevel(argv: string[]): Promise<number> {
  // Spec §3 "Top-level convenience": runs generate → run → score in one shot.
  // We thread the IDs in-memory rather than re-reading from disk, so a
  // failure mid-pipeline still leaves the on-disk artifacts that did
  // succeed for forensic / resume use.
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write("ANTHROPIC_API_KEY required\n");
    return 2;
  }
  const vault = flag(argv, "vault") ?? process.cwd();
  const n = intFlag(argv, "n", 15);
  const k = intFlag(argv, "k", 2);
  const seed = flag(argv, "seed") ?? defaultSeed(vault);
  const model = flag(argv, "model") ?? DEFAULT_MODEL;

  // 1. Generate
  const sg = await sampleSubgraph(vault, seed, { maxNodes: 5 });
  if (!sg.ok) {
    process.stderr.write(`${sg.error.message}\n`);
    return 3;
  }
  const apiClient = createAnthropicClient();
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
  await writeQuestionSet(vault, qs);
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
    persist: (r) => writeResults(vault, r),
  });
  if (!runRes.ok) {
    process.stderr.write(`${runRes.error.message}\n`);
    process.stderr.write(
      `partial results saved as ${runId}; resume with: daftari eval run --questions ${qs.id} --resume ${runId}\n`,
    );
    return 3;
  }
  const run = runRes.value;
  await writeResults(vault, run); // final write (covers the zero-question edge where persist never fired)
  process.stdout.write(`ran ${Object.keys(run.runs).length} answerer invocations (id=${run.id})\n`);

  // 3. Score — invoke the same grading logic runScore uses, in-process.
  return await runScore(["--vault", vault, "--results", run.id, "--grader-model", model]);
}
