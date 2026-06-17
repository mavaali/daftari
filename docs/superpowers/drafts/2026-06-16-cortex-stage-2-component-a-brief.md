# Build brief — Stage 2: Component A's two modes (shadow-only)

**Branch:** `feat/cortex-loop-stage2`
**PR title:** `feat(consolidate): cortex loop Stage 2 — Component A birth + revision (shadow-only)`
**Base off `origin/main`** after #135 merges (Stage 1 + the spec). Spec is current:
the §12 Stage 1 description was edited to drop the stale `vault_tension_blast`
reference; that edit lands with #135.

## Why

Stage 2 is **Component A**: the actor that consumes Stage 1's two queues and
re-derives. Spec §4 covers it; §12 stages the build. Two modes:

- **Birth** (one-time per unprocessed doc) seeds `k=0` edges from
  `vault_search_related` neighbors.
- **Revision** (per due edge from Stage 1's queue) casts an M-vote panel that
  emits `edge_observe` / `edge_contest` / `vault_stage_action`.

Everything routes through `shadow_mode` (§11.5) so writes are journaled, not
applied — this is the stage that **starts the calibration data flow** (§10)
without graduating any auto-write tier.

It's also the **first loop stage that calls an LLM**. Stage 2 wires the client,
the per-vote varied-axis machinery, and the recall@20 trace — it does **not**
ship the recall-set evaluator (Stage 6) or the envelope's two-gate enforcement
(Stage 3).

**The load-bearing claim Stage 2 must verify.** The loop's trust accrual hinges
on votes being **independent**. `edges.ts` itself flags that `blind` and `axis`
are unverifiable attestations and that enforcement is the loop's job. Picking a
varied axis that is *easy to measure* (prompt-framing variants) is not the same
as picking one that *actually decorrelates verdicts*. Stage 2 therefore ships
both the varied-axis machinery **and** a measurement that decides whether the
axes are doing real work — otherwise the loop reproduces the same failure mode
the design rejects in popularity-ranked systems: **choosing the convenient
measurable instead of the right one.**

## What this builds

1. **Birth mode** (§4.0). New code path inside `daftari consolidate`. For each
   doc on Stage 1's unprocessed-doc birth queue:
   - `vault_search_related(doc.path, k=20)` → top-K embedding neighbors.
   - Per neighbor: LLM re-derives direction (does the doc's claim derive
     from / depend on the neighbor's claim?) under one chosen axis.
   - Survivors → `vault_edge_observe(from, to, observer=agent:curation-loop,
     blind=true, varied_axis=…)` → seeds `k=0` candidates.
   - Top-20 list + per-neighbor outcome logged to
     `.daftari/birth-trace.jsonl` for post-hoc recall@20 evaluation (the
     evaluator itself is Stage 6).
   - `consolidate-state.json` advances birth-processed hashes (canonical path +
     content hash) per Stage 1's convention; an edited doc re-births.

2. **Revision mode** (§4.1). New code path consuming Stage 1's edge due-queue.
   For each due edge:
   - Cast a **panel of M votes** (M = `PANEL_SIZE`, starting M=2; **`TBD —
     calibrate from shadow data`**).
   - Each vote picks a distinct `(observer, axis)` pair so §11.3's replay gap
     counts the votes as independent in one sitting; a repeated pair is
     replay-guarded for `EDGE_REPLAY_GAP_DAYS`.
   - Per-vote input is the generation-effect contract: `vault_read`'s **decay +
     validation report for both endpoints + the existing tension trail**. Raw
     doc bodies are not re-read verbatim (copying = cramming = correlated
     error).
   - Per-vote output: survives → `edge_observe`; fails-case-2 →
     `edge_contest(reason)`; fails-case-1 (endpoint changed) → no penalty
     (already handled by C's event clock).
   - Panel stop: M votes cast **OR** compute budget exhausted.

3. **Varied-axis machinery (v1 = prompt-framing, with a verification gate).**
   §4.1 names three candidate axes: prompt-framing, input-neighborhood, or
   model. v1 picks **prompt-framing as the starting axis** because it's
   deterministic, zero extra LLM cost, and zero model-routing dep — 2–3
   prompt templates (forward "does premise derive conclusion?", reverse
   "does conclusion depend on premise?", contrast "find the dependency if
   any"). **But "easy to measure" isn't "actually independent"** — that's the
   unverifiable-attestation gap `edges.ts` flags. v1 ships the prompt-framing
   axis **and** the verification measurement (item 8 below); the latter
   decides whether prompt-framing alone is enough or multi-model must land
   inside Stage 2. Per-vote axis recorded in the `edge_observe` /
   `edge_contest` `varied_axis` field.

4. **LLM client wiring.** Reuse the existing client surface from
   `daftari eval` (1.16.0). If `eval` calls the provider directly, factor a
   shared `src/llm/client.ts` so the surface is one. Model + API key from env
   / config (same convention as eval). Retry/backoff: existing pattern.
   Per-call cost + tokens logged into the shadow journal alongside
   `{i_base, blast, impact, …}` so calibration (§10) can attribute compute.

5. **Shadow-mode integration (§11.5).** All Stage 2 writes (`edge_observe`,
   `edge_contest`, `stage_action`) route through the shipped `shadow_mode`
   posture — no fork of the write path. Verification: in `shadow_mode: true`,
   the shadow journal lands one record per would-be write with
   `{i_base, blast, impact, budget, spent_before, would_gate, diff}`, and the
   edge store does **not** advance.

6. **CLI surface.** Extend `daftari consolidate`:
   - `--mode=birth|revision|both` (default `both`).
   - `--max-panels=N` (debug; caps panels per session).
   - `--max-births=N` (debug; caps birth-mode docs per session).
   - Report extends Stage 1's with `{birth_processed, panels_cast, votes_cast,
     llm_cost_usd, llm_tokens}`. Non-zero exit if any LLM call errored hard
     (so a cron wrapper can alert on a broken pipe).

7. **Tests (test-first, per §12 ritual).**
   - **Birth**: fixture vault with N unprocessed docs + a stubbed
     `vault_search_related` returning canned neighbors + a stubbed LLM
     returning canned verdicts → assert `edge_observe` fires per survivor and
     `birth-trace.jsonl` lands the top-20 per doc.
   - **Revision**: fixture due queue (1 edge) + stub LLM returning
     `survives / fails-case-1 / fails-case-2` deterministically → assert the
     right tool fires per outcome; panel terminates at M votes.
   - **Varied-axis**: assert M votes within a session use distinct
     `(observer, axis)` pairs (regression for the §11.3 replay-gap rule).
   - **Shadow mode**: assert in `shadow_mode: true`, no real edge writes
     land; the shadow journal carries one record per would-be write.
   - **LLM client**: contract test against a recorded transcript (mock only —
     no live LLM in CI).
   - **Path canonicalization**: assert birth + revision both canonicalize
     endpoints at the boundary (memory `canonicalize-path-keys` — already
     bit twice; mandatory).

8. **Axis-decorrelation report — the v1 verification gate.** A controlled
   fixture (`tests/fixtures/decorrelation-fixture.json`) of synthetic edges
   with **known ground-truth derivation verdicts** — small (~50 edges),
   hand-built, balanced across the three §10.3 edge classes (forward-temporal
   / backward-causal / symmetric). The Stage 2 harness runs an M-vote panel
   against each fixture edge under each prompt template and reports four
   numbers:
   - **Single-vote accuracy** (per axis): each prompt template alone vs
     ground truth.
   - **Majority-vote accuracy** (across axes): does the panel beat its best
     single axis? This is the wisdom-of-crowds signal — if the axes are
     genuinely decorrelating, majority should beat max(single).
   - **Inter-axis agreement rate**: how often do the axes return the same
     verdict on the same edge?
   - **Error correlation**: when votes are wrong, are they wrong *together*
     (correlated error → axes are decorative) or *apart* (uncorrelated
     error → axes are working)?

   Shipped as `daftari consolidate --report=decorrelation
   [--fixture=path]`. **Kill condition (Stage 2's own gate):** if
   `majority_accuracy − max(single_vote_accuracy) < 0.05` on the fixture —
   the panel doesn't measurably beat its best single axis — **multi-model
   becomes a Stage 2 add-on, not a Stage 5 prerequisite.** The decision
   lands in shadow before any auto-write tier graduates. The report is also
   the empirical input for Exp #4 (see § Known gaps).

## Out of scope (deferred)

- Envelope two-gate enforcement (invariants + trust budget) — **Stage 3**.
- `decided_by_principal` on staged-action decisions + contest tensions;
  gating `vault_tension_resolve` on `canRatify` for loop tensions — Stage 3
  (§5.4 v1 closure).
- B coverage/equity instrumentation — **Stage 4**.
- Calibration of `PANEL_SIZE`, prompt templates, slice fractions — **Stage 5**.
- Recall set + recall@20 evaluator — **Stage 6** (gated on the second rater).
- Auto-write graduation — Stage 5.
- Input-neighborhood as a varied axis — v1.5.
- **Multi-model is conditional, not deferred-by-default.** If the Stage 2
  axis-decorrelation report (item 8) clears the kill condition, multi-model
  defers to v1.5; if it fires, multi-model lands inside Stage 2 before any
  graduation. The decision is data-driven, not a hand-wave.
- Multi-action passes — v2.
- Live event-hook — v2.

## Known gaps accepted in v1 (written, not hidden)

- **`PANEL_SIZE` and prompt templates are placeholders**, calibrated from
  shadow data in Stage 5. Shipped values (M=2; 3 prompt templates) are
  starting shapes, tracked in `src/consolidate/constants.ts` alongside Stage
  1's. Never invented; marked `TBD — calibrate from shadow data`.
- **Recall@20 is logged, not enforced.** The §10.2 kill condition (`recall@20
  ≥ 0.70`) needs labeled neighbors — those arrive with the recall set in
  Stage 6. Stage 2 ships the *trace* so post-hoc evaluation is possible the
  moment labels exist. Until then, **no birth-mode coverage claim is
  paper-grade.**
- **LLM cost is real, calibration data is small.** Birth on a 1000-doc vault
  is 1000 × 20 = 20k re-derivations; revision adds ~2× edges-due per
  session. Shadow mode bounds writes — not LLM bill. Per-session caps live
  in `consolidate-state.json` and default conservative; **PR description
  must surface the expected per-session cost** so the merge is an explicit
  cost-awareness step.
- **Prompt-framing-only as the varied axis is provisional, and Stage 2
  itself decides whether it survives.** Same shape as the broader
  unverifiable-attestation gap: an easy-to-measure axis selected because
  it's *available*, with no a priori reason to believe it actually
  decorrelates verdicts. The item-8 decorrelation report is the verification
  gate — if it fires, multi-model lands inside Stage 2, not Stage 5. The
  independence question doesn't survive promotion to "v1.5" as a hand-wave.
- **Exp #4 (axis-decorrelation as a standalone empirical question) does not
  exist yet and should.** The item-8 report is the in-loop measurement
  against a small fixture; Exp #4 is the paper-grade version — larger
  labeled fixture, formal protocol, three edge classes balanced, multiple
  model families, reportable κ + correlation matrices. Without Exp #4 the
  loop ships with no published independence evidence; the comparison to
  popularity-as-authority systems lands only on the design layer. **Named
  here as a missing experiment in the paper portfolio**, alongside the §6.1
  efficacy ablation and the second-rater-gated recall set.
- **Birth backlog drains across sessions** per Stage 1's birth-slice
  convention. A fresh 1000-doc vault may take many sessions to fully birth-
  process under conservative caps. This is C-Q5 (self-paced graduation), not
  a bug — but `daftari consolidate --help` must document the expected drain
  arc so operators don't read it as a stall.

## Process notes (carried)

- **Two adversarial general-purpose reviewers** (NOT squad agents — broken
  tool bindings per memory). Stage 1 found 4 real bugs via this route; Stage
  2 is bigger (LLM calls + two modes), expect ≥ that count.
- **Path-key canonicalization at every boundary** in both modes (memory).
- **uatu hook** — switch to ask-permissions before commit-bearing work; bit
  twice this session before push.
- **Release ritual** per memory `daftari-release-ritual` (four version sites;
  `npm publish` is the user's MFA step).
