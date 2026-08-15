# Kickoff — run Experiment #1 (Information-vs-Priors Discriminator) in a fresh session

**Purpose.** Cold-start brief so a new session can execute Experiment #1 — the
cheapest falsifier of the Daftari cortex trust thesis — with no context from the
session that designed it. Point a fresh `claude` (in this repo) at this file.

---

## What this experiment decides (one paragraph)

Daftari's moat is "trust = survived independent re-derivations." That only holds if
re-derivation re-evaluates a claim **against the premise it is given** (information-
driven) rather than **re-running the model's priors** (prior-driven). If it's
prior-driven, the strength signal is corpus-consensus theater and the moat inverts to
ElephantBroker's accumulation model. This experiment measures which — by feeding the
re-derivation **true vs. contradictory premises** and seeing whether the verdict flips.
It needs **no consolidation loop** and can falsify the vision before Stage 1 is built.

## Read first (committed, in this repo)

1. `docs/superpowers/specs/2026-06-13-exp1-information-vs-priors-protocol.md` — **the
   pre-registered protocol; the source of truth.** §4 claim set, §5 procedure, §6
   measures, §7 FROZEN decision thresholds, §8 confounds/controls.
2. `docs/superpowers/drafts/2026-06-13-rigorous-memory-landscape-research.md` — the
   pressure-test section (why this experiment, the kill condition, ElephantBroker as
   the baseline).
3. `docs/superpowers/specs/2026-06-13-cortex-consolidation-loop.md` — what `derives_from`
   re-derivation actually is (the operation under test = Component A's pass).

## The three inputs the human must supply (fill before kickoff)

1. **Claim set — the real work, not the harness.** §4 needs ≥120 `derives_from` edges,
   ≥15 per (prior × domain) cell, **including contamination-free novel/interpretive
   edges** (Daftari's actual domain). Either provide a labeled set, or have the session
   co-construct it: mine real candidate edges from a vault + hand-build the contrarian /
   prior-disfavored ones. **Source:** "co-construct with me".
2. **Models — ≥3 distinct families** (the only axis that truly decorrelates priors; two
   snapshots of one model do NOT count). ‹FILL — e.g. claude-opus-4-8 + an OpenAI model
   + an open model (Qwen/Llama) via ‹provider››. Keys in env: ‹FILL›.
3. **Output location:** `docs/superpowers/drafts/2026-06-13-exp1-results.md` (raw
   results + analysis + the PASS/FAIL/PARTIAL verdict).

## What the session should do

1. Read the three docs above. Confirm the §7 thresholds are treated as **frozen** —
   do not move them after seeing data (this is a pre-registration).
2. **Build the claim set first** (§4), and **confirm it with the human before spending
   any model calls.** Implement the §4 controls, not just the happy path: positive
   control (trivial entailment must flip C1→C3), negative control (true non-edges, catch
   yes-bias), flip-validation (C3 premise must be coherent AND genuinely contradictory —
   reject garbage flips), and the 40–60 ambiguous-prior discard.
3. Build a small **uv/Python harness** executing §5: for each edge, blind, elicit a
   0–100 confidence + binary survives/fails under **C2 prior-only / C1 true-premise /
   C3 flipped-premise**, across the ≥3 model families, ≥3 repeats (vary prompt framing
   per repeat). ~3,200 calls total (§9).
4. Compute the §6 measures: information sensitivity (mean conf C1−C3), flip rate, the
   mixed-effects decomposition `confidence ~ premise_validity + prior_congruence +
   domain + …` (β-premise vs β-prior is the answer), the axis-prior tell (do models
   agree more in C2 than C1/C3?), and the conventionality-bias FN rate.
5. Apply the **§7 frozen decision rules** and render the verdict:
   - **PASS** (IS ≥ 40, flip ≥ 70%, β-premise > β-prior, holds in ≥2 families, controls
     clean) → strength is a real longitudinal-robustness signal; proceed to Exp #2/#3 and
     build the loop (Stage 1 plan: `docs/superpowers/plans/2026-06-13-cortex-loop-stage1-scheduler.md`).
   - **FAIL** (IS < 20, or flip < 50%, or prior-dominated, or models agree more in C2)
     → moat inverts; STOP and re-architect the trust model (see protocol §10).
   - **PARTIAL** (passes novel but fails public, or high conventionality-bias FN) →
     domain-limited thesis; `vault_ratify` backstop is mandatory; write that into the
     loop spec's envelope section.
6. Write everything to the results draft (§3 output).

## Honesty flag

The harness is a day; **the claim set IS the experiment.** A weak set (no real
prior–premise divergence, or contaminated "novel" claims) yields a confident but
meaningless verdict. Spend the early effort there. Contamination control: the
novel/interpretive stratum must be genuinely outside training data (post-cutoff or
proprietary) — see the paper-feasibility memo's contamination strategy.

## Prereqs

`uv` installed; API keys for the ≥3 model families in env; ~3,200-call budget.
