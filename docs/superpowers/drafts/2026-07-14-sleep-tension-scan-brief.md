# Sleep tension-scan — design brief

Date: 2026-07-14
Status: shipped with the feature (`daftari sleep --dream tension-scan`)
Evidence base: integrations/langgraph-store-demo (detect_tensions.py,
RESULTS.md, detect-report.json)

## What this is

The langgraph-store demo's agent detection pass, promoted from a Python
prototype to a first-class daftari feature: a sleep dream-type that walks
candidate documents, retrieves related documents through the same layer
`vault_search_related` uses, puts ONE pair of claims in front of an LLM per
call, and logs genuine conflicts to the tension ledger with
`kind: factual|temporal|interpretive` and `loggedBy: agent:sleep-tension-scan`
(configurable). Plus an eager trigger: `daftari import ... --apply` prints a
one-line hint recommending the scan — it never auto-runs it.

## Why sleep, not lint

`vault_lint` is the deterministic, free, always-safe-to-run advisory surface.
Every lint check is a pure computation over what is already on disk — it can
run on every write, in CI, in a pre-commit hook, with zero marginal cost.
Contradiction detection calls an LLM: it costs money, it is nondeterministic
(the demo's detection run-variance: 9 tensions in one run, 10 in the rerun,
kind labels varying between runs), and it writes to the tension ledger.
Putting it in lint would either poison lint's "free to run anywhere" contract
or force a confusing paid/unpaid split inside one tool. Sleep is already the
scheduled, operator-owned, report-producing pass — and it already had the
posture the scan needs: the vault proposes, the human ratifies. The scan
extends sleep with an explicitly opt-in dream type; the default circadian
dream stays LLM-free, so an existing cron `daftari sleep` line can never
start spending.

## Why not consolidate

PR #227's finding, measured in the demo: the consolidate loop ran unchanged
over the imported corpus (49 births, 1,960 LLM calls, $2.62) and logged
**zero tensions — correctly**. Consolidate is a derivation-graph maintainer;
its two-gate design asks "does B derive from A," not "can A and B both be
true." Contradiction detection is a different judgment with a different
prompt, a different write target (the tension ledger, not the edge store),
and a different failure posture (append a tension; never arbitrate). Bolting
it onto consolidate would couple two budgets, two shadow-mode semantics, and
two calibration loops. The demo's architectural claim — dedup is not
epistemics — cuts both ways: the derivation loop should not pretend to be a
contradiction detector, and the detector should not live inside it. What the
scan does reuse from consolidate is pattern, not code path: the call-budget
posture (`call-budget.ts` — only a call-level cap is a real spend bound) and
the `.daftari/` JSON state-file pattern (`state.ts` — ephemeral, rebuildable,
absent-or-corrupt ⇒ empty default).

## The budget model

Three independent brakes, all hard requirements:

1. **max LLM calls per pass** — `tension_scan.max_llm_calls` in
   `.daftari/config.yaml` (default 200), overridable per-run with
   `--max-llm-calls`. Checked before every judgment; once spent, the pass
   short-circuits without another network call. The 200 default is sized
   from the demo: 49 notes ⇒ 194 pairwise judgments ≈ $2 on a frontier
   judge, so one default pass covers a ~50-doc corpus.
2. **judged-pair dedupe across runs** — pair hashes persist in
   `.daftari/tension-scan-state.json` (NOT the SQLite index: the index is a
   rebuildable cache; a reindex must not re-bill every pair). The hash
   covers each side's path AND content hash, so an unchanged pair is never
   paid for twice, while editing either doc re-opens exactly the pairs that
   doc participates in.
3. **candidate bound per pass** — `tension_scan.max_docs` (default 50),
   prioritized never-scanned first, then changed-since-last-scan (git
   `changedSince` orders the changed set; the stored content hash decides
   membership, so uncommitted edits still re-enter). The remainder waits
   for the next sleep.

Plus one ledger rule: an existing unresolved tension for a pair blocks both
re-judging and re-logging (`listTensions` is consulted first). Resolved
tensions do not block — an edited doc deserves re-examination even against a
closed dispute, and the pair-hash dedupe already prevents free re-billing.

Conservatism is enforced twice: in the prompt (the demo's clause —
related-but-compatible is NOT a conflict; measured false-positive rate 0–1
borderline flags per run over ~30 benign filler notes) and in the failure
mode (an unparseable or failed verdict defaults to no-conflict; the pair is
not marked judged, so a later pass may retry inside its own budget).

RBAC: tension writes obey the `vault_tension_log` rule (#212,
`tension-access.ts sourceReadable`) — a pair with an unreadable side is
neither judged nor logged. You cannot quote what you cannot read.

## Trigger semantics

Two triggers, one command:

- **Nightly**: the operator adds `--dream tension-scan` to a scheduled sleep
  invocation (or a second cron line). Scheduling stays the OS's job.
- **Post-import (the day-0 gap)**: after `daftari import ... --apply`
  succeeds — both the obsidian and langgraph-store paths — the CLI prints a
  one-line hint naming the exact scan command. Hint only, never auto-run:
  the scan spends money, and daftari's posture is explicit opt-in for
  anything that costs (the same reasoning that makes consolidate refuse
  `mode != scan` without an explicit `shadow_mode` in config). An import is
  the moment the gap is widest and the operator is already at the terminal;
  a hint converts that moment without converting their wallet.

## Day-0 gap evidence (from the demo)

A freshly imported foreign corpus is exactly the population the scan exists
for. Measured on the 49-note post-LangMem store import:

- 14 planted contradictions survived import (LangMem's own consolidation had
  caught 0/14, and silently destroyed 1–3 of them per run in the shared
  namespace).
- The one-pair-at-a-time agent pass found them: 3/3 pairwise plants, the
  4-node n-way capacity set assembled as ONE connected component from three
  pairwise judgments no single call saw together, 2/2 temporal traps flagged
  `kind: temporal` and left unresolved.
- Cost envelope: 49 searches, 194 judgments, ~$2. False positives: 0–1
  borderline per run, and the one flag was an arguably real tension the
  fixture created by accident.

Without an eager trigger, none of that surfaces until someone happens to run
a scan — the corpus sits contradiction-blind from day 0. The hint closes the
discovery gap; the budget model makes saying yes cheap and bounded.

## Deliberate non-goals

- No new MCP tool (the 14-tool surface is contract-tested;
  test_integration.py fails loudly on drift). The scan is CLI-only, like
  consolidate.
- No auto-resolution — the scan appends to the ledger; `daftari court` and
  `vault_tension_resolve` remain the human path.
- No auto-run inside import, no matter how cheap a pass looks.
- No new dependencies; the LLM client is the existing eval transport pair
  (anthropic default, openrouter opt-in).
