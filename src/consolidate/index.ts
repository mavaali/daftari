// `daftari consolidate` — the cortex consolidation loop entrypoint.
//
// Stage 1 (shipped): computes the edge due-queue + birth queue at session
// start and prints them. No LLM, no writes.
// Stage 2 (this PR): adds Component A. With `--mode=birth|revision|both`,
// the LLM re-derives queue items and emits edge_observe/edge_contest. Under
// `shadow_mode: true` the writes are journaled, not applied (calibration
// posture, spec §11.5). The auto-write tier graduates in Stage 5.
//
// Default mode is `scan` (Stage 1 behavior): no LLM, no writes — backward
// compatible. Stage 2 modes are explicit opt-in so an unsuspecting cron
// invocation doesn't start spending money.
//
// Spec: docs/superpowers/specs/2026-06-13-cortex-consolidation-loop.md
// Brief: docs/superpowers/drafts/2026-06-16-cortex-stage-2-component-a-brief.md

import { existsSync } from "node:fs";
import { posix, resolve } from "node:path";
import { type DerivesFromEdge, listEdges } from "../curation/edges.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { createAnthropicClient, type LlmClient } from "../eval/llm.js";
import { ok } from "../frontmatter/types.js";
import { vaultSearchRelated } from "../tools/search.js";
import { loadConfig } from "../utils/config.js";
import { changedSince, log as gitLog, isGitRepo } from "../utils/git.js";
import {
  appendBirthTrace,
  type BirthDeps,
  type BirthOpts,
  type BirthOutcome,
  birthOne,
} from "./birth.js";
import { birthQueue, type DueEdge, decayBackstopDue, eventDue } from "./clocks.js";
import {
  CONSOLIDATE_AGENT,
  CONSOLIDATE_DEFAULT_BUDGET,
  CONSOLIDATE_DEFAULT_MODEL,
  CONSOLIDATE_PANEL_SIZE,
  estimateCostUSD,
} from "./constants.js";
import { formatDecorrelationReport, loadFixture, runDecorrelation } from "./decorrelation.js";
import { makeContest, makeObserve } from "./edge-write.js";
import { prioritize } from "./priority.js";
import {
  appendRevisionTrace,
  type RevisionDeps,
  type RevisionOpts,
  type RevisionOutcome,
  revisionPanel,
} from "./revision.js";
import { readConsolidateState, writeConsolidateState } from "./state.js";

const HELP = `daftari consolidate — cortex loop scheduler + Component A (shadow-only).

Usage:
  daftari consolidate [--vault <path>] [--budget <n>] [--mode <m>]
                      [--max-panels <n>] [--max-births <n>] [--model <id>]
  daftari consolidate --report decorrelation --fixture <path> [--model <id>]

Modes (--mode, default 'scan'):
  scan      Stage 1: emit the edge due-queue + birth queue. No LLM, no writes.
  birth     Stage 2: re-derive each unprocessed doc's top-K neighbors and
            edge_observe the survivors as k=0 candidates. (Requires
            ANTHROPIC_API_KEY.)
  revision  Stage 2: cast an M-vote panel on each due edge, emit edge_observe
            (survives) or edge_contest (fails) per vote.
  both      birth then revision (the full pass).

Stage 2 modes call the LLM and emit edge writes. Under shadow_mode:true those
writes go to .daftari/shadow-actions.jsonl, not .daftari/edges.jsonl. With
shadow_mode off, edge_observe/contest land for real — but Stage 2 ships with
NO auto-write graduation, so even off-shadow only the auto-write tier from
spec §4.2 lands (link / confidence-down / tension_log / contest revoke).

What it does:
  Computes three clocks (event / decay / backstop) over the derives_from edge
  store + git history at session start, ranks the due work into four slices
  under a compute budget, then (mode != scan) runs Component A on those
  items. The trace files (.daftari/{birth,revision}-trace.jsonl) are the
  decorrelation report's input (brief item 8).

Reports:
  --report decorrelation --fixture <path>
    Run all v1 prompt-framing axes against a ground-truth-labeled fixture
    (brief item 8). Reports per-axis accuracy, majority accuracy, lift,
    inter-axis agreement, error correlation. Exits 6 if the kill condition
    fires (majority - max(single) below CONSOLIDATE_DECORRELATION_MIN_LIFT).
    Requires ANTHROPIC_API_KEY. The real ~50-edge fixture lives at
    tests/fixtures/decorrelation-fixture.json (built in a separate
    session).

Exit codes:
  0 — ran cleanly
  2 — config error (no vault, bad flags, missing ANTHROPIC_API_KEY in LLM mode)
  3 — runtime error (edge store / vault I/O)
  4 — ran, but backstop-overdue work was left unserved (cron-alertable)
  5 — ran, but one or more trace writes failed (recall-evaluation data lost)
  6 — decorrelation report ran, kill condition fired (multi-model required)
`;

