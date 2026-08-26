# CB6 human rater pass (M4-ii): run, and the instrument broke first

**Date:** 2026-07-01. **Rater:** Mihir Wagle (author of the tension-side distillations).
**Instrument:** `docs/superpowers/specs/2026-07-01-cb6-human-rating-sheet.md` (blind sheet:
6 CB6 tension pairs + 3 settled controls, positions randomized), key in
`2026-07-01-cb6-human-rating-key.md`. Rated on paper, transcribed from the rater's sheet.

**Verdict:** the pass did not validate the tension pairs, and not because the rater judged
them settled: the rater read Q1 ("is this a genuine, unresolved editorial disagreement in
which neither position has clearly superseded or won out?") as asking whether the two
*texts* genuinely conflict, and answered NO on all 6 tension pairs (confirmed by the rater
post-hoc: "no real conflict" reading) [DATA]. Two findings follow, one bad for the gate
instrument, one that lands in the paper's favor:

1. **The gate question is ill-posed.** On the same pairs and near-identical wording, the
   LLM gate answered YES near-uniformly (6/6 tensions + 2/3 of these controls; see
   `2026-07-01-cb6-gate-negative-controls.md`) and the human answered NO near-uniformly
   (0/6 tensions, 1/3 controls YES). A question whose meaning flips between raters
   (editorial-status reading vs. textual-conflict reading) cannot validate anything.
   Combined with the negative-control result, the CB6 "second-rater gate" should carry no
   evidential weight in the paper. The keystone (17/18) is unaffected throughout: its
   ground truth is the editor "no consensus" closes, which never pass through any gate.
2. **The textual-conflict reading reproduces the paper's not-text-recoverable claim.** A
   human expert, reading the paired texts alone, found genuine substantive conflict in 0/6
   editor-certified tensions [DATA]. This is the human analogue of CB5's detector finding
   (2-4/33; most disputes are framing/detail differences, both versions true): the
   unresolvedness of these disputes is carried by the editorial record, not by anything
   visible in the wording. It also explains *why* no text-only gate (LLM or human) can
   certify unresolvedness.

## Raw verdicts [DATA]

Q1 = genuine unresolved disagreement (as read by the rater: genuine textual conflict);
Q2 = both positions fair statements; Q3 = rater recalls the item's resolution status.

| item | source | kind | Q1 | Q2 | Q3 |
|---|---|---|---|---|---|
| R1 | COVID-19 #7 (maps) | tension | NO | NO | YES |
| R2 | control #71 (Korea mention) | settled | YES | YES | NO |
| R3 | Trump #48 (COVID wording) | tension | NO | YES | YES |
| R4 | Biden #2 (gaffes) | tension | NO | NO | YES |
| R5 | control #40 (battery theory) | settled | NO | YES | NO |
| R6 | Trump #15 (2016 phrasing) | tension | NO | YES | YES |
| R7 | Trump #65 (Accords) | tension | NO | NO | YES |
| R8 | control #27 (birther sentence) | settled | NO | NO | YES |
| R9 | Trump #56 (bounties) | tension | NO | NO | NO |

Counts under the rater's (textual-conflict) reading: genuine conflict 0/6 tensions, 1/3
controls; fairness (Q2) 2/6 on tensions; recall (Q3) claimed on 6/9.

## Caveats

- **Single rater; rater = author.** For the *intended* gate question this pass was always
  near-information-free anyway: Q3 shows the rater recalls the resolution status of most
  items, and the six tension closes are the corpus's own ground truth. That is the standing
  argument for an independent rater, not a reason to re-run the author.
- **Q2 is not interpretable as-is.** The rater marked 4/6 of his own distilled pairs "not
  fair statements" under the conflict reading; the Q1 misreading plausibly colored Q2
  (e.g., "overstated relative to the actual conflict"). Reported verbatim here; NOT cited
  in the paper; to be re-asked with the fixed instrument.
- **Blinding was compromised twice** and disclosed both times: the coordinator named a
  first control selection in conversation (sheet regenerated with an undisclosed subset),
  and full source mapping was revealed to the rater when scoring, so no re-rate of this
  sheet by this rater can be blind.
- Comparison wrinkle worth keeping: the CB6 contradiction detector flagged 3/6 of these
  pairs as genuinely oppositional; the human saw 0/6. [HYPOTHESIS] The detector's YES_CONFLICT
  threshold is looser than a human's on paired near-paraphrases. Kill condition: an
  independent rater with the fixed instrument flags ≥2 of the same 3 as oppositional.

## What replaces M4(ii)

An **independent (non-author) rater** with a two-part instrument that separates the axes
the broken question conflated:

- **I1 (distinctness/fairness):** "Are these two positions meaningfully different
  prescriptions for the article, and is each stated fairly (no strawman)?", answerable
  from text, validates the distillation.
- **I2 (status, if determinable):** "From the text alone, can you tell whether the
  underlying dispute was resolved in favor of one side?", expected answer is largely
  "cannot tell," which *is* the datum: it evidences not-text-recoverable directly instead
  of pretending a text-only rater can certify unresolvedness.

Unresolvedness itself needs no rater: it is the editor close, by construction of the corpus.

## Paper impact (applied)

- §6: the gate sentence now reports both the negative-control result and this pass; the
  gate carries no validation weight; well-formedness/fairness validation is reassigned to
  the independent-rater instrument above (pending).
- §8 distill-then-gate bullet: updated to match.
- Correction plan M4(ii): run, instrument invalidated, replaced by the independent-rater
  design above (open).
