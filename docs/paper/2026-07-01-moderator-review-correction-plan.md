# Moderator review + correction plan — "Preserve, Don't Resolve" (draft 2026-06-29)

**Date:** 2026-07-01. **Scope:** `docs/paper/preserve-dont-resolve.md` (511 lines) + `references.bib`.
**Process:** four independent review passes (evidence grounding against all eight result artifacts,
skeptical methodology review, live per-ID citation verification against arxiv.org, presentation/
submission-readiness), with the load-bearing findings re-verified directly against the artifacts.

**Status update, 2026-07-01 (same day):** Phases 1, 3, and 4 executed. DONE: B1, B2, B3, B5,
M2 (disclosures incl. item-clustered 17/18 and CIs), M5, M6 (setup, prompts appendix A/B,
attrition, availability, ethics, front matter; meta-note stripping B4 deliberately deferred to
submission), M3 (Mem0 v2.0.11 write path run; finding: additive-only default, correction
silently unregistered 26/33 → folded into §5/§8/§9), M4(i) (gate negative controls; finding:
gate rejects only 2/8 settled, "load-bearing, not decorative" retracted in §6/§8). New
artifacts: `2026-07-01-mem0-write-path.md`, `2026-07-01-cb6-gate-negative-controls.md`, plus
runners.

