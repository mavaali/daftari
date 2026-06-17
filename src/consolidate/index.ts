// `daftari consolidate` — Component C scheduler skeleton (Stage 1). Computes the
// edge due-queue + birth queue at session start and PRINTS them. No Component A,
// no writes to the vault, no LLM. Spec:
// docs/superpowers/specs/2026-06-13-cortex-consolidation-loop.md (§3, §4.0, §12).

import { existsSync } from "node:fs";
import { posix, resolve } from "node:path";
import { listEdges } from "../curation/edges.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { changedSince, log as gitLog, isGitRepo } from "../utils/git.js";
import { birthQueue, type DueEdge, decayBackstopDue, eventDue } from "./clocks.js";
import { CONSOLIDATE_DEFAULT_BUDGET } from "./constants.js";
import { prioritize } from "./priority.js";
import { readConsolidateState, writeConsolidateState } from "./state.js";

const HELP = `daftari consolidate — cortex loop scheduler (Stage 1: emits the queues, acts on nothing).

Usage:
  daftari consolidate [--vault <path>] [--budget <n>]

What it does:
  Computes three clocks (event / decay / backstop) over the derives_from edge
  store + git history at session start, ranks the due work into four slices under
  a compute budget, and prints the edge due-queue + the unprocessed-doc birth
  queue. It performs NO re-derivation and writes nothing to the vault (Stage 1).

Exit codes:
  0 — ran; queues emitted
  2 — config error (no vault, bad flags)
  3 — runtime error (edge-store / vault I/O)
  4 — ran, but backstop-overdue work was left unserved (cron-alertable, §9)
`;

const MS_PER_DAY = 86_400_000;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// Canonicalize a vault-relative path so the three joins (edge paths ↔ git-diff
// paths ↔ loaded-doc paths) key consistently. The edge store stores caller paths
// with only .trim() applied (edges.ts), so an alias like `a/../a/x.md` or
// `./x.md` could otherwise silently miss the byPremise/birth join — the
// path-aliasing bug class that bit the edge store and merge before. Normalize +
// strip a leading "./" so every consumer here compares the same key.
function canon(p: string): string {
  return posix.normalize(p).replace(/^\.\//, "");
}

export async function runConsolidate(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  // The CLI boundary must not throw (CLAUDE.md): any unexpected error → exit 2.
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

    const now = new Date();
    const state = readConsolidateState(vaultRoot);

    const edgesRes = await listEdges(vaultRoot, {}, now);
    if (!edgesRes.ok) {
      process.stderr.write(`consolidate: ${edgesRes.error.message}\n`);
      return 3;
    }
    // Canonicalize edge endpoints so they join cleanly against git-diff + doc paths.
    const edges = edgesRes.value.map((e) => ({
      ...e,
      fromPath: canon(e.fromPath),
      toPath: canon(e.toPath),
    }));

    const docsRes = await loadDocuments(vaultRoot);
    if (!docsRes.ok) {
      process.stderr.write(`consolidate: ${docsRes.error.message}\n`);
      return 3;
    }
    // LoadedDoc's vault-relative key is `path`, not `relPath` (vault-docs.ts:14).
    const docs = docsRes.value.map((d) => ({ relPath: canon(d.path), content: d.content }));
    const birthProcessed: Record<string, string> = {};
    for (const [k, v] of Object.entries(state.birthProcessed)) birthProcessed[canon(k)] = v;

    const inRepo = await isGitRepo(vaultRoot);

    // Event clock — only with a baseline commit AND a git repo. A present-but-
    // invalid baseline (rebased-away commit) is non-fatal: skip the event clock
    // (the nil path, §3.1/§7), but surface it so a silently-broken baseline can't
    // mask all event-driven work.
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

    // ages (days since last re-derivation) for periphery/backstop staleness ranks.
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

    // Report.
    const edgeItems = queue.filter((q) => q.kind === "edge");
    const birthItems = queue.filter((q) => q.kind === "birth");
    let report = `consolidate @ ${vaultRoot}\n`;
    report += `  edges: ${edges.length} | docs: ${docs.length} | budget: ${budget}\n`;
    report += `  edge due-queue (${edgeItems.length}):\n`;
    for (const q of edgeItems) {
      if (q.kind === "edge") report += `    [${q.slice}/${q.reason}] ${q.fromPath} ← ${q.toPath}\n`;
    }
    report += `  birth queue (${birthItems.length}):\n`;
    for (const q of birthItems) {
      if (q.kind === "birth") report += `    [birth] ${q.path}\n`;
    }
    report += `  backstop-overdue remaining: ${backstopOverdueRemaining}\n`;
    process.stdout.write(report);

    // Persist the new baseline (current HEAD). birthProcessed is unchanged in
    // Stage 1 (no births are actually processed; Stage 2 records them). A failed
    // write is a non-fatal degrade — the state is rebuildable.
    if (inRepo) {
      const head = await gitLog(vaultRoot, { limit: 1 });
      if (head.ok && head.value[0]) {
        const wrote = writeConsolidateState(vaultRoot, {
          ...state,
          lastConsolidationCommit: head.value[0].hash,
        });
        if (!wrote.ok) process.stderr.write(`consolidate: ${wrote.error.message}\n`);
      }
    }

    return backstopOverdueRemaining > 0 ? 4 : 0;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}
