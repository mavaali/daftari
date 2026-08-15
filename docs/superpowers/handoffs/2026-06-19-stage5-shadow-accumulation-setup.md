# Handoff — Stage 5 is data-blocked; shadow-accumulation cadence set up (2026-06-19)

**Supersedes the action items in `2026-06-19-stage5-pickup.md`.** That handoff said
"the FIRST action is to check whether shadow data exists, not to write code." Done.
Verdict below.

## Verdict: Stage 5 calibration is blocked on accumulating shadow data — confirmed

Swept every `.daftari` on the machine. **No `shadow-actions.jsonl` exists anywhere.
No `edges.jsonl` anywhere. No vault has `shadow_mode: true`.** [DATA] The data isn't
thin (the pickup's predicted case) — it's absent. Every actively-used vault
(`inverse-problem-vault`, MS-Scout `session-knowledge`, `daftari-demo/the-daftar`)
runs the *older sweep/curation-log* path, never the cortex loop.

Calibrating the §10 placeholder constants now would mean tuning against an empty
journal. So the real Stage-5 work cannot start until a corpus exists. **This session
set up the accumulation; it did not calibrate and did not touch loop code.**

## Mechanism (verified against source, read-only)

Two record types feed §10 calibration:

1. **Doc-write records** (`SHADOW_I_BASE` table + B₀ budget) — emitted *only* when
   `shadow_mode: true` in `config.yaml` (default `false`, `src/utils/config.ts:124`).
   ⚠️ Footgun: `shadow_mode: true` makes doc-write tools **no-op** (compute, journal,
   write nothing) — cannot be flipped on a vault used for real writes.
2. **Envelope decisions** (edge-observe/contest, the loop's auto-write candidates) —
   journaled by `src/consolidate/admit.ts:204` **regardless of shadow_mode**, but only
   when running `daftari consolidate --mode=birth|revision|both`. Default `--mode=scan`
   calls no LLM and emits nothing.

Decision (Mihir, this session): **cadence on a live vault** — run `--mode=both` on a
schedule with `shadow_mode` OFF. Envelope decisions accrue to `shadow-actions.jsonl`
(the calibration corpus) and edges land LIVE in `edges.jsonl` (Stage-3 "live-but-
shadowed" posture — gate decision journaled, no auto-write tier graduated, only the
§4.2 advisory tier writes). This calibrates the **envelope tier first**; the doc-write
I-table calibration is deferred (would need the write-suppressing shadow_mode).

## FIRST PASS RAN 2026-06-20 (exit 0) — corpus now exists; cost was NOT pennies

The cold-start `--mode=both` pass completed: **32 births, 2 edges observed live, 141
gated, 143 `shadow-actions.jsonl` rows** (from zero). ~66 min wall-clock (sequential,
network-bound LLM, no concurrency). **COST CORRECTION: the pass cost $2.95, not the
"pennies" estimated pre-run.** Root cause: birth makes `32 docs × top-K 20 neighbors ×
2 orders = 1280` Haiku calls; `--budget 50` did NOT cap births (mechanic worth verifying
before trusting it as a cost lever — real levers are `CONSOLIDATE_BIRTH_TOP_K` and the
both-orders doubling). **But this was one-time:** `consolidate-state.json` persisted all
32 docs as `birthProcessed`, so daily runs now skip births → revision-only on the 2
edges (1-day min interval) ≈ near-zero/day; re-birth (~$0.09/doc) recurs only on doc
add/edit. The 141-gated/2-observed split = cold-start envelope being conservative as
designed; that gated distribution IS the §10 calibration signal.

## What was built (scaffolding)

Target vault: **`/Users/mihirwagle/projects/inverse-problem-vault`** (32 interlinked
mech-interp docs, 0 edges = full cold-start birth queue; already on a weekly sweep
cadence; scan dry-run clean).

- `inverse-problem-vault/.daftari/consolidate-daily.sh` — runner, mirrors
  `weekly-sweep.sh`. Sources `consolidate-secret.env`, runs
  `node /Users/mihirwagle/projects/daftari/dist/cli.js consolidate --vault <vault> --mode both`,
  logs to `consolidate-logs/`, prunes to 30 runs, classifies exit codes (4/5/7 = ran-
  with-caveat, not failure).
- `~/Library/LaunchAgents/com.inverse-problem.daftari-consolidate.plist` — daily 03:30,
  `RunAtLoad=false`. `plutil -lint` OK. **Not loaded yet.**
- `inverse-problem-vault/.gitignore` — added `consolidate-secret.env`,
  `shadow-actions.jsonl`, `consolidate-logs/`, `consolidate-state.json`,
  `{birth,revision}-trace.jsonl`. (`edges.jsonl` left trackable — see open decision.)

## ⛔ The auth gap (why nothing ran yet)

`daftari consolidate --mode=both` requires a **billed `ANTHROPIC_API_KEY`**
(`src/eval/llm.ts:65` — hard requirement, no fallback). Mihir has a Claude Code OAuth
token (subscription, what the sweep uses) and an OpenRouter key, but **no Anthropic API
key is exposed**. Chosen fix: billed key in the git-ignored `consolidate-secret.env`.
**Until that file holds a real key, the runner exits 2 and the cron is a no-op.**

## Remaining MANUAL steps (Mihir — secret + launchctl are yours)

1. Create the secret (chmod 600; never in chat):
   `printf 'export ANTHROPIC_API_KEY=sk-ant-...\n' > inverse-problem-vault/.daftari/consolidate-secret.env && chmod 600 $_`
2. Smoke-test one pass: `bash inverse-problem-vault/.daftari/consolidate-daily.sh`
   then read the newest `consolidate-logs/run-*.log` and confirm `shadow-actions.jsonl`
   gained rows + `edges.jsonl` was created.
3. Load the cron: `launchctl load ~/Library/LaunchAgents/com.inverse-problem.daftari-consolidate.plist`

## Open decisions for next session

- **`edges.jsonl` versioning**: currently trackable. Decide whether the live edge store
  is vault content worth committing (valuable graph, but noisy per-run diffs) or local-
  advisory (gitignore it). Left trackable by default pending Mihir's call.
- **Calibration-readiness criterion**: how many sessions / how much variety of
  `{i_base, blast, impact, would_gate}` before the §10 tune begins? Re-segment sessions
  offline (§11.5: `spent_before`+`budget` recover true boundaries). Watch Stage-4
  `coverageEquity` + `directionResolution` (the stuck-pending proxy) during the window.
- **POISON CONSTRAINT** (unchanged, load-bearing): calibration is NEVER tuned to raise
  B. Tune so the envelope's variance/coverage matches design intent. B is a monitor.
- **CLAUDE.md charter amendment** (§14): still UNCHANGED, correct — it lands WITH the
  auto-write graduation at the END of Stage 5, not now.

## Status snapshot

main clean at `679e554`; `daftari@1.25.0` published (release ritual fully closed). No PR
this session — Stage 5 calibration code is correctly deferred until the corpus exists.
