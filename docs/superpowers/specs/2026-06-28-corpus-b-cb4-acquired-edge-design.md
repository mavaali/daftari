# Corpus (B) CB4 — Acquired-edge arm (cortex derivation vs minting foil) (Design)

**Date:** 2026-06-28
**Status:** Design — pending spec review + user approval, then writing-plans
**Author:** brainstorming session (Claude + Mihir)
**Parent specs:** `2026-06-27-corpus-b-consensus-bench-design.md`, `2026-06-28-corpus-b-co2-arm-a-pilot-design.md`, `2026-06-28-corpus-b-arm-b-llm-synth-design.md`
**Depends on:** CO2 (the 33 scorable stale-trap `(governingText, staleText)` pairs via `consensus-content` + `consensus-passage`), the Arm B `LlmClient` seam.

---

## Context

CO2/CO3 measured Arm C with **oracle** edges (daftari handed the box's supersession
chain via `resolveCurrent`) — near-tautological by design. CB4 is the publishable
contribution: **can daftari acquire the supersession-relevant relation from the raw
stream, unaided?** — and what does *not* acquiring it (auto-minting, the accumulator
move) cost?

### The keystone reframe (confirmed in code)

daftari's cortex consolidation loop (`src/consolidate/`) emits **`derives_from`
edges** and logs **tensions**; it **never auto-writes `superseded_by`**
(`admit.ts` only *reads* `superseded_by` as a decay input; supersession is set
solely by deliberate human/tool acts). This is the keystone law in code: *"a
tension may never masquerade as a supersession"* — the cortex surfaces the
relation, a human commits the verdict. So "acquire the supersession edge" is the
wrong frame: daftari **deliberately refuses** to auto-acquire supersessions. CB4
therefore tests two things side by side:

- **daftari-way:** does the cortex's *derivation classifier* acquire the relation
  between the stale and governing positions (so it can be surfaced for a deliberate
  supersession), **never minting** the verdict?
- **minting foil:** an LLM that *does* auto-assert "N supersedes M" — quantifying
  both the extraction loss vs the oracle *and* the fabrication daftari's design
  avoids.

## Goal

