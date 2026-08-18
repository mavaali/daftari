# Results — MAV-161: supersession suppression mechanism + deterministic bench

**Date:** 2026-08-17
**Bead:** MAV-161 (multi-hop retrieval epic MAV-155; the P1 suppression child the Fable review added — the placebo-confirmed second lever)
**Harness:** `integrations/recall-bench/{gen-supersession-vault.mjs,suppression-bench.mjs}`

**One line:** `vault_search` can now demote supersession-stale hits and foreground their current heads (config-gated off), and the deterministic bench shows the exact placebo inversion fixed — stale-above-head 100%→0% at every budget, current-head recall 0%→100% at tight budgets — with zero span-recall cost; the hallucination-judged arm that decides the default stays key-gated.

## Why this child exists [DATA]

The 2026-06-21 placebo proved co-ranked stale distractors are *causally* hallucinogenic: adding them back to an otherwise-correct context re-induced hallucination 0%→28%. The same doc's decision line: raise span recall AND foreground against stale distractors. Every other child of the epic widens; this one cleans.

## What shipped

- **The pass** (`src/search/suppression.ts`), run inside `vault_search` after RBAC + coverage, before enrichment:
  - **Pull-in**: a hit whose `superseded_by` chain resolves to a readable current head *not in the list* gets that head inserted at its own rank slot — score 0, flagged `viaForeground` (the relevance the stale doc earned is occupied by the current version of that content).
  - **Demote**: every hit with a resolved head moves to the tail, flagged `demoted: "superseded"`. Lossless — nothing is dropped, the annotation stays, the agent-as-reranker sees everything.
  - Only `kind: "resolved"` chains participate: dangling/cycle/restricted chains have no head to offer, and demoting without a successor could bury the only readable copy.
  - Federation mounts get demotion only — pulling a cross-mount head would need alias path rewriting; documents-not-state keeps that out of v1.
- **The gate**: `search.suppress_superseded` in config.yaml, default **off**, applied at startup like the other retrieval knobs, resolved *inside* the pass so a future call site cannot forget it (the same structural-gate lesson the coverage retirement review taught).
- **Two boundaries** (added per review): the pass never runs on `valid_at` queries — a doc superseded today can be exactly the right answer for a past date, and per-date chain resolution is `validAtSource`'s job — and pulled-in heads share the coverage pass's token-cap budget in `enforceTokenCap` (evicted last, position-preserving), so the served set is bounded.
- RBAC is inherited from `resolveCurrentSource`: a chain with any unreadable hop degrades to `restricted` and never participates, so a pulled-in head is readable by construction.

## Deterministic bench [DATA]

Corpus: 30 v1→v2→v3 chains where the stale versions are lexically stronger for the query than the head (the RB "day-6 Condor estimate outranks the day-28 revision" shape — RB itself has **no** `superseded_by` chains, which is why this surface had to be built), plus 10 unsuperseded doc pairs as the span-recall guard. 40 queries × 2 arms × 2 serving budgets, real `vault_search` end to end:

| metric (stale-trap, n=30) | limit 2 off | limit 2 on | limit 5 off | limit 5 on |
|---|---|---|---|---|
| current head in context | **0.00** | **1.00** | 1.00 | 1.00 |
| head above stale ancestors | 0.00 | **1.00** | **0.00** | **1.00** |
| span-guard recall (n=10) | 1.00 | 1.00 | 1.00 | 1.00 |

- At the tight budget the pass is the difference between the current value reaching the answerer at all (0→1) — the recall half.
- At the loose budget the head was already served but *below* its stale ancestors every time; the pass fixes the inversion (0→1) — the suppression half.
- The span guard is a hard assert in the runner: suppression may never cost unsuperseded span recall. It held at 1.0 in every arm.
- Distractor count is unchanged by design (lossless demotion, not deletion); what changes is *position*, which is what the placebo manipulated.

## Honest assessment

- **The bead's primary metric is hallucination, and it is not measured here.** The placebo established the causal upper bound; this bench establishes the mechanism produces exactly the context shape the placebo showed is safe (head present, above stale). Whether the LLM answerer's hallucination actually drops is the arm gated on `ANTHROPIC_API_KEY` — these candidate sets are its input. The default stays off until that run decides.
- The synthetic corpus is constructed to exhibit the inversion; the numbers validate the instrument and mechanism, not field prevalence. On a real native vault the effect size depends on how many superseded chains exist and how often ancestors outrank heads.
- Position-vs-presence: demotion moves stale docs to the tail but still serves them. If the LLM arm shows tail-position stale docs still induce hallucination, the next experiment is an `exclude` variant — deliberately not built until the lossless version is measured.

## What ships from this

- Mechanism config-gated off; unit + integration tests (pass semantics, gate default, chain edge cases, `vault_search` end-to-end inversion fix).
- Bench committed and reproducible: `node gen-supersession-vault.mjs && node suppression-bench.mjs`.
- MAV-161 stays open on the hallucination arm; the deterministic prerequisites are done.
