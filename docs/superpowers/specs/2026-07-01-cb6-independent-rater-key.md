# Independent rater sheet: answer key + scoring (administrator only)

Companion to `2026-07-01-cb6-independent-rater-sheet.md`. Prepared 2026-07-01. This is the
M4(ii)-replacement instrument specified in
`docs/superpowers/results/2026-07-01-cb6-human-rater-pass.md`, for a non-author rater.

## Administration notes (for Mihir)

- Give the rater the sheet file (or a printout) ONLY. Not this key, not the paper, not
  the results docs, and no conversation about which items are which. You know the ground
  truth of every item, including all controls, so any discussion contaminates the pass.
- The instrument deliberately does NOT ask the broken gate question ("is this unresolved?").
  I1/I2 validate the distillation (the thing a text-only rater CAN judge); I3 measures
  status-determinability from text, where "cannot tell" is the expected and useful answer.
- 10 items: the 6 CB6 tension pairs + 4 settled controls (#63, #43, #54, #72 from the
  negative-control pool; #37 excluded for arguability, #27/#40/#71 excluded because they
  were used in the author pass). Order and A/B slots fixed by the sheet author.

## Key

| sheet | source item | kind | slot A | slot B | I3 truth (from editorial record) |
|---|---|---|---|---|---|
| R1 | Trump box #65 (Abraham Accords) | tension | statusQuo | alternative | no winner (no consensus) |
| R2 | control #63 (Fordham infobox) | settled | posLoser | posWinner | B won |
| R3 | Trump box #15 (2016 phrasing) | tension | alternative | statusQuo | no winner (no consensus) |
| R4 | control #72 (second-presidency lead) | settled | posWinner | posLoser | A won |
| R5 | Biden box #2 (gaffes subsection) | tension | statusQuo | alternative | no winner (no consensus) |
| R6 | Trump box #56 (Russian bounties) | tension | alternative | statusQuo | no winner (no consensus) |
| R7 | control #43 (democratic backsliding) | settled | posWinner | posLoser | A won |
| R8 | Trump box #48 (COVID wording) | tension | statusQuo | alternative | no winner (no consensus) |
| R9 | control #54 (ranking wikilink) | settled | posLoser | posWinner | B won |
| R10 | COVID-19 box #7 (map prominence) | tension | alternative | statusQuo | no winner (no consensus) |

Note on I3 "truth": the editorial record's answer is shown for scoring, but the rater is
asked what the TEXT reveals; "CANNOT TELL" is the expected answer nearly everywhere and is
not an error on any item.

## Scoring (raw counts, no statistics at this n)

1. **I1 distinctness, tensions:** of 6, how many YES. This is the distillation-validity
   number the paper needs: it says the pairs are real alternatives, not paraphrases.
   (Author pass context: the author's conflict-reading suggested several pairs read as
   wording quibbles; an independent YES here answers that.)
2. **I1 distinctness, controls:** of 4, how many YES (expected high; controls are real
   disputes too).
3. **I2 fairness, tensions:** of 6, how many YES, with any NO notes quoted verbatim. This
   replaces the author pass's quarantined Q2. A NO with a note naming the alternative side
   is a distillation defect to report in §8.
4. **I3 determinability:** count of CANNOT TELL across all 10. High count = direct,
   independent-rater evidence for the not-text-recoverable claim (§5/§6). For any A/B
   answer given: on controls, was it the actual winner (text leakage or guessing); on
   tensions, any A/B answer is a false determination and gets reported as such.
5. **Prior-knowledge boxes:** report which items were ticked; those items' I3 answers get
   a caveat.

## Where the results go

Write `docs/superpowers/results/2026-07-0X-cb6-independent-rater-pass.md`: transcribed
sheet, the five counts, rater description (role, no authorship or corpus involvement),
caveats (single rater, n=6+4). Then update the paper:

- §6 gate paragraph: replace "(pending)" language for the reassigned validation with the
  I1/I2 counts, e.g. "an independent, non-author rater judged the pairs meaningfully
  distinct N/6 and fairly stated M/6, and could determine an outcome from text on K/10
  items."
- §8 distill-then-gate bullet: replace the "outstanding fix" sentence with the result.
- §5, if I3 CANNOT TELL is high (8+/10): one clause adding the independent human datum to
  the not-text-recoverable argument.
- Correction plan: mark M4(ii-replacement) done.
