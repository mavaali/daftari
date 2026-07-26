# Independence-aware edge promotion — design

2026-07-26. Status: **proposed — awaiting Mihir's review; implementation not started.**

Companion spec (same date): `2026-07-26-risk-triaged-ratification-design.md` — this spec
produces a **needs-review** stream; that spec decides how the stream is ranked and drained.

## Why

The strength model's whole claim is that trust is *earned by independent re-derivation*:
`S = min(k_survived, K_max) × (1/2)^(Δt/90d)`, recomputed from the trail on every read,
never stored (`agedStrength`, `src/curation/edges.ts:193`). What makes a vote count as
independent today is an **axis attestation**: a blind re-derivation that claims to have
varied one of `prompt | input-neighborhood | model` qualifies (`collapse`,
`src/curation/edges.ts:392-409`), and a replayed `(observer, axis)` pair recounts only
after `EDGE_REPLAY_GAP_DAYS` (edges.ts:314-323 — which admits, in its own trust-boundary
comment, that `blind` and `axis` are *unverifiable attestations* the store cannot check).

Axis variation is a **proxy** for independence, and the shipped loop shows how weak a
proxy it is:

1. **The recorded axes are not the varied axes.** The revision panel labels its
   surviving votes with *round-robin* store axes — `EDGE_AXES[i % EDGE_AXES.length]`
   (`src/consolidate/revision.ts:330`) — chosen to dodge the replay guard, not to record
   what varied. Every vote in a panel runs on the **same model** (`opts.model`), under the
   **same principal** (`CONSOLIDATE_AGENT`), over the **same two truncated endpoint
   texts** (`loadDoc` + `MAX_DOC_CHARS=1500`, revision.ts:181-208). Yet the trail records
   `prompt`, `input-neighborhood`, `model` as if three axes were exercised.
2. **The one axis actually varied no longer varies.** The prompt-framing templates
   (`forward | reverse | contrast`) were the v1 decorrelation bet, and the decorrelation
   verdict measured their lift at ~0 — `src/consolidate/constants.ts:63-68` records that
   under the foundational-ordering prompt the templates send effectively identical
   deterministic prompts. So a panel of M=2 votes can be **one observation wearing two
   hats**, and the store counts k += 2.
3. **Even honestly-varied axes don't certify independence.** Two derivations by two
   different models that both read the same upstream source doc, or retrieved through the
   same embedding neighborhood, are correlated evidence — they share the failure mode of
   that source. Axis variation cannot see this at all, because the trail never records
   *what was read*.

External evidence says this is the failure mode that matters. GovMem (arXiv 2607.02579,
July 2026) shows that repeated observations across agent traces are **not** independent
evidence — the same claim copied from a shared source, induced by a shared prompt, stale
under a new environment, or valid only in a narrower scope — and that dependency-aware
promotion with three outcomes (promote / reject / needs-review) cut false promotion from
**0.371 to 0.032** at a **0.692 review burden**. The broader Hindsight-era consensus
(2026) is the same shape: consolidation quality, not retrieval, is the unsolved axis.
Daftari's moat is the curation loop; a k-counter that can be pumped by one correlated
panel is the moat's soft spot.

This spec makes the trail record the *evidence fingerprint* of each vote, derives an
**effective k** from equivalence classes over that fingerprint, and adds a third verdict
— **needs-review** — for edges that survive re-derivation only on correlated evidence.
Everything ships shadowed first, per the two-gate-envelope precedent.

## Decision 1 — record the evidence fingerprint per attestation (additive, JSONL)

Each `observe` record in `.daftari/edges.jsonl` gains one optional field:

```json
{ "kind": "observe", "from": "...", "to": "...", "at": "...", "by": "...",
  "blind": true, "axis": "prompt", "premiseVote": "to",
  "fp": { "inputs": "<sha256>", "principal": "agent:curation-loop",
          "model": "claude-haiku-4-5-20251001", "prompt": "revision/forward" } }
```

- **`inputs`** — sha256 over the sorted `(path, content-hash)` set of documents whose
  text was actually read into the vote's context. For revision that is the two truncated
  endpoint bodies; for birth it is the doc plus the retrieved neighbor. This is the
  retrieval-neighborhood fingerprint: two votes that read the same bytes share it.
- **`principal`** — the authenticated RBAC principal (the §11.6 identity, not the
  free-text `agent` claim).
- **`model`** — the model id the vote ran on.
- **`prompt`** — the prompt-template id (e.g. `revision/forward`), replacing the
  round-robin fiction with what actually ran.

Properties, in the house grain:

- **Additive, no schema break.** `RawEdgeRecord` (edges.ts:202) gains `fp?`; old lines
  remain valid and collapse exactly as before until Decision 2 activates. The JSONL stays
  append-only and canonical; the `derives_from_edges` table stays a derived cache.
