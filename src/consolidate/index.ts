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
import { addTension, listTensions } from "../curation/tension.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { createAnthropicClient, type LlmClient } from "../eval/llm.js";
import {
  createOpenRouterClient,
  type LlmTransport,
  resolveTransport,
} from "../eval/llm-openrouter.js";
import { err, ok } from "../frontmatter/types.js";
import { vaultSearchRelated } from "../tools/search.js";
import { loadConfig } from "../utils/config.js";
import { changedSince, log as gitLog, isGitRepo } from "../utils/git.js";
import { makeAdmit } from "./admit.js";
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
  CONSOLIDATE_DEFAULT_MODEL_OPENROUTER,
  CONSOLIDATE_PANEL_SIZE,
  estimateCostUSD,
  isModelPriced,
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
                      [--transport anthropic|openrouter]
  daftari consolidate --report decorrelation --fixture <path> [--model <id>]
                      [--transport anthropic|openrouter]

Transport (--transport, default 'anthropic'; env fallback DAFTARI_LLM_TRANSPORT):
  anthropic   @anthropic-ai/sdk, requires ANTHROPIC_API_KEY.
  openrouter  OpenRouter /chat/completions, requires OPENROUTER_API_KEY.
              Default model becomes ${CONSOLIDATE_DEFAULT_MODEL_OPENROUTER};
              pass OpenRouter slugs (e.g. openai/gpt-4o-mini) to --model.

