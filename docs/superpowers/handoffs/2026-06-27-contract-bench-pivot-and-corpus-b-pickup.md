# Handoff — contract-bench: E2 shipped, the accuracy-regime pivot, corpus (B) validated

**Date:** 2026-06-27
**Branch:** `feat/contract-bench-arms` (NOT pushed; continues the contract-bench arc)
**Suite:** 111 tests green, tsc clean. 22 commits this session (`c723939`..`1d0832b`).
**One-line:** E2 (chain discovery) shipped; running the real arms refuted the contract *accuracy* regime (structurally — recency works on contracts); the paper split into **(A)** contracts-as-sovereignty/provenance and **(B)** the accuracy regime on human decision records; **(B)'s corpus (Wikipedia "Current consensus") is identified and its kill-condition cleared.** Two threads remain open: (A)'s two small experiments and (B)'s corpus-design brainstorm + build.

## The arc this session (what changed and why)

1. **E2 chain-discovery SHIPPED** (7 TDD'd units + `discover-edgar.mjs`), spot-check passed on the NGS chain. Two real bugs the live run forced (both fixed): `edgar-fetch` cache-poisoning (`89b791b`), `parsePreamble` NGS-specificity → recital anchor (`02649da`). A third gap noted, not fixed: `citation-parse` doesn't generalize to PetroQuest drafting (0 ops on its 9th amendment).
2. **E3 arms on the real NGS chain → INCONCLUSIVE tie** (`3b6af22`). Caught a *fourth* synthetic→real extraction artifact (a spurious "WIN" from corrupt ground truth); fixed `extractValue`/`recencyAnswer` (`3b3b6d7`). Honest result: recency suffices on a clean real chain.
3. **Arm B (minting foil) built + run** (`f9e9efb`, `811a8b3`): daftari 0 fabrication by design; LLM foils fabricate 0–50% (model-dependent, abstain offered). Sovereignty is real but the empirical gap over a careful LLM is small.
4. **Stale-mention probe → the pivot** (`802378a`): the accuracy regime (recency returns a stale value) is **structurally absent** in real contracts — operative-amendment idioms outnumber stale-recital idioms **>100:1** (EFTS), because of incorporation-by-reference drafting. **Contracts are recency-resolvable by drafting convention.** The benchmark's original headline premise is refuted.
5. **Paper split** (`2c8db01`): **(A)** contracts = explicit-supersession control + sovereignty/provenance + the negative result; **(B)** the accuracy regime on poor-hygiene human decision records.
6. **Corpus (B) found + validated** (`92989bb`, `f53daf4`, `1d0832b`): Wikipedia `Talk:<Article>/Current consensus` subpages. Step-1 kill-condition probe PASSES — recency fails 5–18% (Trump 18%, Biden 6%, COVID 5%) with explicit consensus-citing reverts (the mirror of contracts' ~0).

## The load-bearing findings (carry these forward)

- **Meta-finding:** daftari's resolution *mechanism* is sound; every *extraction/parse* layer was synthetic-shaped and broke on real EDGAR prose (four gaps). The synthetic→real cost is in the apparatus, not the thesis.
- **The corpus filter (decisive):** daftari's regime is **stale-restatement** (a later message asserts a *superseded* value as current → recency returns stale), which is *opposite* to **retention** (remember an unchanged value across noise = the accumulation pole's strength). Most state-tracking benchmarks (MultiWOZ/SGD/bAbI/TextWorld/BABILong/FreshQA) test retention → wrong regime. Structured logs/DB-transactions are recency-resolvable by construction → no accuracy niche. **daftari's accuracy value is specifically unstructured human decision text.**
- **(B) clears its gates:** ground truth = human-maintained consensus box (no LLM labeler → no contamination); alignment = editor-provided ("rv per consensus #N" → deterministic stale-edit→governing-item mapping); tensions = genuine (the keystone bucket contracts couldn't fill); contamination = post-cutoff items (Trump #67–76 are 2025–26) + perturbation.

## What's DONE / where to read it

- Code: `integrations/contract-bench/src/` (E1+E2+arms+Arm B, 111 tests). Runners: `discover-edgar.mjs`, `edgar-arms-runner.mjs`, `arm-b-runner.mjs`.
- Results: `docs/superpowers/results/2026-06-{26-e2-discovery-spotcheck, 27-e3-arms-ngs, 27-arm-b-fabrication-ngs, 27-stale-mention-regime-probe, 27-corpus-b-recency-fails-probe}.md`.
- Framing/feasibility: `docs/superpowers/drafts/2026-06-27-{contracts-sovereignty-paper-framing, corpus-b-feasibility}.md`.
- Memory: `project_contract_supersession_benchmark` (full arc banner), `project_daftari_paper` (two-corpus role).

## OPEN thread 1 — (A)'s two small experiments (NEXT — being run this session)

To make framing (A) venue-tier (it's currently a strong negative result + a model-dependent sovereignty result + an *asserted* provenance claim):
1. **Provenance eval:** per-clause governing-source + supersession-history accuracy — daftari (deterministic, = ground truth) vs an LLM-over-raw-docs baseline. Tests whether you *need* daftari's structured provenance or an LLM reading raw docs suffices. Ground truth from `resolveChain` (spot-check-verified). Trap = does the LLM err on provenance.
2. **Forced-answer Arm B + larger N + blind judge:** rerun Arm B without the abstain option (the real consolidation-baseline shape) on the full trap set (7 unique partial clauses: NGS 11.25, 2.10(a); PetroQuest 5.03, 8.01, 9.02, 9.03, 12.04(c)), with a blind cross-family judge classifying asserted-complete vs partial. Sharpens Claim 2 from "guarantee" to "measured gap." Infra: extend `arm-b-runner.mjs`; `OPENROUTER_API_KEY` is in env (ANTHROPIC unset). Foils: `openai/gpt-4o`, `google/gemini-2.5-flash`.

## OPEN thread 2 — (B)'s corpus design + build (the higher-leverage bet)

Brainstorm the corpus design as a unit BEFORE acquisition: (a) QA buckets — current-decision / stale-restatement-trap / live-tension-not-supersession; (b) contamination plan — post-cutoff item selection + perturbation, concretely; (c) labeling — how far deterministic consensus-citing-revert alignment gets you vs. where an aligner is needed without contaminating. Then build acquisition (the Wikipedia-API analog of E1 — `Talk:<Article>/Current consensus` + revision history; API works fine, no auth) and run the first real arms comparison. Seed articles: Trump (richest), Biden, Reagan, COVID×3, SARS-CoV-2, Albania–Greece, German-occupied-Poland; RfC-closures to scale.

## Gotchas

- `.edgar-cache/` and `.discover-out/` are gitignored — never commit pulled filings/outputs. Only fixtures (EFTS JSON, NGS/PetroQuest HTML) are committed.
- EDGAR broad sweep is SEC-throttle-blocked (persistent empty-200s); cached NGS+PetroQuest chains are sufficient for the (A) work. Wikipedia API is unthrottled and clean.
- Benign on every commit: `lint-staged could not find any staged files matching configured tasks` — commits land fine.
- Runners read `.edgar-cache` (machine-local); they embed the NGS seed inline so they reproduce from cache without re-pulling.
