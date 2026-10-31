# CB6 second-rater gate — negative controls (M4(i)): the gate barely discriminates

**Date:** 2026-07-01
**Plan:** `docs/paper/2026-07-01-moderator-review-correction-plan.md` (item M4(i), with B3).
**Model:** `google/gemini-2.5-flash` via OpenRouter (the exact CB6 second-rater), temp 0,
max_tokens 1024, one run. 14 calls, cost well under $0.10.
**Runner:** `scripts/cb6-gate-negative-controls.mjs`; raw results
`scripts/pools/cb6-gate-negative-controls.results.json`.

**Verdict: the reviewers' suspicion is confirmed.** [DATA] Fed 8 *settled* supersessions
phrased identically to the CB6 tension pairs, the gate rejects only **2/8** — it passes
6 of 8 cases where one position had demonstrably won (the losing wording was reverted on
Wikipedia citing the governing consensus item). In the same session the 6 original tension
pairs re-validate **6/6** (no drift from the original run). So the gate is near-uniformly
biased toward `YES_TENSION`: its 6/6 approval of the tension pairs demonstrates at most
that the pairs read as *plausible, well-formed editorial disagreements* — it does **not**
demonstrate that they are *unresolved*, which is the property the paper's §6 cites it for.
The unresolved/settled distinction in CB6 rests on the editor "no consensus" closes (which
remain clean ground truth), **not** on the second-rater. The paper's "load-bearing, not
decorative" claim about the gate must be retracted or heavily reworded.

## Setup