Modes (--mode, default 'scan'):
  scan      Stage 1: emit the edge due-queue + birth queue. No LLM, no writes.
  birth     Stage 2: re-derive each unprocessed doc's top-K neighbors and
            edge_observe the survivors as k=0 candidates. (Requires the
            selected transport's API key.)
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
    Run the shared foundational-ordering prompt against a ground-truth-labeled
    fixture (brief item 8). Reports per-axis + majority accuracy, lift
    (informational — the axes are identical under the deterministic prompt),
    inter-axis agreement, error correlation. PASS/FAIL gates on ACCURACY: exits
    6 if majority accuracy < CONSOLIDATE_DIRECTION_MIN_ACCURACY (the foundational
    prompt did not recover direction well enough — fix the elicitation/fixture).
    Requires the selected transport's API key. A real fixture lives at
    tests/fixtures/decorrelation-fixture-v2.json.

Exit codes:
  0 — ran cleanly
  2 — config error (no vault, bad flags, missing transport API key in LLM mode)
  3 — runtime error (edge store / vault I/O)
  4 — ran, but backstop-overdue work was left unserved (cron-alertable)
  5 — ran, but one or more trace writes failed (recall-evaluation data lost)
  6 — decorrelation report ran, accuracy below the gate (fix elicitation/fixture)
  7 — ran, but the event-clock baseline was unreachable (gap skipped, re-baselined to HEAD)
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

// Transport-aware LLM construction. The key check runs before the constructor
// so a missing key fails fast with a clear message rather than the client's
// terse internal throw.
function constructLlm(transport: LlmTransport): { llm: LlmClient } | { error: string } {
  const keyVar = transport === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY";
  if (!process.env[keyVar]) {
    return { error: `${keyVar} env var is required (transport: ${transport})` };
  }
  try {
    return {
      llm: transport === "openrouter" ? createOpenRouterClient() : createAnthropicClient(),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

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
    const transportRes = resolveTransport(flag(argv, "transport"));
    if (!transportRes.ok) {
      process.stderr.write(`consolidate: ${transportRes.error.message}\n`);
      return 2;
    }
    const transport = transportRes.value;
    const model =
      flag(argv, "model") ??
      (transport === "openrouter"
        ? CONSOLIDATE_DEFAULT_MODEL_OPENROUTER
        : CONSOLIDATE_DEFAULT_MODEL);

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
    let staleBaseline = false;
    if (state.lastConsolidationCommit && inRepo) {
      const changed = await changedSince(vaultRoot, state.lastConsolidationCommit);
      if (changed.ok) eventEdges = eventDue(changed.value.map(canon), edges);
      else {
        // The stored baseline commit is unreachable (rebase / force-push / GC /
        // re-clone). The event clock can't run for the gap — it re-baselines to
        // HEAD below (the decay+backstop clock will still re-derive those edges
        // within the cap), but the gap is NOT event-examined, so we surface a
        // non-zero exit (7) rather than silently exit 0 as if all was covered.
        staleBaseline = true;
        process.stderr.write(
          `consolidate: stale baseline ${state.lastConsolidationCommit} — event clock skipped, ` +
            `re-baselining to HEAD (gap relies on the backstop clock; exit 7)\n`,
        );
      }
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
      const llmRes = constructLlm(transport);
      if ("error" in llmRes) {
        process.stderr.write(`consolidate: ${llmRes.error}\n`);
        return 2;
      }
      const llm = llmRes.llm;

      stage2.shadowMode = cfg.value.shadowMode;
      const observe = makeObserve({
        vaultRoot,
        shadowMode: cfg.value.shadowMode,
      });
      const contest = makeContest({
        vaultRoot,
        shadowMode: cfg.value.shadowMode,
      });
      // The real envelope-owned admit (Stage 3 Task 7): assembles the
      // EnvelopeCtx from in-process data, owns the §3.7 per-session spend
      // scalar (deduct-on-admit), and journals every decision. Construction
      // does I/O (loadDocuments / staged actions / tensions) and can fail.
      //
      // FAIL CLOSED: if construction fails the envelope cannot evaluate the
      // gate, so Component A MUST NOT run — letting birth/revision write
      // ungated would be exactly the auto-write-on-incomplete-info the envelope
      // exists to prevent. We surface the error and abort with a runtime exit.
      // Reuse the docs index.ts already loaded above (docsRes.value) — makeAdmit
      // derives its reverse maps / per-endpoint metadata / docCount from this
      // same LoadedDoc[], so no second vault walk happens.
      const admitRes = await makeAdmit({
        vaultRoot,
        principal: CONSOLIDATE_AGENT,
        docs: docsRes.value,
      });
      if (!admitRes.ok) {
        process.stderr.write(
          `consolidate: envelope init failed: ${admitRes.error.message} — Component A skipped (fail-closed)\n`,
        );
        return 3;
      }
      const admit = admitRes.value.admit;

      if (mode === "birth" || mode === "both") {
        const cap = maxBirths.value ?? Number.POSITIVE_INFINITY;
        const birthOnly = birthItems
          .filter((q): q is typeof q & { kind: "birth" } => q.kind === "birth")
          .slice(0, Math.min(birthItems.length, cap));
        await runBirthLoop(
          birthOnly,
          docByPath,
          admit,
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
          admit,
          observe,
          contest,
          llm,
          vaultRoot,
          model,
          stage2,
        );
      }

      // Surface journal-write failures the admit closure counted across the loops.
      // A failed journal write loses a calibration row but does not change any gate
      // verdict (mirrors traceWriteFailures — counted, not thrown).
      stage2.journalWriteFailures = admitRes.value.journalFailures();

      report += `  Component A (${mode}):\n`;
      report += `    births_processed: ${stage2.birthsProcessed}\n`;
      report += `    panels_cast: ${stage2.panelsCast} | votes_cast: ${stage2.votesCast}\n`;
      report += `    observed: ${stage2.observedTotal} | contested: ${stage2.contestedTotal} | gated: ${stage2.gated}\n`;
      report += `    llm_calls: ${stage2.llmCalls} | tokens: ${stage2.inputTokens}/${stage2.outputTokens} in/out\n`;
      report += `    est_cost_usd: ${estimateCostUSD(model, stage2.inputTokens, stage2.outputTokens).toFixed(4)} (${model})${
        isModelPriced(model) ? "" : " [pricing_fallback: haiku — model unpriced]"
      }\n`;
      if (stage2.traceWriteFailures > 0) {
        report += `    trace_write_failures: ${stage2.traceWriteFailures} — recall@K evaluator input lost (exit 5)\n`;
      }
      if (stage2.journalWriteFailures > 0) {
        report += `    journal_write_failures: ${stage2.journalWriteFailures} — calibration rows lost\n`;
      }
      // The envelope journals every decision (admit/gate) to shadow-actions.jsonl
      // regardless of shadow mode (makeAdmit owns this). In shadow mode the edge
      // STORE write is additionally suppressed (makeObserve); off-shadow, admitted
      // edges also land in edges.jsonl.
      if (stage2.shadowMode) {
        report += `    shadow_mode: true — envelope decisions journaled to shadow-actions.jsonl, edge store untouched\n`;
      } else {
        report += `    shadow_mode: false — envelope decisions journaled to shadow-actions.jsonl; admitted edges also written to the store\n`;
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
    // 5 (trace lost) > 4 (backstop unserved) > 7 (event-clock baseline lost) > 0.
    // Trace loss silently corrupts the calibration data flow (most serious);
    // backstop-overdue and a lost baseline are cron-alertable warnings the next
    // session / a human can resolve.
    //
    // journalWriteFailures is deliberately NOT in this hierarchy: a lost
    // calibration (shadow-actions) row never changes a gate verdict and is
    // already surfaced in the report above. It is reported-only by design, not
    // forgotten — the exit code is reserved for the data flows a human/cron must
    // act on.
    if (stage2.traceWriteFailures > 0) return 5;
    if (backstopOverdueRemaining > 0) return 4;
    return staleBaseline ? 7 : 0;
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
  // Edge-actions the envelope refused (birth gated neighbors + revision panels
  // whose majority decision was gated). Task 6 M1 reporting surface.
  gated: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  traceWriteFailures: number;
  // Calibration rows the envelope journal failed to persist (recordEnvelopeDecision
  // returned err). Counted, not thrown — surfaced in the report, never gates.
  journalWriteFailures: number;
  shadowMode: boolean;
}
function emptyStage2(): Stage2Result {
  return {
    birthsProcessed: 0,
    panelsCast: 0,
    votesCast: 0,
    observedTotal: 0,
    contestedTotal: 0,
    gated: 0,
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    traceWriteFailures: 0,
    journalWriteFailures: 0,
    shadowMode: false,
  };
}

async function runBirthLoop(
  birthItems: Array<{ kind: "birth"; path: string }>,
  docByPath: Map<string, { relPath: string; content: string }>,
  admit: BirthDeps["admit"],
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
  // Neighbor content is already in process (the docs map) — no disk read.
  const loadNeighborContent: BirthDeps["loadNeighborContent"] = async (path) => {
    const d = docByPath.get(canon(path));
    return d ? ok(d.content) : err(new Error(`neighbor not in docs map: ${path}`));
  };
  // Direction-pending tensions are authored under the loop principal. Dedup on
  // the canonical title (mirrors vaultEdgeContest): a doc re-births on every
  // edit, so without this an unresolved direction-pending pair would re-append
  // an identical tension on each re-birth and flood the advisory log.
  const recordTension: BirthDeps["recordTension"] = async (input) => {
    const existing = await listTensions(vaultRoot);
    if (existing.ok && existing.value.some((t) => t.title === input.title && !t.resolved)) {
      return ok(undefined); // already open for this pair — don't stack a duplicate
    }
    return addTension(vaultRoot, input);
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
    const out = await birthOne(
      doc,
      {
        llm,
        searchNeighbors,
        loadNeighborContent,
        admit,
        observe,
        recordTension,
        recordBirthTrace,
      },
      opts,
    );
    if (!out.ok) {
      process.stderr.write(`consolidate: birth failed for ${docPath}: ${out.error.message}\n`);
      continue;
    }
    accumulateBirth(stage2, out.value);
    // Only mark the doc processed if its trace landed. A failed trace write
    // (exit 5) must NOT be permanent: birthProcessed is keyed on content-hash, so
    // marking it here would stop the doc ever re-birthing and the recall@K trace
    // row — the whole reason birth mode exists — would be lost unrecoverably.
    if (out.value.traceWritten) birthProcessed[docPath] = out.value.contentHash;
  }
}

function accumulateBirth(stage2: Stage2Result, out: BirthOutcome): void {
  stage2.birthsProcessed++;
  stage2.observedTotal += out.observations.length;
  stage2.gated += out.gatedCount;
  stage2.llmCalls += out.llmCalls;
  stage2.inputTokens += out.inputTokens;
  stage2.outputTokens += out.outputTokens;
  if (!out.traceWritten) stage2.traceWriteFailures++;
}

async function runRevisionLoop(
  edgeItems: Array<{ kind: "edge"; fromPath: string; toPath: string }>,
  edgeByKey: Map<string, DerivesFromEdge>,
  docByPath: Map<string, { relPath: string; content: string }>,
  admit: RevisionDeps["admit"],
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
    // Defensive: the clocks already exclude direction-symmetric edges from the
    // due-list, but the revision panel votes on a FIXED from→to direction and
    // has no symmetric guard of its own. Keep the invariant next to the consumer
    // so a future due-path (e.g. the deferred TTL clock) can't feed a pending
    // edge into a directional verdict.
    if (edge.directionVerdict === "symmetric") continue;
    const out = await revisionPanel(
      edge,
      { llm, loadDoc, admit, observe, contest, recordRevisionTrace },
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
  if (out.decision === "gated") stage2.gated++;
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
  const fixtureRes = loadFixture(fixturePath);
  if (!fixtureRes.ok) {
    process.stderr.write(`consolidate: ${fixtureRes.error.message}\n`);
    return 2;
  }
  if (fixtureRes.value.edges.length === 0) {
    process.stderr.write("consolidate: fixture is empty\n");
    return 2;
  }

  const transportRes = resolveTransport(flag(argv, "transport"));
  if (!transportRes.ok) {
    process.stderr.write(`consolidate: ${transportRes.error.message}\n`);
    return 2;
  }
  const llmRes = constructLlm(transportRes.value);
  if ("error" in llmRes) {
    process.stderr.write(`consolidate: ${llmRes.error}\n`);
    return 2;
  }
  const llm = llmRes.llm;

  const model =
    flag(argv, "model") ??
    (transportRes.value === "openrouter"
      ? CONSOLIDATE_DEFAULT_MODEL_OPENROUTER
      : CONSOLIDATE_DEFAULT_MODEL);
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
