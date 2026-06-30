# Handoff — Corpus (B) consensus-bench: CB5 DONE, three-lens table complete

**Date:** 2026-06-29 (supersedes `2026-06-29-corpus-b-arms-complete-cb5-pending.md`)
**Branch:** `feat/corpus-b-marker-armb` → **PR [#164](https://github.com/mavaali/daftari/pull/164) OPEN** (off main).
**Suite:** `integrations/consensus-bench` **89 green** (was 83; +6 CB5 unit tests); tsc clean. All LLM behind injectable seam; committed suite hermetic.

## One-line
Built + ran CB5 (contradiction-detector acquirer). It completes the publishable three-lens table — and surfaces an honest correction: the corpus's "stale-traps" are mostly **near-identical reverts**, not passage-level contradictions, so neither legitimate lens fires much (and that's the *corpus*, not the lens).

## What shipped this session
- **CB5 module** `integrations/consensus-bench/src/consensus-cb5-contradiction.ts` (commit `755ac50`): bespoke symmetric detector — `buildContradictionPrompt`/`parseContradiction`/`acquireContradiction`. Asks only `YES_CONFLICT`/`NO_CONFLICT`, **never which supersedes** → structurally cannot mint. 6 unit tests, one of which **asserts the prompt contains no directional language** (locks the no-mint property). Reuses `consensus-cb4-pairs` + `consensus-llm` untouched. No `src/` changes (daftari ships no contradiction pass — bespoke).
- **Paid run** (throwaway `_cb5-run.test.ts`, run once, **deleted, not committed**; 49 Haiku calls, ~$0.4, ~80s): **recall 2/33, false-pos 0/16, mints 0.**
- **Results note** `docs/superpowers/results/2026-06-29-corpus-b-cb5.md` (commit `eb6c164`, pushed).

## The finding (headline = corpus, not detector)
- median gov↔stale token-similarity **0.938**; 15/33 ≥0.95 near-identical; only 2/33 substantial-delta (<0.7). The detector fired on **exactly the 2 highest-delta pairs** and abstained on near-identical reverts → correct behavior; ~95% of pairs have **no passage-level conflict to detect**.
- The conflict is a **governance event** (a consensus-flagged passage was touched), living in edit/consensus-rule context, not in the two snippets → concrete mechanism argument for daftari's human/edit-signal tension surfacing.
- **Three-lens table:** derivation 1/33 / contradiction 2/33 / minting foil fabricates 26/49 — **both legitimate lenses mint 0**; never-mint is a property of *asking the non-directional question*. Clean controls 0/16 (vs foil 11/16, derivation 3/16) = non-directional question is least fabrication-prone.
- **Caveat propagates to CB4:** both recall denominators are dominated by non-semantic reverts, not clean genuine-competing-claim counts. Keystone (mint 0) survives regardless.

## NEXT (all LLM-cost — need Mihir's go)
1. **Span-level contradiction detection** — same non-directional question on the diff's CHANGED SPAN, not the full passage (median sim 0.938 ⇒ model reads mostly agreement). Cleanest single recall lift, still no-mint. *(Strongest next move; the corpus finding points straight at it.)*
2. **Genuine-competing-claims corpus** where the consensus VALUE changes — the contract-amendment chains ([[project_contract_supersession_benchmark]]); measures detectability without revert noise.
3. Full cortex pipeline on a built vault; full supersession-graph reconstruction; fuller Arm C localization past 16/33; pre-cutoff perturbation; stronger-model fabrication spot-check (Arm B + CB4 foil F are lower bounds).

## Process notes
- Pairs sourced from committed fixture `src/__fixtures__/trump-instance-diffs.json` (37 diffs → `truePairs` 33, `controlPairs` 16 via `consensus-cb4-pairs`) — reproducible, no re-pull needed.
- `OPENROUTER_API_KEY` in `~/.zshenv` (present in shell). Models: detector = `anthropic/claude-haiku-4.5`, temp 0.
- Throwaway runner pattern: `_*-run.test.ts` imports real modules + `openRouterClient(process.env.OPENROUTER_API_KEY, fetch)`, `{ timeout: 600_000 }`, `writeFileSync` to scratch (vitest suppresses console.log). Run once, delete, never commit.
- Old branch `feat/contract-bench-arms` still stale (split across #163 merged + #164) — Mihir may want it deleted.

Memory: `project_corpus_b_consensus_bench` (full state) + MEMORY.md index updated.