- **Attestation, not verification.** Like `blind`/`axis`, `fp` is written by the loop and
  trusted at the store boundary — the store's job is deterministic collapse, the loop's
  job is honest recording (same trust split edges.ts:313-323 already declares). The
  difference is that `fp.inputs` is *mechanically computed* from the bytes the prompt
  builder consumed, so the loop cannot honestly vary it without varying the evidence.
- **Strength recomputation simply gains inputs.** Nothing about the
  from-trail-on-every-read model changes; `collapse` accumulates fingerprints per cycle
  the way it accumulates `votedPairs` and `premiseVotes` today, and resets them on
  re-seed after a contest.
- A missing `fp`, or a missing component, is recorded as the sentinel class `∅` (see
  Decision 2 for how `∅` scores). No backfill of historical lines — the log is
  append-only and history is not rewritten.

## Decision 2 — effective k: discount correlated votes, never discard them

At collapse time, the cycle's *counted* votes (those that passed the existing
blind/axis/replay gates — the replay guard stays; it is the temporal anti-cramming guard,
this is the evidential guard, and they cover disjoint hazards) are partitioned into
**equivalence classes**: two votes share a class iff they agree on **all** of
`(inputs, principal, model)`. `prompt` is deliberately excluded from the class key — the
decorrelation verdict showed prompt framing alone does not decorrelate, so a prompt-only
variation never buys a fresh class. Missing components are the sentinel `∅`, and `∅`
matches only `∅` — so an all-legacy trail collapses to a single class (conservative: votes
that cannot demonstrate independence do not get credit for it).

Within a class, repeated votes are worth geometrically less. With correlation discount
`EDGE_INDEPENDENCE_RHO = 0.5` (provisional — calibration constant, same posture as
`EDGE_K_CAP`):

```
k_eff  =  Σ_classes  Σ_{j=1..|class|}  ρ^(j−1)
       =  Σ_classes  (2 − 2^(1−|class|))          [at ρ = 1/2]

S      =  min(k_eff, K_max) × (1/2)^(Δt / 90d)
```

- **Discounted, not discarded.** A second correlated vote still adds 0.5, a third 0.25 —
  correlated evidence is weak evidence, not zero evidence. Five fully-independent votes
  still reach `k_eff = 5`; five copies of one observation asymptote at 2, permanently
  below today's trigger threshold behavior for a saturated edge (`k=5` holds ~300d;
  `k_eff≈2` holds ~180d) and never able to fake saturation.
- **Deterministic and derived.** `k_eff` is a pure function of the trail, recomputed at
  every collapse, never stored — exactly the `S` discipline. The materialized row carries
  it the way it carries `k_survived` today (frozen at `last_age_decay`, recomputed live
  by readers).
- **The clock is unchanged.** `last_rederived` still resets on any counted vote,
  including a correlated one at cap — a correlated re-test is still a real re-test for
  *freshness*; it just doesn't manufacture *breadth*.
- `EDGE_TRIGGER_STRENGTH = 0.5` is unchanged; whether it needs retuning against the
  compressed `k_eff` range is a Decision 4 calibration question, not a guess made here.

## Decision 3 — three-way verdict in `--mode revision`: the needs-review outcome

Today the panel aggregates to `survives | fails | tie | no-vote | gated`
(`RevisionDecision`, revision.ts:70). This spec splits *survives* on independence:

- **survives-independent** — the panel's majority survives **and** at least one surviving
  vote opens a new equivalence class against the edge's existing cycle trail (its class
  key is not already present). → accrue: apply the observes, exactly today's path.
- **fails** — unchanged: majority-fails → one `vault_edge_contest`, revoke + tension.
- **correlated-only survival** — the majority survives but **every** surviving vote lands
  in an already-present class (marginal `k_eff` gain below
  `EDGE_NEEDS_REVIEW_MIN_GAIN = 0.5`, i.e. not even one half-fresh vote). → **needs-review**:
  apply **no observes**, and surface for human adjudication.

How needs-review surfaces — argued, not defaulted: the staged-action kinds
(`promote | deprecate | supersede | merge | confidence-up | write`,
`src/curation/staged-actions.ts:49`) are all *dispatchable write verbs* — ratifying one
fires a write tool. "This edge's survival is correlated; find independent evidence or
contest it" dispatches nothing; wedging it into the queue would give `vault_ratify` a
verb with no effect. So needs-review is **not a staged action**. It is an **interpretive
tension** (`TENSION_KINDS`, `src/curation/tension.ts:36`) logged against the edge's
dependent endpoint, titled `correlated-only survival: <from> derives_from <to>`, carrying
the class breakdown in the body. That reuses three shipped guarantees for free: the
tension-respect invariant blocks further auto-action on the doc, the Stage 3 closure
gates resolution on `canRatify` so the loop cannot dismiss its own doubt, and the tension
is the operator's normal inbox. The revision trace records `decision: "needs-review"`
alongside the class keys, so the recall@K evaluator and the calibration reads see it.

