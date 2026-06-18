# Stage 2 axis-decorrelation — verdict (chunk 6 fixture + first run + chunk-7 review)

**Written:** 2026-06-16. **Branch:** `feat/cortex-loop-stage2`. **Status:** fixture
landed + first report run complete. **Headline: FAIL the kill condition — but the
raw number overstates it, and the indicated fix is NOT primarily multi-model.**

## What ran

- **Fixture:** `tests/fixtures/decorrelation-fixture.json` — 51 edges, hand-built,
  **every label cross-family-validated** (see "How the fixture was built" below):
  19 `derives` + 10 `depends` (validated derivations shown reversed) + 22 `neither`
  (co-occurrence hard negatives).
- **Report:** the real `runDecorrelation` from `src/consolidate/decorrelation.ts`,
  unchanged — its forward/reverse/contrast templates, same metrics, same 0.05 lift gate.
- **External-validity caveat (chunk-7 review, important):** `decorrelation.ts` carries
  its *own* copy of `userBody`/`SYSTEM_BASE`, which differs from the live birth panel
  (`birth.ts`) in two ways: (1) it injects `[template:…]` tags the live panel doesn't;
  (2) **bigger** — the report feeds **full content for both docs**, whereas the live
  birth panel passes the neighbor's **path only, with empty DOC B content** (cost-saving,
  `birth.ts:199`). So this report measures the templates under a *strictly richer*
  information condition than what production ships. The numbers below are valid *for the
  templates as defined in `decorrelation.ts` under full-content input*; whether the
  conclusions transfer to the path-only live panel is **unverified** and is now an owed
  item. `SYSTEM_BASE` is byte-identical to birth's; the divergence is prompt-shape +
  information condition, not the verdict-space definition.
- **Transport caveat (matters):** run via an **OpenRouter → `anthropic/claude-haiku-4.5`**
  shim (`scripts/run-decorrelation-openrouter.mjs`), because `ANTHROPIC_API_KEY` was
  not reachable from the shell; `OPENROUTER_API_KEY` was. The shim mirrors
  `createAnthropicClient.completeJson` (schema-in-system, fence-stripped parse, retry).
  Temperature = provider default (1.0), single sample per (edge, axis) — **identical to
  the canonical CLI's behavior**, including its noise. Mihir accepted this transport as
  equivalent to the canonical `daftari consolidate` path (2026-06-17), so no separate
  Anthropic-key confirmatory run is required.

## The four numbers

| metric | value | gate |
|---|---|---|
| forward single-vote accuracy | 49.0% | |
| reverse single-vote accuracy | 47.1% | |
| contrast single-vote accuracy | **68.6%** | |
| majority accuracy | 52.9% | |
| **lift over best single** | **−15.69 pp** | needs ≥ +5.0 pp → **FAIL** |
| axis agreement rate | 70.6% | |
| error correlation | 91.7% | |

## The decomposition (why the raw number misleads)

Per-axis accuracy by truth class (correct / total):

| axis | derives (19) | depends (10) | neither (22) |
|---|---|---|---|
| forward | 3/19 | **0/10** | **22/22** |
| reverse | **0/19** | 2/10 | **22/22** |
| contrast | 5/19 | 8/10 | **22/22** |

