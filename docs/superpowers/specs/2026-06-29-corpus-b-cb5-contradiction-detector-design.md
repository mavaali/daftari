# Corpus (B) CB5 — Contradiction-detector acquirer (the right lens, no-mint) (Design)

**Date:** 2026-06-29
**Status:** Design — pending spec review + user approval, then writing-plans
**Author:** brainstorming session (Claude + Mihir)
**Parent spec:** `2026-06-28-corpus-b-cb4-acquired-edge-design.md`
**Depends on:** CB4 (the 33 true pairs + 16 control pairs via `consensus-cb4-pairs`), the Arm B `LlmClient` seam.

---

## Context

CB4 ran daftari's **actual derivation classifier** on the stale↔governing stream
pairs and got recall 1/33 — the predicted result: competing versions are
**tensions, not load-bearing derivations**, so the cortex's derivation pass (and
its direction-pending tension branch) never fires. An exploration confirmed
daftari has **no automatic contradiction detector** — tensions are created only by
human `vault_tension_log` / `vault_edge_contest`, or the derivation-symmetric
branch. So competing-version conflicts are, by design, **deliberately
human-surfaced**.

CB5 asks the natural next question: **is the *right* lens — a contradiction /
tension detector — able to acquire these conflicts, and does doing so stay
no-mint?** This is **bespoke** (daftari ships no such pass), so it measures
*detectability + no-mint-compatibility*, not "daftari does this today." A high
recall would be a concrete, on-thesis suggestion: daftari could add a contradiction
pass that auto-surfaces these tensions for deliberate human supersession — without
ever minting a verdict.

## Goal

Measure whether a contradiction detector acquires the competing-version relation
(recall on true pairs) that the derivation pass missed, with low false-positives on
unrelated controls, and **mints zero supersessions by construction** — completing
the three-lens acquired-edge story (derivation misses / contradiction acquires +
no-mint / minting foil fabricates).

## Non-goals

- Not a daftari mechanism (daftari has none); explicitly bespoke, framed as
  "what a tension pass would acquire."
- No `src/` changes. Not adding a contradiction pass to the cortex (that would be a
  separate product decision the result *informs*).
- Not a directional/supersession judgment — the prompt never asks which wins
  (that is CB4's minting foil); the no-mint property is structural here.

## The acquirer — contradiction-detector

Bespoke LLM (`anthropic/claude-haiku-4.5`, temp 0), via the Arm B `LlmClient`.
Prompt presents two passage versions A and B and asks **only**: *"Are these two in
conflict — incompatible statements of the same thing that cannot both be the
current consensus? Reply `YES_CONFLICT` or `NO_CONFLICT`."* (+ a one-line reason).
It **never asks which supersedes**, so it is **structurally incapable of minting a
supersession** — it flags the tension (like `vault_tension_log`) and leaves the
verdict to a human. That structural no-mint is the design's whole point.

Order-agnostic by construction (symmetric question "are A and B in conflict"), so
candidate order does not bias the verdict; no randomization needed (unlike the
foil's directional question).

## Datasets (reuse CB4's pairs)

- **True pairs (33):** `(governingText, staleText)` from the scorable stale-traps —
  two competing versions of one passage = a genuine conflict. A detector *should*
  flag these.
- **Control pairs (~16):** governing passages from *distinct* consensus items
  (`controlPairs`, deduped on `governingNum`) — different topics, not contradictory.
  A detector should *not* flag these.

## Metrics

- **Recall** on true pairs = `YES_CONFLICT` rate = the acquisition the derivation
  pass (CB4, 1/33) missed.
- **False-positive** on control pairs = `YES_CONFLICT` rate (over-detection of
  conflict between unrelated passages).
- **Supersessions minted = 0 (structural).**
- **Three-lens completion** (the publishable table):

  | lens | recall on true | mints |
  |---|---|---|
  | CB4 derivation (daftari's actual) | 1/33 | 0 |
  | **CB5 contradiction (right lens, bespoke)** | **R′/33** | **0** |
  | CB4 minting foil (accumulator) | n/a (asserts direction) | fabricates 26/49 |

## Architecture (reuse; offline-testable)

- `consensus-cb5-contradiction.ts` — `buildContradictionPrompt(textA, textB)` (pure),
  `parseContradiction(resp)` → `"yes" | "no"`, `acquireContradiction(client, textA, textB)`.
- Reuse `consensus-cb4-pairs` (`truePairs`, `controlPairs`) and `consensus-llm`
  (`LlmClient`, `openRouterClient`).
- Throwaway paid runner (run once, deleted, not committed) — writes the metrics
  table + per-row to scratch. Hermetic suite via stub client.

```
CB4 pairs ─► truePairs (33) + controlPairs (16)
                  │
                  ▼
   acquireContradiction (Haiku, "YES_CONFLICT/NO_CONFLICT", no direction asked)
                  ▼
   recall (true = YES rate) / false-pos (control = YES rate) / minted = 0
                  ▼
        three-lens table (derivation / contradiction / minting foil)
```

## Cost

~33 true + ~16 control = ~49 Haiku calls, temp 0, well under $1. One run,
checkpointed before spend.

## Reading (stated straight)

- **High recall + low false-pos** → the right lens acquires these conflicts and is
  no-mint-compatible: a concrete suggestion (a cortex contradiction pass could
  auto-surface them for human supersession, never minting). The CB4 derivation
  miss was a lens mismatch, not an inherent un-acquirability.
- **Low recall** → even a contradiction detector struggles to acquire these from
  raw competing text (e.g. the wordings differ too subtly without the topic
  anchor) → the human-logging design is load-bearing, not just conservative.
- **High false-pos** → the detector over-flags unrelated passages as conflicting →
  an auto-pass would be noisy; tempers the suggestion.
- Either way: **contradiction detection mints 0** (structural), vs the minting
  foil's 26 — the sovereignty property holds for the right lens too. Conservative
  Haiku → recall may be a lower bound and false-pos an upper bound; stated as such.

## Testing (hermetic)

- `buildContradictionPrompt` — contains both texts, asks YES_CONFLICT/NO_CONFLICT,
  and (assert) contains no "supersede"/"which" directional language (locks the
  structural no-mint).
- `parseContradiction` — YES_CONFLICT / NO_CONFLICT / ambiguous→no (conservative
  default: no false conflict on unparseable).
- `acquireContradiction` — via stub `LlmClient`; no network.
- Reuse the existing `truePairs`/`controlPairs` tests.

## Definition of done

- `consensus-cb5-contradiction` implemented + unit-tested; full
  `integrations/consensus-bench` suite green, tsc clean.
- Paid run executed (after checkpoint) over 33 true + ~16 control pairs; recall,
  false-pos, 0-mint recorded.
- Results note in `docs/superpowers/results/` with the three-lens table and a
  straight reading (lower-bound caveats), feeding
  [[project_corpus_b_consensus_bench]] and [[project_daftari_paper]].

**Next (separate):** full cortex pipeline on a built vault; full supersession-graph
reconstruction; pre-cutoff perturbation; fuller Arm C localization.