Resolution paths for the human: supply a genuinely independent re-derivation (different
model, principal, or inputs — one MCP `vault_edge_observe` with a fresh fingerprint), or
contest the edge, then resolve the tension. Advisory house rule holds throughout: the
loop reports the doubt; it does not act on it.

## Decision 4 — calibration first: ship shadowed, graduate on stated criteria

Precedent is the two-gate envelope: wired live but shadowed, verdicts journaled to
`.daftari/shadow-actions.jsonl`, surfaced in `vault_lint`'s calibration section, enacted
only after graduation (architecture.md, Stage 3). Independence follows the same road:

- **Shadow posture.** Live `S` keeps using raw `k_survived`; live revision keeps the
  two-way verdict. At every collapse the store *additionally* computes `k_eff`/`S_indep`,
  and each revision panel journals one row to `.daftari/independence-shadow.jsonl`
  (its own file — `coverage.ts` already filters `shadow-actions.jsonl` by action kind,
  and this stream is per-collapse, not per-do()): edge key, `k`, `k_eff`, both
  strengths, class breakdown, and the would-be verdict
  (`would_accrue | would_needs_review`).
- **Lint surface.** `vault_lint` gains an `independenceCalibration` section beside the
  existing would-gate and envelope-gated views: the k vs k_eff distribution, the count of
  edges that would drop below trigger-bearing, the would-be needs-review rate, and the
  legacy-∅ fraction (how much of the graph is un-fingerprinted and therefore
  single-class).
- **Graduation criterion (stated now, judged then):** after one full quarterly
  re-calibration window of shadow data, graduate iff (a) the would-be needs-review rate
  is stable and the triage queue can drain it (Decision 5), (b) a hand audit of 20
  would-be-demoted edges finds a majority genuinely correlated (the discount is catching
  real correlation, not punishing honest variation), and (c) `ρ`, the class-key component
  set, and `EDGE_NEEDS_REVIEW_MIN_GAIN` survived the window without retuning. Miss any of
  the three → recalibrate and re-shadow; never graduate a discount that would silently
  demote edges nobody has looked at.

## Decision 5 — review-burden honesty

GovMem's number cuts both ways and the spec states both halves: false promotion fell
0.371 → 0.032 **at a 0.692 review burden**. Needs-review is not free — it converts silent
false strength into visible operator work, and a vault that emits an unranked pile of
"please re-adjudicate this edge" tensions will train its operator to ignore them, which
is worse than the proxy we started with.

So the needs-review stream lands **triaged, not raw**: the same-day companion spec
(`2026-07-26-risk-triaged-ratification-design.md`) owns ranking the human queue by risk
(blast radius, trigger-bearing status, downstream conditioning), and needs-review
tensions enter that queue as inputs, so operator attention lands on high-blast correlated
edges first and a zero-blast periphery edge waits without harm. Two honesty mechanics on
top: `daftari consolidate`'s exit report gains a `needs_review_emitted` count beside
`staged`/`surfaced` (the burden is measured every session, not discovered at quarter
end), and the Stage 4 coverage-equity ratchets are the backstop — if needs-review volume
starves the periphery slice or skews the action mix, the monitor says so before
graduation, not after.

## Out of scope

- **Cross-vault evidence.** Independence is judged within one vault's trail; correlating
  observations across vaults (or against a shared upstream corpus) is not attempted.
- **LLM-judged independence.** No model is asked "were these two derivations
  independent?" — the fingerprint is mechanical (hashes, ids) or it is not recorded.
  A judged-independence axis would reintroduce the unverifiable-attestation problem this
  spec exists to close.
- **Re-weighting the birth path.** Birth still seeds `k=0` candidates; fingerprints are
  recorded from day one, but no birth-time independence verdict exists (a seed has no
  trail to correlate against).
- **Retuning `EDGE_TRIGGER_STRENGTH`, `K_CAP`, or the half-life.** Decision 4's shadow
  window may motivate it; this spec does not pre-decide it.

## Kill condition

Two, one per gamble:

1. **The discount doesn't discriminate.** If the Decision 4 hand audit finds that fewer
   than half of the would-be-demoted edges are genuinely correlated evidence — i.e. the
   equivalence classes are punishing honest independent work because the class key is too
   coarse (`inputs` hashing truncated text makes distinct readings collide, or one
   principal/model legitimately dominates a small vault) — the class-key design is wrong.
   Recalibrate the component set once; if the second window fails the same audit, kill
   the discount and keep only Decision 1's recording (the fingerprint trail remains
   valuable as provenance even if the scoring dies).
2. **The burden drowns the operator.** If, across a shadow quarter, the would-be
   needs-review rate exceeds what the risk-triaged queue demonstrably drains (companion
   spec's throughput measurement) — Daftari's analogue of GovMem's 0.692 arriving without
   GovMem's reviewer pool — then three-way promotion is unaffordable at this vault's
   scale: kill Decision 3's needs-review outcome, fold correlated-only survival into a
   lint counter (visible, aggregate, zero per-edge burden), and keep Decisions 1–2, which
   cost the operator nothing.