Three things fall out (all three were corrected/qualified after the chunk-7 review —
see "Review findings" below; the original draft overstated #1 and #2):

1. **No promiscuity *on this negative set* — 66/66.** Every axis called `neither` on all
   22 co-occurrence pairs. **But this claim is bounded, not universal.** The fixture's
   inclusion gate kept a negative only if *two strong models (gpt-4o, gemini) already
   called it `neither`* — which by construction excludes the borderline promiscuity-traps
   (pairs where a model might say "derives") that would catch a promiscuous panel. So
   66/66 shows Haiku is **not *more* promiscuous than the validator models on
   unambiguous negatives** — it does not show "no promiscuity anywhere." It bounds
   promiscuity from below.

2. **The directional failure is two distinct mechanisms, not one** (the draft's "entire
   failure is direction-token confusion" was wrong). Quantified over the 69 wrong
   directional votes: **~68% are direction-token flips, ~32% are "said neither."** And it
   splits cleanly by class:
   - **`derives` class: 96% direction-flips.** forward gets derives 3/19, reverse 0/19 —
     reverse echoes "depends" on 19/19 derives rows. Pure template-verb echo.
   - **`depends` class: 0% flips, 100% "said neither".** forward says neither 10/10,
     reverse 8/10 — the forward/reverse templates never state the rule "B-derives-from-A
     → depends", so the model defaults to `neither`. This is prompt *under-specification*,
     not a token flip. Evidence it's recoverable: **`contrast`, the only template that
     states the full mapping, gets depends 8/10.**

3. **That is why majority < best single.** `contrast` is the only template that spells
   out the full derives/depends/neither mapping, so it carries the signal (68.6%); the
   two template-biased axes outvote it, dragging majority to 52.9%. The 91.7% error
   correlation is forward+reverse being wrong *together* on direction.

**Direction-agnostic counterfactual** (collapse derives/depends → "a derivation exists";
computed from the same run, no new calls): forward 80.4%, reverse 84.3%, contrast 92.2%,
**majority 84.3%, lift −7.89 pp.** So even with the direction artifact removed, lift is
still negative — `contrast` dominates and the axes are correlated, not independent.

## Verdict

**FAIL is robust** — prompt-framing axes alone do not decorrelate; majority can't beat
`contrast` in either the 3-class (−15.69 pp) or direction-agnostic (−7.89 pp) framing.
The kill condition fired correctly, the metrics recompute exactly (chunk-7 Reviewer C),
and the negative lift is *systematic, not sampling noise* (reverse echoes "depends"
19/19 on derives rows; forward+reverse agree-and-are-both-wrong on 24/29 directional
rows — that is shared bias, not jitter; a re-run would not flip it).

**But the canned "multi-model must land inside Stage 2" message hides the real levers:**

- **No promiscuity was observed — but the fixture can't fully test for it** (the negative
  set was selected to exclude the hardest traps; see Review findings F1). So "don't add
  multi-model for promiscuity" is supported for the *easy* negatives, not proven for the
  hard ones.
- **A large part of the failure is a fixable prompt bug.** forward/reverse don't state
  the direction mapping; `contrast` does and nearly doubles accuracy (and recovers the
  depends class 8/10). Fix those two templates before reaching for multi-model.
- **Reconsider the `derives`/`depends` split.** Direction is mis-handled by every
  template except `contrast`, across three model families. Multi-model won't fix a
  prompt-under-specification all families share.
- **`contrast` is the best single configuration** (68.6% / 92.2%). The cheapest v1 win
  may be "make all axes contrast-style," not "add more models."

**Recommended next step (diverges from the handoff's default):** before the brief
item-4 multi-model refactor — (a) repair forward/reverse to state the direction mapping
and re-run; (b) decide whether `depends` stays a distinct verdict; (c) **re-run under the
live path-only information condition** (see What-ran external-validity caveat), since the
prompt-repair conclusion was drawn under full-content input the shipped panel doesn't
use. Multi-model remains the right move for the residual decorrelation gap, but it is the
*second* lever. The per-class decomposition is the evidence — but see the fixture-grade
caveat below before any auto-write graduation rests on these numbers.

## v2 fixture build + the direction blocker (2026-06-17)

Acting on the chunk-7 findings, a v2 fixture was built (`tests/fixtures/decorrelation-fixture-v2.json`).
Two results, one of them a **loop-design blocker**:

- **v2 core: 39 edges, 18 `derives` + 21 `neither`, all contamination-free.** Derivations
  live in *invented self-consistent micro-domains* (a fictional protocol, organism, board
  game, economy, language) so the model must reason, not recall — fixing F4. Negatives are
  synthetic co-occurrence + common-cause "trap" pairs. Every label cross-family-confirmed
  (gpt-4o + gemini, 3 samples). Survival was high (derives 18/21, negatives 21/22),
  confirming synthetic content grades cleanly.
- **~~LOOP-DESIGN BLOCKER~~ → RESOLVED: direction was a prompt-interface artifact, not a
  model limitation.** The v2 `depends` failure (gpt-4o says `depends`, gemini says `derives`
  on the same pair) first read as "the A→B vs B→A distinction is unreliable across models;
  gemini is direction-blind." **A follow-up direction-elicitation experiment (2026-06-17)
  falsified that.** The problem was the **`derives`/`depends` token**, not the models'
  ability to judge direction. Asking instead *"which of these two claims is the load-bearing
  PREMISE / would have to be established FIRST?"* (foundational-ordering), every model —
  **including the supposedly direction-blind gemini — recovers direction at ~100% accuracy,
  100% order-consistency, ~50% position-bias** (i.e., unbiased), across 30 known-direction
  pairs shown in both orders. The derives/depends-token method ("direct") trailed at 90–100%.
  So gemini understood direction all along; it just couldn't map the relation onto the
  confusable token. See the "Direction-elicitation experiment" section below. **The blocker
  dissolves**; the fix is a prompt change (foundational-ordering), not a direction redesign.
  Decision (Mihir, 2026-06-17): drop `depends`/`symmetric` from the v2 *fixture* (keeps it a
  clean 2-class promiscuity+detection set) — but direction itself is recoverable.
- **Secondary: common-cause traps did not fool the strong models.** 8 hand-built
  common-cause / co-consequence "promiscuity traps" all came back `neither` 8/8 from both
  families — so F1's deliberate-trap goal was not achievable with authorable content;
  gpt-4o/gemini robustly reject common-cause-as-derivation. (They became 8 more clean
  negatives.) Weak evidence the strong models are not very promiscuous to begin with.

## v2 re-run results (full-content vs path-only) — the sharpest findings

The v2 fixture (39 edges, derives + neither, contamination-free) was run through the real
`runDecorrelation` under two information conditions: **full-content** (both docs' content)
and **path-only** (DOC B content blanked to just its path — *exactly what the live
`birth.ts` panel passes*, line 199).

**Full-content (39 edges):** forward 66.7% / reverse 53.8% / contrast **89.7%** / majority
66.7% / **lift −23.08 pp** / error-correlation 92.3%. Decomposed:
- **Zero promiscuity, again — 63/63 on negatives** (all axes 21/21), now including the
  common-cause traps and on contamination-free content. The model is simply not promiscuous.
- **Perfect detection — 0/18 derives ever called `neither`.** The model always *sees* the
  derivation.
- **The entire failure is the direction token.** On `derives` pairs, reverse says "depends"
  **18/18**, forward 13/18; only `contrast` (states the mapping) gets "derives" right (14/18).
- **Undirected collapse (derivation-exists vs neither):** forward 100% / reverse 100% /
  contrast 97.4% / **majority 100% (39/39), lift 0.** Ask "is there a derivation?" and Haiku
  is near-perfect across every framing; ask "which direction?" and forward/reverse collapse.
- Why lift got *worse* than v1 (−23 vs −16): with the direction confound isolated, `contrast`
  dominates so completely (89.7%) that majority-voting with the two broken axes actively hurts.

**Path-only (39 edges — the live birth condition):** forward / reverse / contrast **all
identical at 53.8%** / majority 53.8% / lift 0.00 pp. Decomposed:
- **neither 21/21 all axes; derives 0/18 ALL axes.** With no content for DOC B, the model
  cannot detect a single derivation — it defaults to `neither` (or a stray "depends"). The
  53.8% is just the 21 negatives; every one of the 18 derivations is missed.

**The decisive comparison — detection 18/18 (full) → 0/18 (path-only).** This is not a
side-note: **`birth.ts:189-195` explicitly tracks this exact experiment** as the trigger to
load neighbor content ("load on demand when shadow data shows path-only verdicts disagree
with content-loaded verdicts on the decorrelation fixture"). The dual-condition re-run fires
that condition maximally. **Birth mode must load neighbor content; the path-only cost-saving
shortcut fails the test it was conditioned on** — under it, birth would seed essentially no
correct edges.

### What the whole exercise establishes (v1 + chunk-7 + v2)

1. **Promiscuity: none.** Robust across contamination, traps, and both information conditions.
   The gate's named failure mode does not occur — multi-model is *not* needed to fix promiscuity.
2. **Undirected derivation detection: excellent with content, zero without.** → **birth mode
   must load neighbor content** (resolves the tracked `birth.ts` calibration knob).
3. **Direction (derives vs depends): the *token* is broken, not the capability.** Under the
   derives/depends token, direction looked hopeless (reverse said "depends" 18/18; gemini
   always "derives"). Under a **foundational-ordering** prompt ("which is the premise / must
   be established first?"), all three models recover direction at **~100%, unbiased,
   order-consistent**. → **not a blocker; a prompt fix.** Replace the derives/depends token
   in birth/panel with foundational-ordering elicitation.
4. **Prompt-framing axes do not decorrelate.** On the directed task `contrast` subsumes the
   others (panel hurts); on the undirected task all three agree at ~100% (nothing to
   decorrelate). A 3-template majority panel buys nothing → use `contrast`-style framing alone,
   and reach for **multi-model only as a genuinely-independent axis** (and even then, choose
   models that can track direction — gemini can't).

The FAIL verdict stands and is now decisively explained. The actionable items are (2) and (3),
neither of which is "add a multi-model panel of prompt templates."

## Direction-elicitation experiment (2026-06-17) — the blocker falsifier

Prompted by pressure-testing the proposed "accrue-and-verify direction" design: that design
assumed per-vote direction is *unbiased and above chance* so accumulation converges — but the
observed failure was *systematic bias* (reverse→"depends" 18/18), which accumulation would
only amplify. So before designing any mechanism, we tested the load-bearing assumption.

**Setup:** 30 pairs with known premise→conclusion direction (18 v2 derives + 12 native
depends), each shown in **both orders**, three elicitation methods, three models, temp 0.
Order-flipping is the bias detector: a content-driven method picks the same real-world premise
regardless of order; a position-anchored one flips. Metrics: accuracy, order-consistency,
DOC1-bias (~50% = unbiased). Script: `scripts/pools/v2/direction-experiment.mjs`.

**Result (acc / order-consistency / DOC1-bias):**

| method | claude-haiku-4.5 | gpt-4o | gemini-2.5-flash |
|---|---|---|---|
| **foundational** | 100% / 100% / 50% | 100% / 100% / 50% | **100% / 100% / 50%** |
| counterfactual | 98% / 97% / 52% | 100% / 100% / 50% | 100% / 100% / 49% |
| direct (derives/depends token) | 100% / 100% / 50% | 90% / 92% / 40% | 91% / 88% / 42% |

**Reading:** direction is recoverable near-perfectly and **unbiased** with a foundational-
ordering prompt, on *every* model — including the gemini that looked "direction-blind" under
the token. Raw outputs verified (gemini gives correct, content-grounded premise picks that flip
correctly when docs are swapped). The earlier "direction is unreliable across models" conclusion
was an artifact of the `derives`/`depends` token interface. **Caveat / scope:** these are
clear-direction synthetic+Daftari pairs; genuinely symmetric/ambiguous real-vault edges should
still be hard (that is the symmetric class, correctly contestable) — validate on a real-vault
sample before relying on it in production. But for pairs that *have* a direction, the signal is
clean and strong.

## How the fixture was built (integrity trail)

Single-rater authorship was the open risk (spec §13 second-rater gap). Mitigated by
making **cross-family agreement the inclusion gate**: each candidate was judged BLIND by
two independent non-Claude families (`openai/gpt-4o`, `google/gemini-2.5-flash`), 3
samples each, majority vote. A `derives` pair entered only if **both** families confirmed
`derives` on the forward presentation; `neither` only if both confirmed `neither`;
`depends` pairs are validated forward-derivations shown reversed (direction established by
the confirmed forward form, sidestepping the derives/depends token-confusion). Pools and
per-candidate vote tallies: `scripts/pools/*.results.json`. Each fixture rationale cites
its pair's actual tally.

Survival: co-occurrence 22/22; derivations 29/40 (the 11 drops were gpt-4o direction
flips that gemini confirmed as derivations — correctly filtered by the strict gate).
Contradiction-as-`neither` pairs were **dropped** (calibration showed two families read a
claim+negation as a directional relationship — disputed label, bad for gate
interpretability; the handoff's hard-negative spec never asked for them).

## Review findings (chunk-7 independent adversarial review, 2026-06-17)

Three independent reviewers (two general-purpose on fixture-methodology and
verdict-reasoning, one code-reviewer on the metric/transport code). The math came back
clean; the interpretation and the fixture's grade did not. Findings and dispositions:

- **Code/metrics: SOUND (Reviewer C).** Every metric, the depends-reversal swap, the
  counts, and the transport shim verified by hand and against the report JSON. 0 errors /
  0 ties across 153 votes. Shim is byte-identical to the canonical client on the
  load-bearing axes (`max_tokens` 1024 vs 4096 and backoff 30s vs 60s diverge but can't
  bias a run with zero truncations/errors). **The −15.69 pp and all per-class numbers are
  faithfully computed.** ACCEPTED.
- **F1 — promiscuity claim is partly circular (Reviewer A, CRITICAL).** The inclusion
  gate kept only negatives both validator models call `neither`, excluding the borderline
  traps by construction. CORRECTED in §Decomposition #1: 66/66 now reads as "Haiku is not
  *more* promiscuous than the validators on unambiguous negatives," not "no promiscuity."
  Remediation (v2 fixture): deliberately include negatives that passed only *one* validator
  family — the promiscuity traps the strict gate filtered out.
- **F2 — "entire failure is direction-token confusion" overstated (Reviewer B, CRITICAL).**
  True split: ~68% flips / ~32% said-neither; derives-class 96% flips, depends-class 0%
  flips / 100% said-neither. CORRECTED in §Decomposition #2 (two mechanisms, quantified).
- **F3 — external validity (Reviewer C, IMPORTANT).** Report uses full-content + `[template:]`
  tags; the live birth panel uses path-only + untagged. CORRECTED — added as a What-ran
  caveat and an owed re-run. **This is the most consequential finding: the report may not
  measure what production ships.**
- **F4 — contamination (Reviewer A, CRITICAL as stated; downgraded on disposition).**
  ~48/51 edges are memorized textbook facts, violating the handoff's post-cutoff
  preference. Agreed this makes the fixture **smoke-grade, not paper-grade**, and limits
  what the *direction/detection* accuracies mean. PARTIAL push-back: it does not rescue
  the FAIL/direction findings (a memorized fact still gets the wrong token under
  forward/reverse), and for the *promiscuity* question, recall of "these are siblings" is
  acceptable. Remediation (v2): rebuild the majority on post-cutoff/novel content.
- **F5 — depends is reversal-only; label questioned (Reviewers A+B, IMPORTANT).**
  PARTIAL push-back: `contrast` recovers the depends label 8/10, so the ground truth is
  *defensible*, not contestable — the forward/reverse failure is prompt under-specification.
  AGREED the doc must distinguish this from token-flips (done, F2) and that "keep depends
  as a verdict?" is now an explicit decision. Remediation (v2): author native `depends`
  pairs, not reversals.
- **F6 — coverage gaps (Reviewer A, IMPORTANT).** derives edge-class is 16 backward-causal
  / 3 forward-temporal / **0 symmetric** vs the brief's ~40% forward-temporal + a required
  symmetric class. ACCEPTED as a v2 gap; depends/neither carry no `edgeClass`.
- **Minor (accepted, low priority):** several `neither` are easy "contrast siblings"
  (TCP/UDP, precision/recall) rather than citation-without-dependence traps; path/title
  leakage in the Daftari-internal pairs; the 11 dropped derivations were the most
  diagnostic (direction-hard) edges.

**Bottom line of the review:** the *measurement* is correct and the *FAIL verdict is
robust*, but the fixture is a **smoke-grade calibration tool, not the paper-grade
verification gate** the brief specifies — which actually matches the handoff's own framing
("calibration tool, not a paper-grade result") that the first draft of this doc drifted
past. The procedural conclusion (prompt-framing axes don't decorrelate; fix templates
before multi-model) stands; the auto-write-graduation gate it was meant to be does **not**
yet, pending the v2 remediations above.

## Still owed

1. Decision on prompt-repair-first vs multi-model-first (this doc recommends the former).
2. Decide whether `depends` stays a distinct verdict (F5).
3. Re-run under the live **path-only** information condition before acting on the
   prompt-repair recommendation (F3).
4. v2 fixture if these numbers are to gate auto-write graduation: post-cutoff content
   (F4), native `depends` pairs (F5), a symmetric edge class (F6), and deliberate
   one-validator-only promiscuity traps (F1). v1 stays a calibration tool.
5. PR for the Stage 2 branch, carrying this reviewed verdict.

Resolved: the OpenRouter→`claude-haiku-4.5` transport is accepted as equivalent to the
canonical `daftari consolidate` path (Mihir, 2026-06-17), so no separate Anthropic-key
confirmatory run is required.

---

## Real-prose direction validation (Task 0 GATE — 2026-06-17)

**Result: GATE FAILED on the directional kill condition; PASSED on symmetric emission.**
The `derives_from`-direction implementation plan (`docs/superpowers/plans/2026-06-17-derives-from-direction.md`)
is **halted at Task 0** — no implementation was started.

Harness: `scripts/pools/v2/direction-realprose-experiment.mjs` over
`direction-realprose-pairs.json` (28 real-prose directional pairs lifted from exp1's
`draft_novel.json`, premise=`to_premise_true` / conclusion=`from_claim`; 10 hand-built
genuinely-mutual pairs). Foundational-ordering prompt, **temp 0** (the pinned production
setting), each pair shown in both orders.

| model | directional acc | order-consistency | DOC1-bias | symmetric emission |
|---|---|---|---|---|
| claude-haiku-4.5 | **79%** | 71% | 43% | 9/10 (90%) |
| gpt-4o | **70%** | 75% | 52% | 9/10 (90%) |
| gemini-2.5-flash | **70%** | 70% | 39% | 10/10 (100%) |

**Kill conditions (plan Task 0 Step 4):**
- Directional accuracy ≥ 85% AND DOC1-bias ∈ [40%,60%] → **FAILED.** All three models 70–79%
  (best: haiku 79%). DOC1-bias is roughly centered (gemini 39% just outside), so the failure is
  **accuracy, not position-bias** — the prompt is not systematically biased, it is *uncertain*.
- Symmetric emission majority of mutual pairs → **PASSED** decisively (90–100%). The §3.3
  symmetric path's elicitation is sound; the model correctly refuses to fabricate a direction.

**Why directional failed — two distinguishable causes (not collapsed):**

1. **Order-inconsistency, not noise (the substantive concern).** Per-pair on haiku
   (`direction-realprose.diagnostic.json`): 18/28 fully correct in both orders, **8 order-inconsistent**
   (the model flips its premise pick with presentation position), 2 fully wrong. Synthetic pools
   had ~100% order-consistency; real prose drops to ~71%. A stored edge direction that flips on
   presentation order is exactly what temp-0 determinism was meant to buy and does **not** hold here.

2. **The test pairs are not all "clear-direction" (a confound in the gate's precondition).**
   `draft_novel.json` was built for derivation-*detection* (does claim X draw on cited source Y),
   so its labeled "premise" is the **external citation**, which is not always the "more foundational /
   established-first" claim the prompt asks for. On several misses the model's *reason is plausible*
   (e.g. nv-pf-011: picks the general side-effect-penalty *category* as foundational over the specific
   finding). For those pairs, "which is more foundational" is genuinely contestable — so 85% over the
   full 28 is arguably the wrong bar, but I did **not** curate the set down to the model's correct
   answers (that would be rationalizing past the gate).

**Surfaced to human — decision needed before any implementation (Tasks 1–9 remain unstarted):**
- (a) **Rework the elicitation prompt** for real-prose robustness (the plan's stated remedy) and
  re-gate; or
- (b) **Re-curate a clean clear-direction real-prose set** (hand-pick pairs with unambiguous
  foundational ordering, ideally from Daftari's own docs) and re-gate — separates cause 1 from cause 2; or
- (c) **Reconsider the design** — if real-prose foundational ordering tops out at ~80% order-consistent,
  a temp-0 single-call direction may need a confidence/margin signal that routes low-margin pairs to the
  symmetric/pending path (which the symmetric result shows is reliable), rather than trusting the pick.

My read: cause 1 (order-inconsistency on genuinely-ambiguous pairs) is the real signal; (b) then (c)
is the honest path — re-curate to confirm the capability on truly clear pairs, and if even those don't
clear ~95% order-consistency, adopt the margin→pending fallback the symmetric path already validates.
