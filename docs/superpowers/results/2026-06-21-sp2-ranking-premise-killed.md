# SP2-as-ranking is the wrong lever for journal corpora — premise killed in spec review

**Date:** 2026-06-21
**Cost:** $0 (caught in design review, before any implementation or inference).
**Outcome:** The SP2 "supersession-aware ranking" experiment, as designed for Recall Bench EA-180d, is **not viable** — not because the spec was sloppy, but because the corpus violates the thesis's precondition. This redirects the programme.

## What SP2-as-ranking assumed

SP1 ([2026-06-21-recall-bench-baseline.md](2026-06-21-recall-bench-baseline.md)) showed ~15% hallucination driven by daftari returning **stale** versions of revised facts; root cause is that `hybrid.ts` scores on pure lexical+semantic similarity and ignores supersession. The SP2 thesis: **wire supersession into `hybrid.ts` ranking so the current-version document outranks the stale-version document.** The planned cheap test: oracle supersession edges from corpus ground truth + a default-off downweight flag, measuring "current-above-stale rate" — zero inference.

That thesis has a hard precondition: **the current value and the stale value must live in *separate* documents**, so that ranking can move one above the other.

## Why it's killed (verified against the corpus, not assumed)

Recall Bench EA-180d is a **daily-journal** corpus — one running entry per day that *restates current state*. Three verified facts break the precondition:

1. **Supersession is intra-document.** `memories-180d/day-0100.md` carries both values in one document: *"Current working base case: **$465M**"* (line 299) and *"Superseded banker memo: **$510M**"* (line 301). `day-0001.md` records the 7:00 AM assumption and initializes the 6:30 AM habit in the same entry.
2. **The probing QAs share the same document.** `q001` ("the initial assumption … *before* it was corrected" → 7:00 AM) and `q002` ("the stable target *after* the correction" → 6:30 AM) **both have `relevant_days: [1]`.** Historical answer and current answer are in the same retrievable unit.
3. **n = 2 tagged corrections** in the entire arc set — no statistical room for a "rate" even if the structure cooperated.

**Document ranking cannot separate two values inside one document.** Worse, downweighting "the stale doc" would also downweight the *current* value it contains, and would actively break the historical-seeking QAs that point at the same doc. The metric would also be confoundable — "current-above-stale" could rise simply from date-flavored suppression, which fidelity constraint #2 (edge-based, not recency) forbids.

## The real finding

**In journal/narrative corpora, supersession is a within-document / fact-atom problem, not a document-ranking problem.** The lever that helps is **fact extraction**: pull atomic claims out of the running text and attach `superseded_by` edges *between atoms*, so the unit of supersession matches the unit of truth. That is the cortex consolidation loop's job — **SP3 territory, not a `hybrid.ts` change.** The corpus is telling us the bottleneck is **atomization, not ranking.**

## Scope — do not overgeneralize the negative result

This kills SP2-as-ranking **for journal-style corpora**, not the ranking idea in general. daftari's **native** model is one fact per markdown file with `vault_supersede` edges *between files* — there, supersession *is* a document-relationship and a `hybrid.ts` downweight is the right, testable lever. So:
- **Recall Bench EA:** ranking is the wrong lever (this note).
- **Native daftari vaults:** ranking may still be the right lever — but that needs a native/synthetic corpus to test, not Recall Bench.

## Programme impact

- **SP2-as-ranking on Recall Bench: dropped.**
- **SP1 baseline stands** as a valid, real result (the $400 was not wasted — it's the published degradation/hallucination baseline).
- **Recall Bench's value to daftari is now twofold:** (1) the SP1 retrieval-fidelity baseline, and (2) empirical evidence that the supersession bottleneck is *atomization*, which motivates **SP3 (cortex-loop fact extraction + atom-level `superseded_by`)** as the next real experiment — with the caveat that SP3 reintroduces LLM inference (atom extraction), so it is *not* a zero-cost test.
- The `hybrid.ts` supersession flag itself was never written (design-stage kill), so there is no dead code to remove.

## Kill condition (met)

The SP2-ranking thesis required separable stale/current documents. Verified absent in EA-180d (intra-document supersession, shared `relevant_days`, n=2). Precondition fails → thesis untestable on this corpus → killed here rather than after an expensive, confounded run.

## What review caught (process note)

This was found by the spec-review step *before* any code or inference — the cheap-to-run, $0 retrieval test would have produced a plausible-looking "current-above-stale improved" number that was actually date-suppression artifact. The review's verified blocker (intra-document co-residence) is exactly the class of error a green metric would have hidden.
