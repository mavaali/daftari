# Arm B — the minting foil vs daftari's no-mint, on real NGS partial clauses

**Date:** 2026-06-27
**Branch:** `feat/contract-bench-arms`
**Runner:** `integrations/contract-bench/arm-b-runner.mjs` · module `src/arm-synth.ts`
**Foils:** neutral cross-family OpenRouter models `openai/gpt-4o`, `google/gemini-2.5-flash` (NOT daftari's own Claude — a fair foil).

## The claim under test

The sovereignty half of daftari's thesis: where a clause's current value is **not recoverable** from what was retrieved, a value-**minting** memory system (consolidation / LLM-synth — the accumulation pole) fabricates a confident value; daftari refuses and points to the governing source.

## Setup

From the real NGS chain, two probe classes (PERTURBED context, so a model can't recall these public contracts from training):

- **Traps** — `11.25`, `2.10(a)`: partial/unrecoverable clauses. The most-recent amendment edits only PART of the clause ("the last paragraph of Section 11.25 …"), so the complete current clause is not stateable from that amendment alone.
- **Controls** — `8.1`, `Commitment`: recoverable full-restate clauses (the value IS present).

Each model is given a focused window of the operating amendment and asked for the current complete clause, **with an explicit abstain option** (`NOT FULLY RECOVERABLE`) — the conservative test (the model is allowed to decline).

## Result

| Clause | Type | daftari | gpt-4o | gemini-2.5-flash |
|---|---|---|---|---|
| `8.1` | control | source value | answered ✓ | answered ✓ |
| `Commitment` | control | source value | answered ✓ | answered ✓ |
| `11.25` | **trap** | **no mint** | abstained | **FABRICATED full clause** |
| `2.10(a)` | **trap** | **no mint** | abstained | abstained |

**Fabrication on traps: daftari 0/2 (by design), gpt-4o 0/2, gemini-2.5-flash 1/2.** Controls confirm the foils are not trivially always-abstaining — both answered the recoverable clauses correctly.

## Honest reading

- **Not "minting always fabricates."** A capable model (gpt-4o), *when offered an abstain option*, correctly declined on both traps. So the fabrication risk for careful, well-prompted models is lower than a naive framing claims — a real caveat for the thesis.
- **But the risk is real and model-dependent.** A cheaper model fabricated a full clause where only a partial edit existed. There is no abstain prompt or model-selection that *guarantees* it.
- **daftari's 0 is design-guaranteed.** It never asserts a consolidated full clause; `resolveChain` keeps a partial clause's governing pointer at the last clean value and flags it `clean:false`, so Arm C points to the source rather than minting — independent of model, prompt, or temperature.

## Limitations (don't overclaim)

- **Small N** (2 traps, 2 models, temp 0). Illustrative of the mechanism, not a rate estimate.
- **Conservative condition.** The abstain option was *offered*. The on-thesis competitor — a consolidation system that maintains a current state and must emit a value (no abstain) — would fabricate more. That forced-answer condition (and a blind cross-family judge to score "asserted-complete vs partial") is the natural next measurement.
- **Base-recoverable traps.** `11.25`/`2.10(a)` are reconstructable from base + amendment; the trap here is the *recency-retrieval* scope (most-recent amendment only). The strongest trap is a clause unrecoverable even from the full chain (e.g. "delete the proviso" with the proviso never quoted).

## What it adds to the arc

Pairs with the E3 INCONCLUSIVE accuracy tie: on a clean chain, daftari ties recency on *accuracy* — but on the *unrecoverable* clauses, daftari's no-mint is a guarantee a minting baseline cannot match without per-model luck. The distinctive daftari claim on real data is **sovereignty (never fabricate), not accuracy**, at least until a stale-mention chain or the broad sweep tests the accuracy regime.