const MS_PER_DAY = 86_400_000;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// Canonicalize a vault-relative path so the three joins (edge paths ↔ git-diff
// paths ↔ loaded-doc paths) key consistently. The edge store stores caller
// paths with only .trim() applied; an alias like `a/../a/x.md` or `./x.md`
// could otherwise silently miss the byPremise/birth join.
function canon(p: string): string {
  return posix.normalize(p).replace(/^\.\//, "");
}

type Mode = "scan" | "birth" | "revision" | "both";
const VALID_MODES: ReadonlySet<string> = new Set(["scan", "birth", "revision", "both"]);

export async function runConsolidate(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  // --report=decorrelation is an alternate entry point: no vault scan, no
  // queue, no Component A — just runs the v1 axes against the fixture and
  // emits the analysis. Branches early so the main consolidate flow stays
  // unchanged.
  const reportName = flag(argv, "report");
  if (reportName === "decorrelation") {
    return runDecorrelationReportCli(argv);
  }
  if (reportName !== undefined) {
    process.stderr.write(`consolidate: --report must be 'decorrelation', got ${reportName}\n`);
    return 2;
  }

  try {
    const vaultRoot = resolve(flag(argv, "vault") ?? process.cwd());
    if (!existsSync(vaultRoot)) {
      process.stderr.write(`consolidate: no vault at ${vaultRoot}\n`);
      return 2;
    }
    const budget = Number(flag(argv, "budget") ?? CONSOLIDATE_DEFAULT_BUDGET);
    if (!Number.isFinite(budget) || budget <= 0) {
      process.stderr.write("consolidate: --budget must be a number > 0\n");
      return 2;
    }
    const modeStr = (flag(argv, "mode") ?? "scan").toLowerCase();
    if (!VALID_MODES.has(modeStr)) {
      process.stderr.write(
        `consolidate: --mode must be one of scan|birth|revision|both, got ${modeStr}\n`,
      );
      return 2;
    }
    const mode = modeStr as Mode;
    const maxBirths = parseOptionalInt(flag(argv, "max-births"));
    if (maxBirths.error) {
      process.stderr.write(`consolidate: ${maxBirths.error}\n`);
      return 2;
    }
    const maxPanels = parseOptionalInt(flag(argv, "max-panels"));
    if (maxPanels.error) {
      process.stderr.write(`consolidate: ${maxPanels.error}\n`);
      return 2;
    }
    const model = flag(argv, "model") ?? CONSOLIDATE_DEFAULT_MODEL;

    const now = new Date();
    const state = readConsolidateState(vaultRoot);

    const edgesRes = await listEdges(vaultRoot, {}, now);
    if (!edgesRes.ok) {
      process.stderr.write(`consolidate: ${edgesRes.error.message}\n`);
      return 3;
    }
    const edges = edgesRes.value.map((e) => ({
      ...e,
      fromPath: canon(e.fromPath),
      toPath: canon(e.toPath),
    }));
    const edgeByKey = new Map<string, DerivesFromEdge>();
    for (const e of edges) edgeByKey.set(`${e.fromPath}\n${e.toPath}`, e);

    const docsRes = await loadDocuments(vaultRoot);
    if (!docsRes.ok) {
      process.stderr.write(`consolidate: ${docsRes.error.message}\n`);
      return 3;
    }
    const docs = docsRes.value.map((d) => ({ relPath: canon(d.path), content: d.content }));
    const docByPath = new Map<string, { relPath: string; content: string }>();
    for (const d of docs) docByPath.set(d.relPath, d);

    const birthProcessed: Record<string, string> = {};
    for (const [k, v] of Object.entries(state.birthProcessed)) birthProcessed[canon(k)] = v;

    const inRepo = await isGitRepo(vaultRoot);

    let eventEdges: DueEdge[] = [];
    if (state.lastConsolidationCommit && inRepo) {
      const changed = await changedSince(vaultRoot, state.lastConsolidationCommit);
      if (changed.ok) eventEdges = eventDue(changed.value.map(canon), edges);
      else
        process.stderr.write(
          `consolidate: stale baseline ${state.lastConsolidationCommit} — skipping event clock\n`,
        );
    }
    const decayEdges = decayBackstopDue(edges, now);
    const birth = birthQueue(docs, birthProcessed);

    const ages: Record<string, number> = {};
    for (const e of edges) {
      ages[e.fromPath] = (now.getTime() - new Date(e.lastRederived).getTime()) / MS_PER_DAY;
    }

    const { queue, backstopOverdueRemaining } = prioritize({
      edgeDue: [...eventEdges, ...decayEdges],
      birth,
      budget,
      ages,
    });

    const edgeItems = queue.filter((q) => q.kind === "edge");
    const birthItems = queue.filter((q) => q.kind === "birth");

    // --- report header (mode-independent) -------------------------------------

    let report = `consolidate @ ${vaultRoot}\n`;
    report += `  edges: ${edges.length} | docs: ${docs.length} | budget: ${budget} | mode: ${mode}\n`;
    report += `  edge due-queue (${edgeItems.length}):\n`;
    for (const q of edgeItems) {
      if (q.kind === "edge") report += `    [${q.slice}/${q.reason}] ${q.fromPath} ← ${q.toPath}\n`;
    }
    report += `  birth queue (${birthItems.length}):\n`;
    for (const q of birthItems) {
      if (q.kind === "birth") report += `    [birth] ${q.path}\n`;
    }
    report += `  backstop-overdue remaining: ${backstopOverdueRemaining}\n`;

    // --- Stage 2: Component A dispatch ---------------------------------------

    const stage2: Stage2Result = emptyStage2();
    if (mode !== "scan") {
      const cfg = await loadConfig(vaultRoot);
      if (!cfg.ok) {
        process.stderr.write(`consolidate: ${cfg.error.message}\n`);
        return 2;
      }
      // ANTHROPIC_API_KEY check before constructing the client — fail-fast with
      // a clear message rather than the SDK's terse internal throw.
      if (!process.env.ANTHROPIC_API_KEY) {
        process.stderr.write(
          "consolidate: ANTHROPIC_API_KEY env var is required for --mode != scan\n",
        );
        return 2;
      }
      let llm: LlmClient;
      try {
        llm = createAnthropicClient();
      } catch (e) {
        process.stderr.write(`consolidate: ${e instanceof Error ? e.message : String(e)}\n`);
        return 2;
      }

      stage2.shadowMode = cfg.value.shadowMode;
      const observe = makeObserve({
        vaultRoot,
        shadowMode: cfg.value.shadowMode,
        principal: CONSOLIDATE_AGENT,
      });
      const contest = makeContest({
        vaultRoot,
        shadowMode: cfg.value.shadowMode,
        principal: CONSOLIDATE_AGENT,
      });

      if (mode === "birth" || mode === "both") {
        const cap = maxBirths.value ?? Number.POSITIVE_INFINITY;
        const birthOnly = birthItems
          .filter((q): q is typeof q & { kind: "birth" } => q.kind === "birth")
          .slice(0, Math.min(birthItems.length, cap));
        await runBirthLoop(
          birthOnly,
          docByPath,
          observe,
          llm,
          vaultRoot,
          model,
          stage2,
          birthProcessed,
        );
      }

      if (mode === "revision" || mode === "both") {
        const cap = maxPanels.value ?? Number.POSITIVE_INFINITY;
        const edgeOnly = edgeItems
          .filter((q): q is typeof q & { kind: "edge" } => q.kind === "edge")
          .slice(0, Math.min(edgeItems.length, cap));
        await runRevisionLoop(
          edgeOnly,
          edgeByKey,
          docByPath,
          observe,
          contest,
          llm,
          vaultRoot,
          model,
          stage2,
        );
      }

      report += `  Component A (${mode}):\n`;
      report += `    births_processed: ${stage2.birthsProcessed}\n`;
      report += `    panels_cast: ${stage2.panelsCast} | votes_cast: ${stage2.votesCast}\n`;
      report += `    observed: ${stage2.observedTotal} | contested: ${stage2.contestedTotal}\n`;
      report += `    llm_calls: ${stage2.llmCalls} | tokens: ${stage2.inputTokens}/${stage2.outputTokens} in/out\n`;
      report += `    est_cost_usd: ${estimateCostUSD(model, stage2.inputTokens, stage2.outputTokens).toFixed(4)} (${model})\n`;
      if (stage2.traceWriteFailures > 0) {
        report += `    trace_write_failures: ${stage2.traceWriteFailures} — recall@K evaluator input lost (exit 5)\n`;
      }
      if (stage2.shadowMode) {
        report += `    shadow_mode: true — edge writes journaled to shadow-actions.jsonl, store untouched\n`;
      }
    }

    process.stdout.write(report);

    // --- persist state -------------------------------------------------------

    // Always persist birthProcessed (Stage 2 progress is independent of git).
    // Only advance the event-clock baseline (lastConsolidationCommit) when we
    // have a HEAD; in a non-git dir we keep the prior value (likely null) so
    // the event clock stays in the nil-path on every run.
    let newCommit: string | null = state.lastConsolidationCommit;
    if (inRepo) {
      const head = await gitLog(vaultRoot, { limit: 1 });
      if (head.ok && head.value[0]) newCommit = head.value[0].hash;
    }
    const wrote = writeConsolidateState(vaultRoot, {
      ...state,
      lastConsolidationCommit: newCommit,
      birthProcessed,
    });
    if (!wrote.ok) process.stderr.write(`consolidate: ${wrote.error.message}\n`);

    // --- exit code hierarchy --------------------------------------------------
    // 5 (trace lost) > 4 (backstop unserved) > 0. Trace loss is the more
    // serious signal because it silently corrupts the calibration data flow;
    // backstop-overdue is a warning the next session can resolve.
    if (stage2.traceWriteFailures > 0) return 5;
    return backstopOverdueRemaining > 0 ? 4 : 0;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}

// --- helpers -----------------------------------------------------------------

function parseOptionalInt(raw: string | undefined): { value: number | null; error?: string } {
  if (raw === undefined) return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    return { value: null, error: `expected a non-negative integer, got ${JSON.stringify(raw)}` };
  }
  return { value: n };
}

interface Stage2Result {
  birthsProcessed: number;
  panelsCast: number;
  votesCast: number;
  observedTotal: number;
  contestedTotal: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  traceWriteFailures: number;
  shadowMode: boolean;
}
function emptyStage2(): Stage2Result {
  return {
    birthsProcessed: 0,
    panelsCast: 0,
    votesCast: 0,
    observedTotal: 0,
    contestedTotal: 0,
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    traceWriteFailures: 0,
    shadowMode: false,
  };
}

async function runBirthLoop(
  birthItems: Array<{ kind: "birth"; path: string }>,
  docByPath: Map<string, { relPath: string; content: string }>,
  observe: BirthDeps["observe"],
  llm: LlmClient,
  vaultRoot: string,
  model: string,
  stage2: Stage2Result,
  birthProcessed: Record<string, string>,
): Promise<void> {
  const searchNeighbors: BirthDeps["searchNeighbors"] = async (docPath, k) => {
    const r = await vaultSearchRelated(vaultRoot, { path: docPath, limit: k });
    if (!r.ok) return r;
    return ok(r.value.hits.map((h) => h.path));
  };
  const recordBirthTrace: BirthDeps["recordBirthTrace"] = (row) => appendBirthTrace(vaultRoot, row);

  const opts: BirthOpts = {
    vaultRoot,
    agent: CONSOLIDATE_AGENT,
    axis: "forward",
    budgetRemaining: Number.POSITIVE_INFINITY,
    model,
  };
  for (const item of birthItems) {
    const docPath = canon(item.path);
    const doc = docByPath.get(docPath);
    if (!doc) continue; // queue → docs is reconstructible; a missing doc is non-fatal
    const out = await birthOne(doc, { llm, searchNeighbors, observe, recordBirthTrace }, opts);
    if (!out.ok) {
      process.stderr.write(`consolidate: birth failed for ${docPath}: ${out.error.message}\n`);
      continue;
    }
    accumulateBirth(stage2, out.value);
    birthProcessed[docPath] = out.value.contentHash;
  }
}

function accumulateBirth(stage2: Stage2Result, out: BirthOutcome): void {
  stage2.birthsProcessed++;
  stage2.observedTotal += out.observations.length;
  stage2.llmCalls += out.llmCalls;
  stage2.inputTokens += out.inputTokens;
  stage2.outputTokens += out.outputTokens;
  if (!out.traceWritten) stage2.traceWriteFailures++;
}

async function runRevisionLoop(
  edgeItems: Array<{ kind: "edge"; fromPath: string; toPath: string }>,
  edgeByKey: Map<string, DerivesFromEdge>,
  docByPath: Map<string, { relPath: string; content: string }>,
  observe: RevisionDeps["observe"],
  contest: RevisionDeps["contest"],
  llm: LlmClient,
  vaultRoot: string,
  model: string,
  stage2: Stage2Result,
): Promise<void> {
  const loadDoc: RevisionDeps["loadDoc"] = async (path) => {
    const d = docByPath.get(canon(path));
    if (!d) {
      return { ok: false, error: new Error(`doc not in load set: ${path}`) };
    }
    return ok({ path: d.relPath, content: d.content });
  };
  const recordRevisionTrace: RevisionDeps["recordRevisionTrace"] = (row) =>
    appendRevisionTrace(vaultRoot, row);

  const opts: RevisionOpts = {
    vaultRoot,
    agent: CONSOLIDATE_AGENT,
    panelSize: CONSOLIDATE_PANEL_SIZE,
    budgetRemaining: Number.POSITIVE_INFINITY,
    model,
  };
  for (const item of edgeItems) {
    const key = `${canon(item.fromPath)}\n${canon(item.toPath)}`;
    const edge = edgeByKey.get(key);
    if (!edge) continue;
    const out = await revisionPanel(
      edge,
      { llm, loadDoc, observe, contest, recordRevisionTrace },
      opts,
    );
    if (!out.ok) {
      process.stderr.write(
        `consolidate: revision failed for ${key.replace("\n", "←")}: ${out.error.message}\n`,
      );
      continue;
    }
    accumulateRevision(stage2, out.value);
  }
}

function accumulateRevision(stage2: Stage2Result, out: RevisionOutcome): void {
  stage2.panelsCast++;
  stage2.votesCast += out.votes.length;
  stage2.observedTotal += out.observedCount;
  stage2.contestedTotal += out.contestedCount;
  stage2.llmCalls += out.llmCalls;
  stage2.inputTokens += out.inputTokens;
  stage2.outputTokens += out.outputTokens;
  if (!out.traceWritten) stage2.traceWriteFailures++;
}

// --- --report=decorrelation ---------------------------------------------------

async function runDecorrelationReportCli(argv: string[]): Promise<number> {
  const fixturePath = flag(argv, "fixture");
  if (!fixturePath) {
    process.stderr.write("consolidate --report decorrelation: --fixture <path> is required\n");
    return 2;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      "consolidate --report decorrelation: ANTHROPIC_API_KEY env var is required\n",
    );
    return 2;
  }

  const fixtureRes = loadFixture(fixturePath);
  if (!fixtureRes.ok) {
    process.stderr.write(`consolidate: ${fixtureRes.error.message}\n`);
    return 2;
  }
  if (fixtureRes.value.edges.length === 0) {
    process.stderr.write("consolidate: fixture is empty\n");
    return 2;
  }

  let llm: LlmClient;
  try {
    llm = createAnthropicClient();
  } catch (e) {
    process.stderr.write(`consolidate: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  const model = flag(argv, "model") ?? CONSOLIDATE_DEFAULT_MODEL;
  const reportRes = await runDecorrelation(
    fixtureRes.value,
    { llm },
    { model, fixtureSource: fixturePath },
  );
  if (!reportRes.ok) {
    process.stderr.write(`consolidate: ${reportRes.error.message}\n`);
    return 3;
  }
  process.stdout.write(formatDecorrelationReport(reportRes.value));
  // Kill condition fires → exit 6 so CI / a calibration wrapper can branch.
  return reportRes.value.passes ? 0 : 6;
}