**Second pass, later 2026-07-01:** M1 DONE (control/treatment renamed to contrasting regimes
with an explicit not-a-causal-design disclaimer + confounds paragraph in §3; §4/§5 headings
and §7 table relabeled). M7 DONE (kill condition restated with four numeric thresholds,
prospective commitment). M8 DONE (abstract rewritten: names daftari and preserve-not-resolve,
states the keystone, leads with 17/18 + Mem0 26/33, bolding stripped). M9 tables DONE
(daftari row + Haiku-4.5 versioning + denominators in §6; §7 de-densified with axis labels,
units, Mem0 row, mixed-dataset footnote) and figure specs placed as bracketed
to-be-drawn-at-conversion placeholders (Fig 1 two-regime 2×2 in §3, Fig 2 three-panel
mechanism in §2). M10 DONE (UIST '23 + DOI, ICLR 2025, NeurIPS 2025 in .bib and in-draft
list; Zep blog urldate; AIS→Computational Linguistics swap deliberately NOT made, needs
verification first). Minor list DONE except: bold-reduction sweep (Minor 4, best done at
LaTeX conversion), title decision (Minor 9, author's call; candidates in plan), LaTeX
mechanics (Minor 10, conversion-time).

**Third pass, 2026-07-01 evening:** M4(ii) RUN — and the instrument broke first. The author
rated the blind sheet (6 tensions + 3 settled controls); post-hoc clarification confirmed he
read Q1 as textual conflict, answering 0/6 on the tensions, the inverse of the LLM gate's
near-uniform yes. Findings folded into §6/§8: (a) the gate question is ill-posed (meaning
flips between raters) so the CB6 second-rater gate now carries no evidential weight in the
paper; (b) the human 0/6 independently reproduces the not-text-recoverable claim (§5's
detector 2–4/33, human analogue); keystone unaffected (ground truth = editor closes).
Results: `docs/superpowers/results/2026-07-01-cb6-human-rater-pass.md`. M4(ii) is REPLACED
by an independent non-author rater with the two-part instrument specified in that results
doc (distinctness/fairness + status-determinability), still OPEN.

**Fourth pass, 2026-07-02:** M4(ii-replacement) DONE. Independent non-author rater (blind)
on the fixed instrument: distinctness 4/6 tensions + 4/4 controls (the two NOs are
the near-paraphrase pairs); fairness 4/6 with both objections naming the author-distilled
alternative side (disclosed in §8 as distillation defects; keystone robust to dropping the
two items, 11/12); outcome-from-text: 3/9 cannot-tell, 6 asserted winners all
first-position, 1/3 on controls (chance) — the human analogue of the abstain-offered foil's
position bias, folded into §6. Results:
`docs/superpowers/results/2026-07-02-cb6-independent-rater-pass.md`.

**Fifth pass, 2026-07-02:** B4 DONE (draft-status header reduced to a bare date line; §9
grounding parenthetical deleted, its one useful clause folded into §9 prose; References
preamble deleted; Appendix A reframed as pointers to released run notes in the repository).
Minor 4 bold sweep DONE (46 spans stripped from result numbers and mid-sentence emphasis;
three §6 result-bullets restructured to short bold labels; remaining bold = run-in
headings, first-use coined terms, table labels, reference keys, per policy).

**Title DECIDED 2026-07-02 (Minor 9):** option 1, "Preserve, Don't Resolve: Non-Fabrication
and Provenance as the Evaluation Axis for Agent Memory". Rationale: claim-first, survives
truncation, and the "Preserve, Don't Resolve:" prefix is reserved as the series brand for
the companion loop paper; the two-regime methods clause moved fully into the abstract.

**AIS venue VERIFIED 2026-07-02:** Computational Linguistics 49(4):777-840, Dec 2023, MIT
Press, DOI 10.1162/coli_a_00486 (ACL Anthology 2023.cl-4.2; author list matches ours
exactly). Swapped to @article in references.bib and updated the in-draft entry.

**LaTeX first pass DONE 2026-07-02 (Minor 10):** `docs/paper/latex/preserve-dont-resolve.tex`
+ self-contained `references.bib` copy; xelatex via latexmk, 21 pp, zero errors/undefined
citations; both figures drawn in TikZ from the placed specs; keystone = numbered Invariant 1;
prompts byte-faithful; faithfulness verified paragraph- and cell-level against the markdown.

**Source-of-truth DECIDED 2026-07-02: the markdown is canonical.** All content edits go to
`preserve-dont-resolve.md`; the `.tex` is a build target and must be re-ported (or
regenerated) after any markdown change, never hand-edited for content. Second-pass polish
noted for the port: Figure 1 panel (b) spacing, monospace prominence of model slugs, and
residual overfull-hbox cosmetics.

Every item in this plan is now closed. Remaining pre-submission work lives outside the
plan's scope: content freeze, final re-port to LaTeX, and arXiv packaging.

**Verdict: MAJOR REVISION.** The empirical core is real and honestly recorded in the repo; 41 of 44
quantitative claims in the paper match the artifacts verbatim. The recurring failure mode is that
**the evidence notes are more honest than the manuscript**: the single-run caveat, the LLM identity
of the second-rater, the not-yet-run perturbation, and the abstain-vs-forced condition labels are
all correct in `docs/superpowers/results/` and were degraded on the way into the paper. Most of this
plan is "promote the repo's honesty into the manuscript." One new experiment is recommended; the
rest is text.

---

## Blockers (correctness; fix before anything else)

### B1. §5 mislabels the CB4 panel condition as "forced" (lines 201–207)
The paper's §5 topic sentence says the minting foil was "**forced** to assert a directional
supersession" and implies only GPT-4o had the abstain option. **[DATA]** CB4's model-panel section
(`2026-06-28-corpus-b-cb4.md:96`) is explicit: all three models ran the **abstain-offered** foil
("the NEITHER option is available"), and every model used it (Haiku "neither" 5/33, GLM 11/33,
GPT-4o 25/33). The paragraph's own closing sentence, the §7 table, §8, and the Appendix already use
the correct label, so §5 is internally inconsistent — and the forced/abstain distinction is the one
distinction the whole paper turns on. A reviewer catches this without repo access by diffing §5
against §7.
**Fix:** rewrite lines 201–204 to open with the abstain-offered framing ("Offered an abstain
option, a value-minting baseline asked for a directional supersession verdict fabricates: F = 26/49
Haiku-4.5, 24/49 GLM-4.6, 6/49 GPT-4o, which takes the abstain it is offered, neither on 25/33 real
pairs"). Reserve "forced" for CB6 (§6) and contracts Arm B (§4), and say explicitly that the forced
condition on this corpus exists only in §6's n=6.

### B2. §5 claims a contamination control that was not run (lines 182–184)
The paper: "memorization is controlled by post-cutoff items (2025–26) **and value-perturbation**."
**[DATA]** Pre-cutoff perturbation appears only under "Next (separate)" in CO2 (`co2-pilot.md:82`),
CB4 (`cb4.md:89`), and CB5 (`cb5.md:177`) — it was **not run** on corpus B. The foil panel read
real, unperturbed, largely pre-cutoff Wikipedia text. Perturbation is real only on contracts (§4).
**Fix:** reword §5 to exactly what was done: (i) label-side contamination controlled by using
editor closes, no LLM labeler; (ii) post-cutoff subset reported with counts — **[DATA]** 14/37
instances post-cutoff, 12 scorable, 12/12 recency-stale, agreeing with the full 33/33 (a robustness
note worth stating); (iii) foil-side pre-cutoff perturbation **stated as a limitation**, with the
mitigation that training-set familiarity should, if anything, help the foil abstain correctly, so
the fabrication numbers are conservative. In §4, add a short perturbation-procedure paragraph
(value classes, sampling, collision check with real amendment values, seed).

### B3. The "blind, cross-family second-rater" is an undisclosed LLM (lines 222–224, 293–295)
**[DATA]** CB6 (`cb6.md:6–7`): second-rater = `google/gemini-2.5-flash`, one run. The paper never
says the rater is a model; a reviewer reading "second-rater" assumes a human and discovering
otherwise reads as concealment — on the gate the paper itself calls "load-bearing, not decorative."
**Fix:** disclose the rater identity and prompt in §6 and §8. See M4 for the accompanying
validity work.

### B4. Meta/process notes and internal repo paths must be stripped
- Lines 3–5: draft-status header incl. internal design-doc path and "needs a grounding pass".
- Lines 310–314: §9 grounding parenthetical ("deep-research pass… re-verify currency again at
  submission") — a process log, not paper content.
- Lines 458–460: References preamble ("Reading copy… pending completion").
- Lines 500–511: Appendix evidence map points at private working-note filenames
  (`2026-06-27-a-small-experiments.md` etc.). Internal paths cannot appear in a public paper.
**Fix:** delete all four sites. Replace the appendix with either public artifact URLs/DOIs, a
supplementary-material bundle with self-contained names, or fold run identifiers into the
data-availability statement (see M6).

### B5. Citation correctness (three items, all verified live against arxiv.org 2026-07-01)
1. **`core_memory_replace` (§9, ~line 325) is not in the MemGPT paper.** **[DATA]** The string does
   not appear in 2310.08560; the paper uses `working_context.replace(...)`. The identifier is from
   the Letta implementation. Fix: quote the paper's actual call, or keep the identifier and add a
   citation to the Letta repo/docs. (This is exactly the kind of token an adversarial reviewer
   greps for.)
2. **Three "et al." entries are solo-author papers.** **[DATA]** Du (2603.07670), Roynard
   (2604.11364), Z. Wang (2606.06240) are solo; ElephantBroker (2603.25097) has exactly two authors
   (C. Lupascu, A. Lupascu). The preamble's claim that only SmartVector and Portable Agent Memory
   are confirmed solo is wrong. Fix in both the in-draft list and `references.bib`.
3. **Complete all author lists** — the full lists were retrieved and are in the citation audit
   (all 16 IDs verified; no mismatches). The "pending completion" debt is fully payable now.

---

## Major (methodology and apparatus)

### M1. "Control/treatment" language is unearned (abstract, §3, §4–5 headers)
No randomization, no matched units; the corpora differ on genre, ground-truth source, task shape,
and unit of analysis besides recency-resolvability. §3's "a design, not a sample size" rebuts the
wrong objection. What the paper actually has is a legitimate **most-different-cases / severe-test
design**.
**Fix:** rename to "two contrasting regimes" (recency-works / recency-fails); keep
control/treatment at most as explicitly-defined shorthand. Add a short confounds paragraph in §3
listing the other axes of difference and why the invariance argument survives them (the claim is
existential-per-regime, not a corpus-level effect estimate).

### M2. Uncertainty and unit-of-analysis reporting
- **17/18 ignores item clustering:** the 18 trials are 6 items × 3 models and verdicts cluster by
  item. Report item-clustered: **6/6 items masqueraded by ≥2 of 3 models** (Wilson [0.61, 1.00]);
  keep 17/18 as the trial count. Conclusion survives.
- **Add exact binomial CIs** for headline fractions (33/33 → one-sided 95% lower bound ≈ 0.91).
- **n=2 provenance and n=7 partials are existence demonstrations, not rates.** Soften "Provenance
  is the axis where the gap is not soft" (line 169–170) to match n=2; note in §4 (not only §10)
  that both foils fabricated the *same* 4 of 7 clauses — fabrication is clause-driven.
- **Single-run nondeterminism must be disclosed:** CB6's note says abstain-offered numbers shift
  run-to-run at temp 0 and "should be read as one sample." Put that in §6. A reviewer who finds it
  in the repo but not the paper will assume selective reporting.

### M3. No real consolidation system was run — the one new experiment worth doing
All three foils are prompt-level simulations; Graphiti is positioned as the §5 foil behavior with
the confession "(we did not run Graphiti)" buried in a §9 parenthetical. Real consolidators' write
paths have an implicit **no-op** (Mem0's fourth op is NOOP — **[DATA]** verified in 2504.19413), so
the forced condition may be harsher than any deployed architecture.
**Fix (preferred):** run one OSS consolidator's actual write path — Mem0 or Graphiti — on the 39
Wikipedia items (33 traps + 6 tensions), ingest stale-then-governing (and both tension positions),
inspect the store: one value kept? which? history survives? Bounded, ~CB6-scale cost. This converts
§5–§6 from "a prompt shaped like a consolidator" to "a consolidator."
**Fallback if infeasible:** (i) retitle foils as "consolidation *models*" throughout; (ii) promote
the not-run admission from §9 parenthetical to §3/§8 as a first-class limitation; (iii) soften every
sentence naming a real system as exhibiting the measured foil behavior. Also either way: acknowledge
the no-op middle case (neither mint nor labeled abstain) in §5/§6.

### M4. The distill-then-gate pipeline needs validity work (with B3)
The gate approved 6/6 with zero negative controls — a gate that has never rejected anything is
asserted, not shown, to discriminate.
**Fix:** (i) feed the gate 6–10 *settled* supersessions (from the 33) phrased identically to the
tension pairs; report the rejection rate. (ii) Add one human rater pass over the 6 pairs and report
raw agreement counts (no kappa needed at n=6). (iii) Disclose distillation is author-performed.

### M5. §8's abstention critique is asymmetric until daftari's own coverage is stated
§8(i) attacks GPT-4o's abstention ("low fabrication bought with low recall") but the paper never
states daftari's Arm C coverage: **[DATA]** 16/33 localized, abstains on the rest. The quantitative
answer is in the repo and unused: on the same 33 pairs, **daftari 16 correct / 0 wrong; GPT-4o
(abstain-offered) 3 correct / 5 wrong / 25 abstained** — strict dominance on both axes.
**Fix:** put that comparison in §8(i) and report the 16/33 coverage in §5. Also reframe the daftari
rows of all tables as **implementation-correctness checks** (a bug in chain-following could have
made 0/33 fail; the 0/16 false-positive control is the cleanest daftari-side number), which
dissolves the tautology objection cleanly.

### M6. Missing reproducibility and publication apparatus
- **Code/data availability:** the paper claims a by-construction guarantee about an implemented
  system and releases nothing. State: daftari repo + license, eval scripts, contract fixtures
  (noting perturbed ≠ verbatim filings), the 33-trap + 6-tension Wikipedia item list.
- **Exact prompts** (forced, abstain-offered, contradiction detector — surface its "no directional
  language" unit test, a genuinely good touch — cross-judge protocol, second-rater) in an appendix.
- **Model snapshots and access route:** "GPT-4o / Haiku-4.5 / GLM-4.6" need API snapshot IDs,
  access dates, and the fact that routing went through OpenRouter.
- **Runs/temperature/cost:** single run, temp 0, ~$2–4 per experiment.
- **Attrition accounting:** 37→33 scorable (4 multi-hunk), Arm C 16/33 localized, and the
  unparseable first CB4 run + fix — disclose the re-run.
- **Ethics/licensing:** Wikipedia Talk-page text is CC BY-SA 4.0 (attribution for quoted consensus
  text and released data); editor usernames in released alignments (public, but say how handled);
  SEC EDGAR usage terms.
- **Front matter:** authors, affiliations, contact, date; acknowledgments; a short conclusion
  section; arXiv category decision. Record the anonymization decision explicitly (paper is
  deanonymizing by construction — fine for arXiv, fatal for double-blind).

### M7. Kill condition needs thresholds and a prospective form (§8, lines 301–306)
"Abstains as reliably as daftari" and "without sacrificing recall" have no numbers, and "Measured:
it does not" quantifies over all consolidation baselines while only three prompted foils were run.
**Fix:** restate with released-harness thresholds, e.g.: killed if any consolidation system
achieves fabrication ≤ X/49 **and** masquerade ≤ Y/6 **and** governing attribution ≥ 5/6 incl.
both partials **and** correct-answer coverage ≥ 16/33, on the released fixtures. Commit to running
submitted baselines.

### M8. Abstract rewrite (lines 9–30)
One 230-word paragraph that never names daftari, never says "preserve-not-resolve," never states
the keystone invariant, and omits the paper's best number (17/18) while spending words on the
§4-mechanism detail (>100:1).
**Fix:** four moves — (1) accuracy is the wrong axis once recency wins it; (2) the two guarantees,
the name, the invariant; (3) two contrasting regimes on the recency axis; (4) the invariance +
17/18 forced masquerade vs 0 minted. Strip all bolding; cut >100:1 and "drafting convention";
compress the closing hedge.

### M9. Tables and figures
- **§6 table (231–234): daftari's row is missing** — the 0/6 that is the point of the section lives
  in a prose bullet while the foils get the table. Add `daftari (structural) | 0/6 | 0/6 | 0/6`.
  Version "Haiku" → "Haiku-4.5"; caption must define cells and denominators.
- **§7 table (251–256):** "F=6–26/49" is ambiguous (6–26 out of 49?). Write "6/49–26/49 across
  models"; label the empty corner cell; give the "daftari mints 0 | 0" row units; footnote that
  the Wikipedia cell mixes two datasets (17/18 over 6 tension items; F over 49 pairs).
- **Zero figures.** Add two: (1) mechanism diagram in §2 — supersession pointer vs tension edge vs
  the one-slot store forced to overwrite (the masquerade), replacing ~15 lines of prose; (2) the
  two-regime 2×2 in §3 carrying the §7 numbers as the visual form of the invariance argument.
- Add the **position-bias observation to §6** (it held there too per CB6's note; currently §5-only)
  — it is the best evidence the forced output is artifact, not judgment.

### M10. Venue-of-record swaps (verified live)
Generative Agents → UIST '23 (DOI 10.1145/3586183.3606763); Trust-Align → ICLR 2025; A-MEM →
NeurIPS 2025; AIS/Rashkin → Computational Linguistics 49(4) 2023 [TRAINING — verify before
swapping]. Add `urldate` to the Zep-blog @misc (post dated 2026-06-23, verified resolving
2026-07-01). Convert bracketed-ID inline cites to natbib keys at LaTeX conversion (keys exist).

---

## Minor (terminology, prose, structure)

1. **Undefined/internal terms** (line refs): "trust budget" (431 — unparseable externally; define
   or rewrite), name the invariant "the keystone" at its line-53 introduction (first use is
   line 73 unanchored), "sovereignty" (3 — dies with the header; keep it out of body), "cortex"
   (95 — gloss or drop), "Arm B" (435 — say "the forced-minting condition on contracts (n=7)"),
   E3/CO2/CB4–CB6 (appendix — internal run IDs), expand MCP (78) and RfC (222), "value-minting"
   used in abstract before any gloss (20), "the empirical companion paper" ×3 (85, 299, 433 —
   cite it or say "a companion study, in preparation" once), unify "stream-recency" (186) vs
   "most-recent-mention" (150) or distinguish them in one sentence, gloss "bi-temporal" at
   first use (340).
2. **§9 compression (~25–30%):** ElephantBroker is argued three times (§8 bullet 282–289, §9
   367–381, gap list 399–407) — make §9's four-point treatment canonical and point the others at
   it. Halve the 13-line substrate bullet (413–425); the invert-the-critique move is two sentences.
   Move "(we did not run Graphiti)" per M3.
3. **Em-dash-purge residue:** comma splices doing em-dash work at 68–70 ("invariance, that" —
   needs a colon), 258–260 (triple appositive), 350–351; sweep former em-dash sites. Em-dash
   compliance itself: PASS (zero remain).
4. **Bold reduction:** 60+ bolded spans; §4 bolds whole result sentences. Policy: bold only
   defined-term first uses and table row labels.
5. **Rhetorical asides:** five ("Good: it forces…", "Not a sterile tautology…", "The honest
   softness, quantified.", "we report the gap rather than hide it", "We take the point and invert
   it") — keep two at most.
6. **Roadmap sentence (72–74)** omits §9–§10; extend.
7. **Line 166 "4/4":** artifact reports governing 4/6 overall; the paper's clean/partial re-slice
   (4/4 + 0/2) is arithmetically faithful but a reviewer diffing artifacts sees 4/6 — state both.
8. **"daftari" capitalization policy** at sentence starts (239 etc.); pick one (small-caps in
   LaTeX) and apply.
9. **Title:** 21 words, methods clause in the title. Preferred alternative: *"Preserve, Don't
   Resolve: Non-Fabrication and Provenance as the Evaluation Axis for Agent Memory"*; bolder:
   *"A Tension May Never Masquerade as a Supersession: Structural Non-Fabrication for Agent
   Memory"*.
10. **LaTeX conversion mechanics:** blockquote invariant → named, numbered display (Invariant 1)
    so §6 can cross-reference it; unicode arrows/×/§ → LaTeX; `code` spans → `\texttt{}`; drop
    manual section numbers; captions + booktabs for all tables.

---

## Execution order

| Phase | Items | Nature |
|---|---|---|
| 1. Correctness (do first, small diffs) | B1, B2, B3, B5.1–5.3, M2 (disclosures), M5 (add comparison) | text-only, ~1 session |
| 2. Framing | M1, M7, M8, first half of Minor 1–7 | text-only |
| 3. Experiments | M3 (real consolidator write path), M4 (gate negative controls + human pass) | ~CB6-scale cost + ~1 hr human |
| 4. Apparatus | M6 (prompts, snapshots, availability, ethics, front matter), B4 (strip meta + appendix rework) | mechanical |
| 5. Presentation | M9 (figures + tables), M10, Minor 8–10, LaTeX conversion | last, after content is stable |

Phase 1 is worth doing immediately regardless of submission timeline: B1 and B2 are factual errors
in the current draft, and every day they sit there is a day a reader of the branch can catch them.

---

## What was verified vs relayed

Directly re-verified by the moderator against artifacts this session **[DATA]**: B1 (cb4.md:96
abstain-offered), B2 (perturbation under "Next" in co2/cb4/cb5), B3 (cb6.md:6 gemini-2.5-flash),
post-cutoff counts (co2-pilot.md:5,32), Arm C 16/33 coverage. Citation verdicts are from a live
per-ID arxiv.org pass (all 16 resolve, titles/authors as reported; `core_memory_replace` absent
from 2310.08560 full text). Grounding audit: 44 claims checked, 41 verbatim matches, 1 mismatch
(B1), 2 external-citation figures (both verified live: Cartridges 38.6×/26.4×, Wallat "up to 57%",
plus the Graphiti quote and all five ElephantBroker mechanics — 5/5 body-grounded).
