# Framing (A) small experiments — forced-answer Arm B + provenance eval

**Date:** 2026-06-27
**Branch:** `feat/contract-bench-arms`
**Purpose:** the two experiments framing (A) said it needed to move from "negative result + asserted claims" to measured claims. Both run on the real cached NGS (+ PetroQuest) chains; foils are neutral cross-family OpenRouter models (`openai/gpt-4o`, `google/gemini-2.5-flash`); contexts are PERTURBED (defeats training recall).
**Runners:** `arm-b-forced-runner.mjs`, `provenance-eval-runner.mjs`.

## Experiment 2 — forced-answer Arm B (sharpening Claim 2: non-fabrication)

Same partial/unrecoverable clauses, two conditions: **ABSTAIN** (model may decline — the conservative test) vs **FORCED** (model must state the current clause — the real consolidation/accumulation shape). N = 7 partial clauses (NGS `11.25`, `2.10(a)`; PetroQuest `5.03`, `8.01`, `9.02`, `9.03`, `12.04(c)`). Forced answers judged blind by the *other* foil (cross-judge): ASSERTED-complete = fabrication.

| Condition | gpt-4o | gemini-2.5-flash | daftari |
|---|---|---|---|
| ABSTAIN offered | 1/7 asserted | 1/7 asserted | 0/7 |
| **FORCED (no abstain)** | **4/7 fabricated** | **4/7 fabricated** | **0/7 (by design)** |

**Forcing the answer ~4×'s fabrication** (1/7 → 4/7). The abstain condition *understates* the risk; the forced condition is what a system maintaining a current state actually faces. Both foils fabricated the *same* 4 clauses and flagged the same 3 — so fabrication-vs-flag is driven by how explicitly each operative phrase signals partiality, not by the model. daftari's 0 is design-guaranteed (resolveChain leaves a partial clause `clean:false`, points to source, never mints).

This upgrades Claim 2 from "a guarantee a careful LLM usually matches" to **"the realistic consolidation baseline fabricates ~57% on partial clauses; daftari's 0 is design-level."**

## Experiment 1 — provenance eval (testing Claim 3: per-clause governing source + history)

For 6 non-trivial NGS clauses, can an LLM reading the raw amendments reproduce daftari's deterministic provenance (governing doc + ordered amendment history)? Ground truth from `resolveChain` (spot-check-verified). The prompt *states* daftari's rule (a partial edit does not establish governing).

| Clause | daftari governing | gpt-4o | gemini | history (both) |
|---|---|---|---|---|
| Commitment | amendment-2 | OK | OK | OK |
| Loan Documents (touched 4×) | amendment-3 | OK | OK | OK |
| 8.1 | amendment-2 | OK | OK | OK |
| Payment Conditions | amendment-2 | OK | OK | gpt-4o omitted `master` |
| **11.25 (partial)** | **master** | **XX → amendment-2** | **XX → amendment-2** | OK |
| **2.10(a) (partial)** | **master** | **XX → amendment-3** | **XX → amendment-3** | OK |

**Summary: governing — gpt-4o 4/6, gemini 4/6; history — gpt-4o 5/6, gemini 6/6; daftari 6/6 deterministic.**

The finding is *sharper* than "daftari provenance is necessary": LLMs **largely reproduce provenance for clean clauses** (history + governing). They **systematically fail governing on the partial clauses** — both said the governing doc is where the clause was last *touched* (amd-2/amd-3), where daftari says *master* because the partial edit never established a clean value. **Both failed this even though the rule was stated in the prompt** — they default to naive last-touched recency. That is exactly daftari's keystone (*a partial/tainted edit must not masquerade as a clean supersession*), and it is the one place naive provenance breaks.

## The unified finding (what this does for framing A)

Both experiments point at the **same subset**: daftari's edge is concentrated entirely on the **unrecoverable/partial clauses** —
- minting **fabricates** there (forced Arm B 4/7),
- naive provenance **mis-attributes governance** there (LLM 0/2, even when told the rule),

while on **clean** clauses, recency resolves the value (E3 tie) and LLMs reproduce the provenance. So daftari's contract value is not accuracy or provenance in general — it is the **no-mint + principled-governing guarantee on the partial/contested cases**, which is precisely the keystone. This tightens (A) into one claim: *where the chain is clean, a trivial baseline suffices; where an edit is partial/tainted, daftari refuses to fabricate and refuses to let the partial masquerade as a clean supersession — and a minting/LLM baseline does both.*

## Honest caveats

- **Small N:** 7 partial clauses (Arm B), 6 clauses incl. 2 partials (provenance). Illustrative; the partial subset is small (2 of 14 NGS clauses).
- **Cross-judge, not a third family:** each foil judged the other's forced answer; both agreed, but it isn't a fully independent judge.
- **FORCED is a constructed condition** (no abstain) — but it faithfully models a consolidation system that must maintain a current value.
- **daftari's 6/6 is by-construction** (it IS the deterministic chain); the spot-check is what validates it's correct. The measured quantity is the *LLM's* error, concentrated on partials.

## Status — framing (A)

Claims 2 and 3 are now **measured**, and they converge: the contracts paper's positive claim is the **no-mint + principled-governing guarantee on partial/tainted clauses**, with the clean-clause negative result (recency + LLM provenance suffice) as the foil that localizes it. (A) is now draft-ready as a measured result, not assertions.
