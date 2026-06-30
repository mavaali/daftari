# Handoff — Corpus (B) consensus-bench: 4 arms DONE, CB5 spec approved (build pending)

**Date:** 2026-06-29
**Branch:** `feat/corpus-b-marker-armb` → **PR [#164](https://github.com/mavaali/daftari/pull/164) OPEN** (off main). PR [#163](https://github.com/mavaali/daftari/pull/163) MERGED (CO1 + CO2 pilot, squash).
**Suite:** `integrations/consensus-bench` 83 tests green; full repo 1570 green; tsc clean. All LLM behind an injectable seam — committed suite is hermetic (paid runs were deleted throwaways).

## One-line
Built the full corpus-(B) Wikipedia "Current consensus" supersession benchmark — four arms (recency / daftari / LLM-synth / acquired-edge) all DONE and shipped to #164; the **CB5 contradiction-detector** arm is spec'd + reviewer-approved but **not yet user-reviewed or built**.

## What shipped this session (all in `integrations/consensus-bench/`)
- **CO1** — acquisition: consensus box parser, topic grouping, `resolveCurrent` (no-mint chain-follow), consensus-citing-revert parser → labeled instances (editor alignment, no LLM aligner) → QA buckets. Real Trump pull (5000 revs → 37 citing-revert instances, 0 anomalies). *(merged in #163)*
- **CO2** — Arm A (stream-recency) + Arm C (daftari, `resolveCurrent` + inline-marker localization) + pilot. **Full 37-run: recency fails 33/33 @before, daftari never stale 0/33** (governing 16/33 where inline-marked). Marker fix = format-tolerant content markers (recovered 7→9/12 post-cutoff).
- **Arm B** — LLM-synth foil (Haiku + blind Gemini-Flash judge): **recency-trapped 20/33 stale, fabricates 0** (honest partial — daftari's edge = never-stale + determinism vs a conservative cheap model).
- **CB4** — acquired-edge, the publishable contribution: daftari's **actual** derivation classifier (vendored verbatim + byte-match drift-guard + `completeJson` schema-embedding) **recall 1/33, mints 0** (predicted: competing versions are TENSIONS not derivations → cortex doesn't auto-acquire → supersession stays deliberate; oracle→acquired gap 15). **Minting foil fabricates 26/49** (wrong-direction 15/33 + false-supersession-on-unrelated 11/16; position/recency-biased — the randomization fix revealed it).

Results: `docs/superpowers/results/2026-06-28-corpus-b-{co2-pilot,arm-b,cb4}.md`.

## CB5 — NEXT, spec done, NOT built
**Spec (approved by reviewer):** `docs/superpowers/specs/2026-06-29-corpus-b-cb5-contradiction-detector-design.md`.
**What it is:** a **bespoke** binary contradiction detector (`YES_CONFLICT`/`NO_CONFLICT`, **never asks direction = structural no-mint**) over CB4's 33 true + 16 control pairs. Tests whether the **right lens** (contradiction, not derivation) acquires the competing-version conflict CB4's derivation pass missed (recall), with low false-pos, minting 0. Completes the three-lens table: derivation misses (1/33) / contradiction acquires + no-mint (R′/33) / minting foil fabricates (26/49). Bespoke because **daftari has no auto-contradiction-detector** (confirmed in code — tensions are human-logged / `vault_edge_contest` / derivation-symmetric branch only).
**Resume at:** brainstorming skill's user-review gate is satisfied (reviewer approved; user said "new session" instead of approving) → on resume, get user OK on the spec, then **writing-plans → executing-plans (TDD)** → checkpointed paid run (~49 Haiku calls, <$1) → results note → push to #164. Mirror CB4's structure: `consensus-cb5-contradiction.ts` (buildContradictionPrompt/parseContradiction/acquireContradiction), reuse `consensus-cb4-pairs` + `consensus-llm`; runner logs control YES-rate next to recall (trivial-YES diagnostic, reviewer rec).

## Process notes / gotchas
- **Squash-merge divergence:** #163 squash-merged only CO1+pilot; the rest is a clean follow-up branch off origin/main (`feat/corpus-b-marker-armb`). After a squash merge, land follow-ups via a fresh branch off origin/main + cherry-pick the delta range `<firstNew>^..<oldbranch>` (NOT `..HEAD` — HEAD becomes the new branch after checkout; that bug cherry-picked unrelated commits, aborted + redone).
- **CB4 first paid run was 33/33 unparseable** — the acquirer omitted daftari's schema-embedding; Haiku free-formed keys (`reasoning`). Fixed by reproducing `completeJson` (vendored `DERIVATION_VERDICT_SCHEMA` + `derivationSystemWithSchema`). Lesson: to faithfully run a daftari cortex prompt, you must also reproduce the `completeJson` schema-embed from `src/eval/llm.ts`, not just the prompt string.
- Paid runs: throwaway `_*-run.test.ts` (imports real modules + `openRouterClient(process.env.OPENROUTER_API_KEY)`), run once explicitly, **deleted (never committed)**; vitest suppresses console.log → `writeFileSync` to scratch.
- `OPENROUTER_API_KEY` is set (in `~/.zshenv`). Models: Arm B/CB4/CB5 = `anthropic/claude-haiku-4.5`; judge = `google/gemini-2.5-flash` (cross-family).
- Old branch `feat/contract-bench-arms` is stale (content split across #163 merged + #164) — Mihir may want it deleted.

## Strategic corrections locked this session (memory updated)
- **No monetization lens** ([[feedback_no_monetization_lens]], [[project_daftari_purpose_and_free]]): daftari is FREE by design; don't make "will anyone pay / company-vs-feature" decisive. Judge by mechanism-correctness + research contribution + (shared) adoption-with-free-as-lever. Success = BOTH research vehicle AND free product (paid-shared maybe later, separate question).
- **Competition spans both arenas:** ContextForge is a **personal** memory competitor (Recall Bench) AND itself free → **free is not the moat; the no-mint/supersession mechanism is.** The benchmarks ARE the competitive defense, not just paper material.

## NEXT after CB5 (all LLM-cost, need Mihir's go)
Full cortex pipeline on a built vault (end-to-end "shipping system acquires"); full supersession-graph reconstruction; fuller Arm C localization past 16/33; pre-cutoff perturbation; stronger-model fabrication spot-check (Arm B + CB4 foil F are lower bounds). Track 1 demand validation (Mihir's conversations) remains the separate needle-mover.

Memory: `project_corpus_b_consensus_bench` (full state), MEMORY.md index updated.
