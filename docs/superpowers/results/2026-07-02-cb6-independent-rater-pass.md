# CB6 independent rater pass (M4-ii replacement): distillation mostly validates, outcomes not text-recoverable, human position bias

**Date rated:** 2026-07-02. **Rater:** ChenFei Wang (independent rater; no authorship, no
corpus involvement, blind to item provenance and to which items were controls).
**Instrument:** `docs/superpowers/specs/2026-07-01-cb6-independent-rater-sheet.md`
(10 items: the 6 CB6 tension pairs + 4 settled controls #63/#43/#54/#72; I1 distinctness,
I2 fairness, I3 text-determinable outcome with CANNOT TELL legitimized), key in
`2026-07-01-cb6-independent-rater-key.md`. Completed sheet returned as
`~/Documents/ratercomplete.md`, transcribed below. No prior-knowledge boxes ticked; no
lookups per the rater's covering note.

**Verdict:** three findings [DATA]:

1. **Distinctness mostly validates the distillation: tensions 4/6, controls 4/4.** The two
   NOs are exactly the two closest near-paraphrase pairs (Trump #15, 2016 phrasing; Trump
   #56, bounties). This independently corroborates the author-pass impression that a
   subset of the tensions are wording-level disputes, while confirming the other four are
   real alternatives.
2. **Fairness 4/6 on tensions, and both objections name the distilled *alternative* side**
   (#65 Accords: "B strong language"; Biden #2 gaffes: "B opinionated"). A concrete
   distillation defect on 2/6 pairs, disclosed in §8 rather than averaged away. (Two
   further "exaggeration" notes on controls #43/#54 do not implicate the author's
   distillation; the control pairs were machine-side distillations.)
3. **Outcomes are not text-recoverable, and the human manufactures direction with position
   bias.** With CANNOT TELL explicitly legitimized, the rater used it on only 3 of 9
   answered items and asserted a winner on 6; **all 6 assertions were "A WON"** (the
   first-presented position), and on the 3 answered settled controls the rater picked the
   actual winner 1/3, chance level. So the text does not reveal outcomes even when the
   rater asserts one, and a human offered an abstain option behaves like the
   abstain-offered models of §5-6: sometimes manufacturing a direction anyway, with
   position bias. The human analogue of the foil finding, unforced.

## Raw verdicts [DATA]

| item | source | kind | I1 | I2 (note) | I3 given | I3 truth |
|---|---|---|---|---|---|---|
| R1 | Trump #65 (Accords) | tension | YES | NO (B strong language) | A WON | no winner |
| R2 | control #63 (Fordham) | settled | YES | YES | A WON | B won |
| R3 | Trump #15 (2016) | tension | NO | YES | CANNOT TELL | no winner |
| R4 | control #72 (lead) | settled | YES | NO (B spared details) | A WON | A won |
| R5 | Biden #2 (gaffes) | tension | YES | NO (B opinionated) | A WON | no winner |
| R6 | Trump #56 (bounties) | tension | NO | YES | A WON | no winner |
| R7 | control #43 (backsliding) | settled | YES | NO (exaggeration) | *unanswered* | A won |
| R8 | Trump #48 (COVID) | tension | YES | YES | CANNOT TELL | no winner |
| R9 | control #54 (wikilink) | settled | YES | NO (exaggeration) | A WON | B won |
| R10 | COVID #7 (maps) | tension | YES | YES | CANNOT TELL | no winner |

Counts: I1 tensions 4/6, controls 4/4. I2 tensions 4/6 (both NOs name the alternative
side), controls 2/4. I3: CANNOT TELL 3/9 answered; asserted 6/9, all six "A WON";
control accuracy 1/3; tensions falsely determined 3/6 (R1, R5, R6); R7 unanswered.

## Caveats

- **Single rater, n = 6 + 4.** Raw counts only; no statistics.
- **R7's I3 is missing** (the template line was left unmodified); control accuracy is
  therefore over 3, not 4.
- [HYPOTHESIS] The uniform "A WON" pattern could reflect a reading of I3 as "which side is
  right?" rather than "does the text state who won?", since the assertions co-occur with
  the rater's fairness objections to side B on three items. Under either reading the
  operative facts stand: chance-level control accuracy and first-position uniformity.
  Kill condition: a second independent rater with an I3 reworded to "does the text
  explicitly SAY who won?" asserts winners at a similar rate.
- The instruction "do not guess" was not fully followed (6 assertions at chance accuracy);
  we report this as rater behavior, not exclude it, because it is itself the datum that
  parallels the abstain-offered foils.

## Paper impact (applied)

- §6: the reassigned validation is now reported with these counts, including the
  first-position bias and chance-level control accuracy as the human analogue of the foil
  position bias.
- §8 distill-then-gate bullet: outstanding-fix language replaced with the result; the two
  alternative-side fairness defects disclosed.
- Correction plan M4(ii-replacement): DONE.
