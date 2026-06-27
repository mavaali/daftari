# Handoff — E3 (run the arms) ready; E2 discovery shipped + spot-check passed

**Date:** 2026-06-27
**Branch:** `feat/contract-bench-arms` (NOT pushed; continues the contract-bench arc — CB1 + synthetic falsifier + E1 + E2 all live here)
**One-line:** E2 (chain-discovery tooling) is **shipped, suite-green (104), and spot-checked PASS**; the live run forced two real fixes and surfaced one new generalization gap that E3 must decide on before scaling. A real **selected NGS chain** exists and is ready to feed the arms.

## What E2 delivered

A zero-LLM EDGAR chain-discovery pipeline (7 TDD'd units + runner) that reuses E1 wholesale:
`efts-search → cik-tally → preamble → reconstruct → score → select` composed by `discover-edgar.mjs`.
- Plan: `docs/superpowers/plans/2026-06-26-e2-edgar-discovery.md` · Spec: `docs/superpowers/specs/2026-06-26-e2-edgar-discovery-design.md`
- Spot-check result: `docs/superpowers/results/2026-06-26-e2-discovery-spotcheck.md`
- Full suite 104 green, tsc clean. Work + build from `integrations/contract-bench` (`npx tsc`; `npx vitest run`).

## Three findings from the live run (read these before E3)

1. **`edgar-fetch.ts` cache-poisoning — FIXED** (commit `89b791b`). SEC serves empty-200 throttle blanks; `fetchFiling` was caching them as permanent 0-byte docs. Now rejects empty/whitespace bodies (never cached). Regression test added.
2. **`parsePreamble` was NGS-specific — FIXED** (commit `02649da`). It grabbed each amendment's OWN title date as the base → total fragmentation. Fixed with the **recital anchor** `that certain [the] <Type> Agreement dated as of <BASE date>` + ordinals extended past Tenth. Validated: PetroQuest 8th–12th collapse onto base "October 2, 2008"; NGS amendment-2 (previously dropped) restored. Real PetroQuest fixtures committed.
3. **`citation-parse` does NOT generalize to PetroQuest's drafting style — NOT fixed, the headline E3 decision.** The PetroQuest chain grouped correctly (len=6) but scored 1.00 unrecoverable on only 6 ops total; the 9th amendment parses **0 ops**. Discovery (grouping) generalizes; the per-op annotator is still NGS-shaped. **→ Today only restatement-heavy filers like NGS are labelable.**

## The asset E3 starts from

A real **selected** chain (produced over cached real exhibits; deterministic):
`0001084991-amended-and-restated-credit-agreement-february-28-2023` — master (NGS TCB A&R) + amendments 1→2→3→4, **rate 0.12, 17 ops, mixed, SELECTED**. Seed JSON + pairs dump are in `.discover-out/` (gitignored). The seed is E1-`assemble()`-shaped.

## First actions for E3

1. **Decide finding #3 (do this first — it scopes everything):** generalize `citation-parse` to non-restatement drafting styles, OR scope the benchmark to restatement-style chains (NGS-like) and say so explicitly. This determines whether a broad N≥20 set is reachable or the corpus is "restatement chains only." Recommend brainstorming this as its own step — it's a regime-defining call, not a code tweak.
2. **Run the arms on the NGS chain:** feed the selected seed to E1's `assemble()` → Arm A (recency-extract) vs Arm C (daftari `resolveCurrentSource`) on the scoped-current bucket, **plus the headline regime metric: the natural frequency of scoped-current-with-stale-mention** (the question the synthetic WIN couldn't answer). Harness pattern already exists: `falsifier-runner.mjs` (gen→assemble→reindex→Arm A + Arm C→score) from the 2026-06-25 synthetic run.
3. **Broad sweep when SEC cools:** `node discover-edgar.mjs "Amendment to Credit Agreement" 15 0.2` (the runner is correct; today the EFTS sweep is throttle-blocked — persistent empty-200 on this IP across 06-26/06-27). The runner has retry/backoff but couldn't outlast it today.

## Gotchas (don't rediscover)

- **`.edgar-cache/` and `.discover-out/` are gitignored** — NEVER commit pulled filings or discovery outputs. Only recorded fixtures (EFTS JSON + the NGS/PetroQuest HTML) are committed.
- **Tests never hit the network.** Live EFTS/curl only in the runner. `curl` + compliant UA works; `WebFetch` 403s.
- **Benign:** every commit prints `lint-staged could not find any staged files matching configured tasks` — commits land fine (verify `git show --stat`).
- **Chunk-default boundary (from the 2026-06-25 synthetic run):** atomized clause docs are title/frontmatter-keyed with bare-value bodies → body-only chunk-BM25 can't retrieve by clause id. Arm C must retrieve with `lexicalGranularity:"document"` + high limit (isolates resolution from retrieval ranking).

## After E3

E4 = Arm B (LLM-synth fabrication foil) + CB4 (acquired clause-supersession edges via the cortex loop — the publishable contribution). Memory `project_contract_supersession_benchmark` has the full arc banner. Parent handoff: `docs/superpowers/handoffs/2026-06-26-contract-bench-edgar-realism-pickup.md`.
