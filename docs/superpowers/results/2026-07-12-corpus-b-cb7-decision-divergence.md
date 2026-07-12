# Corpus (B) CB7 — Decision divergence: a held tension changes the action

**Date:** 2026-07-12
**Spec:** `docs/superpowers/specs/2026-07-11-corpus-b-cb7-decision-divergence-design.md`
(including the gate v2/v2.1 amendments)
**Models:** panel = `anthropic/claude-haiku-4.5`, `z-ai/glm-4.6`, `openai/gpt-4o`
(temp 0, via OpenRouter); gate second-rater = `google/gemini-2.5-flash`.
One run, 270 decision calls + 12 gate calls, ~$4.

**Verdict: WIN — the manifesto's kill condition fails to fire.** Memory
representation alone changes the decision on **15/18** tension presentations
(per-model majorities: Haiku 5/6, GLM-4.6 6/6, GPT-4o 4/6). Handed the held
tension, every model escalates on every tension (**18/18**); handed a
collapsed single value, models commit a unilateral wording **15/18** — they
cannot escalate for the right reason because their memory carries no signal
the topic is contested. And the win is not bought with hedging: the held
condition over-escalates on settled controls LESS than the collapsed one
(**1/18 vs 3/18**). Holding the tension changes the decision; non-collapse is
load-bearing, measured — not a philosophical luxury.

## Setup

45 instances (6 CB6 second-rater-gated tensions · 6 settled controls from the
Trump box's supersession chains · 33 CO2 scorable stale traps), each presented
twice per model — **M-collapsed** (one plain value: the challenger position
for tensions, the stream-latest stale text for traps, the governing text for
settled) vs **M-held** (the vault surface: both positions + tension record,
or governing value + supersession note). Task text byte-identical across
conditions (hermetically tested); closed decision enum
(`apply_A`/`apply_B`/`hold_escalate`), scored deterministically — no LLM
judge on any primary metric. Materials passed gate v2.1 (apparatus scan
0/90; per-arm rater watermark check 0 tension / 0 settled) after two gate
iterations that caught real differential leakage — see the spec amendments.

## Results

### T1 — tensions (the keystone rung, n = 6 × 3 models)

| | Haiku | GLM-4.6 | GPT-4o | pooled |
|---|---|---|---|---|
| **decision divergence** (collapsed ≠ held) | 5/6 | 6/6 | 4/6 | **15/18** |

| condition | correct (= hold_escalate) |
|---|---|
| **held** | **18/18** |
| collapsed | 3/18 |

The arithmetic ties out exactly (verified against the per-row dump): held
escalates 18/18, so every non-diverged pair is a case where collapsed ALSO
escalated — and there are 3 of those (Haiku on Trump #48; GPT-4o on Trump
#48 and #65, both conditions `hold_escalate`), which are precisely the 3
correct collapsed decisions. The remaining 15 collapsed decisions committed a
unilateral wording on a genuinely contested topic — the CB6 masquerade,
acted on. GPT-4o being the model that occasionally escalates without the
tension record repeats CB6's finding: a careful model's restraint is
contingent; the held condition's restraint is architectural (18/18 across
the panel).

### T2 — settled controls (the hedge tax, n = 6 × 3 models)

| condition | correct (= apply governing) | escalated |
|---|---|---|
| **held** | **17/18** | **1/18** |
| collapsed | 11/18 | 3/18 |

No decisiveness tax — the held condition hedges *less* than collapsed, and
executes better (17/18 vs 11/18; collapsed produced 4 wrong-side applies
despite holding the governing value). The supersession note appears to help
the model bind its memory to the right presented wording — an unanticipated
bonus, in the same direction as the thesis. Divergence on settled: 7/18
pooled (Haiku 3, GLM 1, GPT-4o 3), predominantly held-fixes-collapsed-error.

### T3 — stale-trap propagation (secondary, n = 33 × 3 models)

| condition | correct (= commit governing) |
|---|---|
| **held** | **94/97** (2 unparseable, recorded not coerced) |
| collapsed | 2/99 |

Divergence 90/95 pooled (30/32, 31/31, 29/32). As the spec predicted, this
rung was near-determined by CO2/Arm B — it converts "the memory hands back
the stale value" into "the agent commits the stale value into a dependent
document," at decision level, 97% of the time.

## Reading

- **The kill condition had two flavors; neither fired.** (a) "Models escalate
  on tension topics regardless of memory" — no: collapsed escalated only
  3/18. (b) "Models act unilaterally even when handed the tension" — no:
  held escalated 18/18. The decision sits where the thesis says it sits: in
  the memory representation.
- **The full chain is now measured end to end.** CO2: the stream hands back
  stale values (33/33). Arm B: LLM consolidation inherits it (20/33). CB6: a
  single-value memory masquerades tensions as supersessions (17/18). CB7:
  and the agent then *acts* on the masquerade (15/18) — unless the memory
  holds the tension, in which case it escalates (18/18) without over-hedging
  where things are settled (1/18). Answer-level failure was already
  established; this is the decision-level rung the manifesto's kill
  condition demanded.
- **On this corpus, escalation is the empirically correct act** — the CO1
  reverts are what happens to unilateral edits against no-consensus items.
  `hold_escalate` is not a daftari-flattering convention.

## Honest precision

- **n = 6 on the keystone bucket** (the full active no-consensus yield of
  every article that maintains a consensus box). The divergence direction is
  consistent across all three models; the percentages should not be quoted
  without the n.
- **One run at temp 0**; CB6 showed run-to-run wobble in abstain-adjacent
  numbers. The 18/18 held-side result and the 15/18 divergence direction are
  the findings; individual cells may wobble.
- **M-collapsed for tensions holds the challenger position** (recency /
  last-write-wins) — a recorded deviation from the spec's CB6-foil-verdict
  plan (never committed as a fixture; recency is deterministic and matches
  the Arm A `@before` failure shape). A collapsed memory holding the STATUS
  QUO on a tension would sometimes accidentally match the passage — but the
  masquerade error is direction-agnostic per CB6, and the challenger is what
  the real stream's last write actually is.
- **Memory blocks are oracle-shaped** (built from the box/CB6 pairs, not
  acquired by a live daftari vault) — consistent with the CO3 oracle posture:
  the *representation contract* is what ships; CB4/CB5 already established
  the acquisition honest-headline separately.
- **2/270 unparseable responses** (GLM-4.6 returned empty strings on two
  held-condition traps), excluded pairwise from divergence, reported, never
  coerced.
- Two gate iterations were needed before the run was valid (settled-arm
  apparatus watermark; then residual cross-refs/moratoria + a rater question
  that over-triggered on constant topic contested-ness). Both failures and
  fixes are recorded as spec amendments; the run reported here is the first
  and only full run.
- Per-row detail lives in the runner's local `.cb7-out/cb7-rows.json`
  (gitignored by design — this note is the durable artifact; the run is
  reproducible from the committed fixtures for ~$4).

## For the paper

CB7 closes the two-corpus paper's answer→decision gap and completes the §6.1
spine: recency fails (CO2) → consolidation inherits it (Arm B) → single-value
memory masquerades tensions (CB6) → **and the agent acts on the masquerade
unless the memory holds the tension (CB7: 15/18 divergence, 18/18 held
calibration, 1/18 hedge tax)**. The Honest Assessment's kill condition was
put to its test and survived; the gated positioning claims (decision-level
value of non-collapse) are now evidence-backed at small, stated n.
