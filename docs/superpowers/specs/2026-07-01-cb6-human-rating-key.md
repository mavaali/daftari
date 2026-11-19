# CB6 human rater pass — answer key + scoring (do not read before rating)

Companion to `2026-07-01-cb6-human-rating-sheet.md`. Prepared 2026-07-01.

## Design

9 items: the 6 CB6 tension pairs (source: `integrations/consensus-bench/src/consensus-cb6-tension.ts`,
ground truth = the editor "no consensus" close, expected Q1 = YES) interleaved with 3
settled-supersession controls (source: `scripts/cb6-gate-negative-controls.mjs`, ground
truth = one side won and was consensus-protected, expected Q1 = NO). Item order and A/B
slot assignment were fixed by the sheet author before rating; the rater saw no labels.

Controls were chosen from the negative-control pool after the sheet author had named a
first selection in conversation with the rater (a blinding leak); the sheet was regenerated
with a different, undisclosed subset. Of the three used, the LLM gate got #71 right
(rejected) and got #27 and #40 wrong (passed them as tensions), so the human pass also
measures whether a human discriminates where the gate did not. #37 was excluded for the
arguability noted in the negative-control results doc.

## Key

| sheet | source item | kind | ground truth Q1 | slot A | slot B |
|---|---|---|---|---|---|
| R1 | COVID-19 pandemic, box #7 (map prominence) | tension | YES | statusQuo | alternative |
| R2 | control #71 (Korean peace process mention) | settled | NO | posLoser | posWinner |
| R3 | Donald Trump, box #48 (COVID wording) | tension | YES | alternative | statusQuo |
| R4 | Joe Biden, box #2 (gaffes subsection) | tension | YES | alternative | statusQuo |
| R5 | control #40 (battery-theory framing) | settled | NO | posWinner | posLoser |
| R6 | Donald Trump, box #15 (2016 result phrasing) | tension | YES | statusQuo | alternative |
| R7 | Donald Trump, box #65 (Abraham Accords) | tension | YES | alternative | statusQuo |
| R8 | control #27 (birther-sentence retention) | settled | NO | posLoser | posWinner |
| R9 | Donald Trump, box #56 (Russian bounties) | tension | YES | statusQuo | alternative |

Gate comparison (from `2026-07-01-cb6-gate-negative-controls.md`): the LLM gate answered
YES on all 6 tensions and on controls #27 and #40; NO on #71.

## Scoring

Report raw counts, no statistics at this n:

1. **Tension agreement:** of the 6 tension items, how many rated Q1 = YES.
2. **Control rejection:** of the 3 settled controls, how many rated Q1 = NO.
3. **Fairness:** of the 6 tension items, how many rated Q2 = YES (Q2 on controls is
   informational only; the control pairs were distilled by the negative-control agent, not
   by the original author).
4. **Recognition:** how many items rated Q3 = YES, reported alongside, as the honesty
   caveat on self-rating.
5. **Human vs. gate:** did the human reject the two controls the gate wrongly passed
   (#27, #40)?

## Where the results go

Write `docs/superpowers/results/2026-07-0X-cb6-human-rater-pass.md` with the filled sheet
(or verdict table), the counts above, and the caveats (single rater; rater = author of the
tension-side distillations; recognition disclosure per Q3). Then update the paper:

- §6, the gate paragraph: after the negative-control sentence, add one sentence with the
  human counts, e.g. "A human rater pass over the same pairs, with three settled controls
  embedded blind, rated the tensions N/6 genuine and rejected M/3 controls (rater = the
  author; recognition disclosed per item)."
- §8, the distill-then-gate bullet: replace "an independent human rating pass over the six
  pairs is the outstanding fix" with the result, keeping the single-rater/author caveat.
  An additional independent (non-author) rater remains the stronger fix and can be noted
  as such.
- Correction plan `docs/paper/2026-07-01-moderator-review-correction-plan.md`: mark M4(ii)
  done.
