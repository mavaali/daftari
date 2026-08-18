import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Replay a birth run's gated edge verdicts into the edge store — the $0
// recovery for the envelope-budget collision the 2026-08-18 RB birth run
// exposed: B0 = min(0.5 + 0.25*pending, ln(N)) with edge-observe impact 0.05
// admits exactly 10 edges per session, so a 180-doc birth paid for 7,200
// verdicts and kept 10. Every verdict (direction included) is already in
// .daftari/birth-trace.jsonl; this script re-derives the observe records
// birth.ts would have written and applies them via observeEdge — no LLM, no
// spend, no re-run.
//
// OPERATOR TOOL, bench-vault posture: this deliberately bypasses the envelope
// (that is the point — the budget gate refused writes whose evidence was
// already bought and journaled). Differences from the live loop, both
// intentional:
//   - No direction-pending tensions are logged for symmetric pairs. Replayed
//     unresolved tensions would trip the tension-respect invariant for every
//     future consolidate run touching those docs, and the ceiling arm only
//     needs edges. The note marks the record as a replay instead.
//   - Each (from,to) pair is observed at most once across the whole trace
//     (the trace can contain duplicate doc rows from resumed/restarted runs,
//     and both endpoints of a pair can each report it) — the live loop's
//     re-observation strength semantics are not what a replay should mint.
//
// Env: REPLAY_VAULT (default /tmp/rb-baseline-vector/vault).

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const VAULT = process.env.REPLAY_VAULT ?? "/tmp/rb-baseline-vector/vault";

const { listEdges, observeEdge } = await import(join(ROOT, "dist/curation/edges.js"));
const { CONSOLIDATE_AGENT } = await import(join(ROOT, "dist/consolidate/constants.js"));
const { birthTracePath } = await import(join(ROOT, "dist/consolidate/birth.js"));

const rows = readFileSync(birthTracePath(VAULT), "utf8")
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);

// Last row per (docPath, contentHash) wins — a restarted run re-traces the
// docs it redid, and the newest row reflects the verdicts that were current.
const byDoc = new Map();
for (const row of rows) byDoc.set(`${row.docPath}\n${row.contentHash}`, row);

// Pairs already in the store (the ~10 the envelope admitted live, plus any
// prior replay) are skipped so the script is idempotent.
const existing = await listEdges(VAULT, {}, new Date());
if (!existing.ok) throw new Error(`listEdges: ${existing.error.message}`);
const seen = new Set(existing.value.map((e) => `${e.fromPath}\n${e.toPath}`));

let observed = 0;
let skippedExisting = 0;
let skippedDup = 0;
let unrelated = 0;
let errored = 0;
let failed = 0;

for (const row of byDoc.values()) {
  for (const v of row.verdicts) {
    if (v.error !== undefined) {
      errored++;
      continue;
    }
    if (!v.related || v.direction === "none") {
      unrelated++;
      continue;
    }

    // Mirror birth.ts exactly: directed premise "doc" puts the premise doc on
    // `to` (from=neighbor, to=doc); "neighbor" the reverse. Symmetric pairs
    // are canonical-sorted so re-observation lands on one key.
    let from;
    let to;
    let premiseVote;
    let note;
    if (v.direction === "directed") {
      [from, to] =
        v.premise === "doc" ? [v.neighbor, row.docPath] : [row.docPath, v.neighbor];
      premiseVote = "to";
      note = `birth(replay): ${v.reason}`;
    } else {
      [from, to] = [row.docPath, v.neighbor].sort();
      premiseVote = "symmetric";
      note = `birth/symmetric(replay): ${v.reason}`;
    }

    const key = `${from}\n${to}`;
    if (seen.has(key)) {
      if (v.gated) skippedDup++;
      else skippedExisting++;
      continue;
    }
    seen.add(key);

    const obs = await observeEdge(VAULT, {
      fromPath: from,
      toPath: to,
      observedBy: CONSOLIDATE_AGENT,
      blind: true,
      axis: "prompt",
      premiseVote,
      note,
    });
    if (!obs.ok) {
      failed++;
      console.error(`observe failed ${from} <- ${to}: ${obs.error.message}`);
      continue;
    }
    observed++;
  }
}

const after = await listEdges(VAULT, {}, new Date());
console.log(
  JSON.stringify(
    {
      vault: VAULT,
      traceRows: rows.length,
      docsAfterDedup: byDoc.size,
      observed,
      skippedExisting,
      skippedDuplicatePair: skippedDup,
      unrelated,
      erroredVerdicts: errored,
      observeFailures: failed,
      edgesInStore: after.ok ? after.value.length : `listEdges failed: ${after.error.message}`,
    },
    null,
    2,
  ),
);
if (failed > 0) process.exit(1);