Quantify (a) daftari-way **acquisition recall** of the supersession-relevant
relation from raw stream pairs, (b) the **oracle→acquired gap** (Arm C oracle
governing 16/33 minus acquired recall = daftari's extraction loss), and (c) the
**minting foil's fabrication rate** vs daftari-way's structural zero — the
sovereignty contrast.

## Non-goals

- Not the full cortex pipeline on a built vault (a heavier follow-on); CB4 uses
  daftari's *actual derivation prompt* on stream pairs — faithful to the mechanism
  without vault construction.
- Not a supersession auto-detector for daftari to ship (the foil exists to be
  beaten/contrasted, not adopted — it violates the keystone).
- No `src/` changes.
- Not the full supersession-graph reconstruction (pairs, not the whole chain);
  noted as a richer follow-on.

## Acquirers

Both run on **text pairs from the raw stream** (no box, no edit-summary citation),
via the Arm B `LlmClient` (`anthropic/claude-haiku-4.5`, temp 0).

- **daftari-way — the real derivation classifier.** Vendored *verbatim* from
  `src/consolidate/derivation-prompt.ts` (commit `7adfd42`): `DERIVATION_SYSTEM`,
  `derivationUserBody(aPath,aContent,bPath,bContent)`, and a
  `{related, premise, reason}` parser (mirrors `parseDerivationVerdict`). Output:
  `related` (is there a load-bearing dependency) + `premise` (A|B|symmetric). The
  prompt is presentation-order-agnostic by contract. **It cannot emit
  `superseded_by`** — keystone preserved structurally.
  - A **drift-guard test** `readFileSync`s `src/consolidate/derivation-prompt.ts`
    and asserts the vendored `DERIVATION_SYSTEM` + `derivationUserBody` text matches
    byte-for-byte, proving it is daftari's actual prompt (a file read, not a module
    import, so the bench's `rootDir: src` tsc stays clean).
- **minting foil — the verdict daftari refuses.** Bespoke prompt: *"Does A
  supersede B, B supersede A, or neither? Reply A_SUPERSEDES_B / B_SUPERSEDES_A /
  NEITHER."* Parser → directional verdict. Order randomized per trial (seedable),
  mapped back.

## Datasets

- **True pairs (33):** `(governingText, staleText)` from the scorable stale-traps.
  Ground truth: a real supersession relation exists; **governing supersedes stale**
  (governing is current, per the box-confirmed revert).
- **Control pairs (~15, unrelated):** governing passages from *different* consensus
  items. **Pairing must dedupe on `governingNum`, NOT pair by instance index** —
  only **18 distinct `governingNum`** values exist across the 37 instances (item 37
  appears 8×, item 70 7×), so an index offset would pair same-item passages, which
  are NOT unrelated. Construct controls by taking one instance per distinct
  `governingNum` and pairing items with *different* numbers (the 18-distinct ceiling
  makes ~15 achievable). Ground truth: no relation. **This item-level dedup is
  load-bearing, not cosmetic:** a same-item control would make the foil's mint there
  not-cleanly-a-fabrication and would *overstate* the foil's fabrication rate (and
  daftari-way's false-positive).

## Metrics

- **daftari-way (acquisition):**
  - **Recall** on true pairs = `related=true` rate (relation acquired → would surface
    a `derives_from`/tension for human supersession).
  - **False-positive** on control pairs = `related=true` rate (over-acquisition).
  - Premise-direction reported **descriptively only** (derivation foundation, *not*
    a supersession verdict — do not overclaim it as "got the supersession right").
  - **Supersessions minted: 0 (structural).**
- **minting foil:**
  - True pairs → {correct-direction (governing⊃stale) | wrong-direction =
    fabrication | neither}.
  - Control pairs → mint-rate (asserts any supersession) = fabrication.
  - **Fabrication F = wrong-direction + minted-on-unrelated.**
- **Oracle→acquired gap:** Arm C oracle governing **16/33** − daftari-way recall
  **R/33** = the extraction loss (the contract-bench "4× pipeline" analog),
  measured not assumed.

## Architecture (reuse the Arm B seam; offline-testable)

- `consensus-cb4-derivation.ts` — vendored `DERIVATION_SYSTEM`, `derivationUserBody`,
  `parseCb4Derivation` (returns `{related, premise, reason}`); `acquireDerivation(client, govText, staleText)`.
- `consensus-cb4-foil.ts` — `buildFoilPrompt`, `parseFoil` → `a_supersedes_b | b_supersedes_a | neither`; `classifyFoil(verdict, governingSide)` → `correct | wrong-direction | neither`.
- `consensus-cb4-pairs.ts` — `truePairs(diffs)` (scorable only) + `controlPairs(diffs)` (cross-item).
- `consensus-cb4-derivation.driftguard.test.ts` — byte-match vs the real src prompt.
- Throwaway paid runner (run once, deleted, not committed) — reuses `openRouterClient`;
  writes the metrics table + per-row to scratch. Hermetic suite via stub client.

```
CO2 diffs ─► parsePassage ─► truePairs (gov,stale) + controlPairs (cross-item)
                                   │
            ┌──────────────────────┴───────────────────────┐
            ▼                                                ▼
  daftari-way (real derivation prompt)            minting foil (forced supersession)
   -> {related, premise}                            -> direction verdict
            ▼                                                ▼
  recall (true) / false-pos (control)        correct/wrong-dir (true) / mint (control)
            └───────────────────────┬────────────────────────┘
                         metrics table + oracle→acquired gap (16 − R)
```

## Cost

~33 true + ~15 control pairs × 2 acquirers ≈ ~95 Haiku calls, temp 0, well under
$1. One run, checkpointed before spend. ([[reference_consolidate_budget_cost]] —
bounded to the fixture set, no loops.)

## Reading (characterization, stated straight — no contrived kill)

- **Low daftari-way recall is the *predicted* outcome, not a surprise.** The
  derivation classifier detects load-bearing *premise* dependency; stale-vs-governing
  are competing *versions* (a tension), which the conservative classifier is built to
  *not* flag as a derivation. So a low `related` rate reads as **confirmation of
  design** — daftari treats these as tensions to surface, not derivations to link,
  and supersession stays a deliberate human act (the thesis, with its curation cost
  named). Report it as such, not as a deficiency.
- High daftari-way recall (the less-expected case) → the cortex also acquires the
  relation as a derivation, closing the oracle gap; supersession then needs only a
  cheap human confirm.
- Either way, the **foil fabricates (F) while daftari-way mints 0** — the
  sovereignty evidence. If Haiku-foil is conservative, F is a **lower bound** (a
  more aggressive model would mint more); stated as such.

## Testing (hermetic)

- Drift-guard: vendored prompt == real src prompt (byte-match).
- `parseCb4Derivation` — valid/invalid verdict shapes (related/premise/reason).
- `parseFoil` / `classifyFoil` — all three verdicts; correct vs wrong-direction
  vs neither, both candidate orders (no position-bias leak).
- `truePairs` / `controlPairs` — scorable-only true pairs; control pairs are
  cross-item (different governingNum), never a real supersession.
- Acquirer call paths via stub `LlmClient`; **no network in the suite**.

## Definition of done

- `consensus-cb4-derivation`, `consensus-cb4-foil`, `consensus-cb4-pairs`
  implemented + unit-tested; drift-guard green; full `integrations/consensus-bench`
  suite green, tsc clean.
- Paid run executed (after checkpoint) over true + control pairs; metrics table
  (daftari-way recall + false-pos + 0-mint; foil correct/wrong/neither + mint;
  oracle→acquired gap 16 − R) recorded.
- Results note in `docs/superpowers/results/`, stated straight (including the
  conservative-foil lower-bound caveat), feeding
  [[project_corpus_b_consensus_bench]] and [[project_daftari_paper]].

**Next (separate):** full cortex pipeline on a built vault; full supersession-graph
reconstruction; pre-cutoff perturbation; fuller Arm C localization.