**The exact CB6 prompt, recovered.** The original CB6 runner (`_cb6-run.test.ts`) was a
deleted throwaway, never committed ([DATA] commit `c1ba04e` message: "Paid run was a
deleted throwaway"; `git log --diff-filter=D` shows it never entered git). The judge
prompt was recovered **verbatim** from the session transcript that wrote it (session
`d3499c05`, tool-use records of 2026-06-30T03:27Z and 03:43Z — byte-identical in both the
n=4 and n=6 runner versions):

```
Two editors disagree about how an article should describe a point.
Position A: ${positionA}
Position B: ${positionB}

Is this a genuine, unresolved editorial disagreement in which neither position has
clearly superseded or won out over the other? Reply 'YES_TENSION' or 'NO'.
```

Sent as a single user message (no system prompt) through the committed
`openRouterClient` (`integrations/consensus-bench/src/consensus-llm.ts`: temperature 0,
max_tokens 1024) — the same client the CB6 run used. Verdict parse identical
(`/yes_tension/i`), with raw responses recorded so an API error cannot masquerade as a
rejection (all 14 responses were clean single tokens; 0 errors).

**Control selection (mechanical rule, stated before selection).** From the 33 scorable
stale-trap pairs (`truePairs` over `trump-instance-diffs.json`): dedupe on `governingNum`
(first scorable instance per item → 17 distinct items), rank by ascending token-set
Jaccard(govText, staleText), take the **first 8** — the pairs whose two wordings differ
substantively enough to distill into two distinct positions (the near-identical reverts,
median sim 0.938 per CB5, cannot be phrased as distinguishable positions at all).
Selected: **#63, #37, #72, #27, #43, #54, #71, #40**.

**Distillation.** Each control's changed span was distilled into a
`(position-that-won, position-that-lost)` pair mirroring the CB6 tension pairs' format
and length (the originals mix direct article-wording positions and meta-positions like
"should include a subsection"; both styles are used here to match). Ground truth for
every control = **settled** (the losing wording was reverted citing the numbered
consensus item — the corpus's own label, no LLM labeler). Blind: the gate sees only the
two positions — no labels, no revert history — the **same information condition as the
original CB6 run**, so the comparison is fair. Which position occupies slot A was
randomized per item (seeded `20260701`, assignment recorded). The 6 tension re-checks
keep the original orientation (A = statusQuo) so the drift check against the original
6/6 is clean.

## Results (n = 8 controls + 6 tension re-checks, one run)

| control | topic (changed span) | winner in slot | gate verdict | rejected? |
|---|---|---|---|---|
| #63 | infobox education: include Fordham (attended)? | B | NO | **yes** |
| #37 | Feb-2026 Iran attack: one sentence vs full detail | A | YES_TENSION | no |
| #72 | 2nd-presidency lead: pardons sentence, links, lawsuit count | B | YES_TENSION | no |
| #27 | racism section: retain the Sept-2016 birther sentence? | B | YES_TENSION | no |
| #43 | lead: democratic-backsliding sentence inclusion | B | YES_TENSION | no |
| #54 | wikilink on "scholars and historians ranked him" | A | YES_TENSION | no |
| #71 | foreign policy: mention failed Korea peace process? | A | NO | **yes** |
| #40 | health: "battery theory" fringe-belief framing | A | YES_TENSION | no |

**Settled-control rejection rate: 2/8.**

| tension re-check (original orientation) | gate verdict | matches original run? |
|---|---|---|
| Trump #15, #48, #56, #65; Biden #2; COVID-19 #7 | YES_TENSION ×6 | **6/6 — no drift** |

Both sets ran in the **same session under the same (original, recovered) prompt**, so the
within-run discrimination contrast — tensions 6/6 pass vs settled controls 2/8 rejected —
stands on its own, independent of any drift between this session and the original CB6
run. (Each gate call is an independent stateless API request; item ordering cannot affect
verdicts.)

## Reading

- **The gate does not discriminate settled from unresolved.** [DATA] 6/8 settled
  supersessions pass as "genuine, unresolved editorial disagreement in which neither
  position has clearly superseded or won out" — while every one of them had, verifiably,
  been superseded (the losing edit reverted citing the consensus item). Combined with the
  6/6 tension pass, the gate's operating behavior is ~12/14 `YES_TENSION`: it is a weak
  filter that approves nearly any well-formed pair of editorially-flavored positions.
- **What the 6/6 in CB6 actually certified, then.** At most: the distilled pairs read as
  plausible two-sided disagreements (not strawmen, not gibberish, not one position plus a
  caricature). That is a real but much weaker property than "genuine unresolved tension."
  The unresolvedness of the 6 CB6 items still stands — but on the **editor "no consensus"
  closes**, which were always the stated ground truth, not on the gate.
- **The two rejections look knowledge-driven, not text-driven.** [HYPOTHESIS] #63
  (infobox education conventions are codified in Wikipedia's MOS) and #71 (dropping a
  "failed peace process" aside reads as a settled trim) are the two cases where general
  knowledge of editing conventions hints at a clear winner; the six passes are all cases
  where both positions remain substantively defensible *from the text alone*. Kill
  condition: a re-run with convention-neutral rephrasings of #63/#71 that flips them to
  YES_TENSION would confirm the gate has no settledness signal at all.
- **Structural reason the gate can't do better:** the settled/unresolved fact is
  **extrinsic to the pair** — it lives in the revert history and the consensus box, which
  the blind gate (by design) never sees. A text-only judge is being asked a provenance
  question with the provenance withheld. This is the same lesson as CB5 ("these
  stale-traps are governance events, not competing claims") appearing at the gate level —
  and, incidentally, it is daftari's own argument: resolution status is provenance, not
  text.

## For the paper (§6, §8)

- §6 must stop presenting the gate as validation of unresolvedness. Honest wording: the
  pairs were "screened by a blind cross-family second-rater for well-formedness
  (approved 6/6); negative controls show this screen passes 6/8 settled supersessions
  phrased identically, so it does not certify unresolvedness — that property rests on the
  editor 'no consensus' closes." Retract/reword "load-bearing, not decorative" (cb6.md
  line 101 and its paper echo): measured, the gate's discriminative contribution is thin.
- §8 gains an honest bullet: the apparatus's one LLM-judgment quality gate, when
  negative-controlled, barely discriminates (2/8) — reported rather than hidden, and the
  keystone result is unaffected because ground truth never came from the gate.
- M4(ii) (a human rater pass over the 6 pairs) is now **more** important, since the LLM
  gate cannot carry the distillation-quality claim alone. Not run here (out of this
  task's scope).
- **Prompt non-preservation is itself a finding for the reproducibility appendix (M6).**
  [DATA] The gate prompt exists in no committed script — a repo-wide search for the gate
  question across .mjs/.ts/.js finds nothing; the runner was a deleted throwaway
  (commit `c1ba04e`: "Paid run was a deleted throwaway") and the prompt survives only in
  a local session transcript and, paraphrased, in the results doc/paper. Had the
  transcript not existed, this control would have been impossible to run faithfully. The
  paper must (i) print the exact prompt in the apparatus appendix, and (ii) the repo
  should adopt a rule that paid-run prompts are committed even when the runner is
  discarded — `scripts/cb6-gate-negative-controls.mjs` now preserves this one in code.

## Honest precision

- **Single run, temp 0** (matching CB6's protocol) — CB6's own note says abstain-style
  verdicts can shift run-to-run at temp 0. All 14 responses here were bare single tokens,
  and the 6/6 re-check exactly reproduced the original run, which is mild evidence of
  stability — but 2/8 should still be read as one sample, not a point estimate.
- **Control distillation is author-performed** (by the assistant in this session, from
  the recovered changed spans), exactly as the original tension-pair distillation was
  author-performed in the CB6 session. The distillations are grounded in each item's
  actual delta (revids recorded in the runner), but a different distiller could phrase
  sharper or softer pairs; the mechanical selection rule constrains *which* items, not
  *how* they are phrased.
- **Asymmetry risk in phrasing:** controls were distilled by someone who knew the ground
  truth (settled) — if anything this should have made rejection *easier* (no incentive to
  soften), so 2/8 is unlikely to be an artifact of deliberately tension-flavored
  phrasing. [HYPOTHESIS] — a blinded re-distillation would test it.
- **Genre match is good but not perfect:** all 8 controls come from the Trump article
  (the 33-trap corpus is Trump-only); 4 of 6 tension pairs are Trump, 2 are
  Biden/COVID-19. Slot-order effects: rejections occurred with the winner in A (#71) and
  in B (#63); passes in both orientations — no visible position bias at n=8.
- **One selected control (#37) mixes wording-length with content** (the one-sentence vs
  detailed Iran-attack description also drops specific claims); its "settled" label is
  still the corpus's own (revert citing item #37), but it is the control most arguable as
  a genuinely live dispute. Dropping it entirely still leaves rejection at 2/7.
- The prompt-recovery path (session transcript, not repo) should be disclosed in the
  paper's apparatus section (M6): the original gate run is otherwise unreproducible from
  the public repo.
