# Feasibility probe (B) — a human-decision corpus where recency fails

**Date:** 2026-06-27
**Question:** Does a real, assemblable corpus of human decision records exist where (i) most-recent-mentioning recency genuinely *fails* (current decision ≠ most-recent mention) and (ii) ground truth is cleanly labelable **without an LLM labeler contaminating the result**? This is the gate (B) was scoped on.

## Verdict: FEASIBLE — Wikipedia "Current consensus" subpages.

And it is arguably a *better* corpus than contracts for daftari's full thesis, because it exercises the keystone guarantee contracts structurally couldn't (genuine tensions / contested cases, not just clean supersession).

## The corpus

Wikipedia's most-contentious articles maintain a `Talk:<Article>/Current consensus` subpage — a numbered list of editorial decisions, each linking its establishing discussion, with **explicit, dated, chained supersession** ("item #1 superseded by #35"; on Trump the lead-paragraph wording runs **#11→#17→#50→#70**). Backed by a reusable `Template:Current consensus editnotice` and an "cite consensus item N in your edit summary" protocol.

- **Seed set (formal subpages, ~8):** Donald Trump (76 items, Dec 2016–May 2026), Joe Biden, Ronald Reagan, COVID-19 pandemic, SARS-CoV-2, COVID-19, Albania–Greece relations, Collaboration in German-occupied Poland. Diversity: politics / science / history / international relations.
- **Scaling path:** RfC closures ("the result was X", later superseded by a new RfC) are far more numerous across Wikipedia — the same structure without the formal subpage.

## How it maps to the daftari thesis (and clears the gate)

| Need | Contracts gave | This corpus gives |
|---|---|---|
| Input stream (messy, recency-fails) | — (amendments are clean) | **the talk-page archives** — years of timestamped discussion where editors re-litigate and restate superseded positions |
| Ground truth (current decision) | the restated clause value | **the human-maintained consensus box** — the current item in each supersession chain |
| Supersession labels | the amendment's clause citation | **the consensus box's explicit #N-supersedes-#M chains, dated, with discussion links** |
| Labeler contamination | none (EDGAR labels are free) | **none — the box is human-curated, not LLM-labeled** ← this is the gate, and it's cleared |
| Genuine tensions (contested) | absent (clean supersession only) | **present** — "no consensus was achieved on specific wordings" exercises *a tension may never masquerade as a supersession* |

The worry in framing (A) was that (B) would need LLM labeling of implicit supersession, contaminating the result. **It doesn't** — Wikipedia editors already did the labeling, for free, exactly as EDGAR did for contracts. The difference that makes (B) the *accuracy* corpus: the **input** (archives) is messy human discussion where recency fails, while the **labels** (box) stay clean.

## The one thing the build must verify first (the kill condition)

The recency-fails property is strongly *argued* but not yet *measured*: the entire numbered-consensus + edit-notice machinery exists **because** editors keep re-raising settled/superseded issues — that institutional response is the evidence. But the build's **step 1 must run the contract stale-mention probe in reverse on the talk archives**: sample mentions of a decided topic, and confirm that the most-recent mention is *often* a superseded position (recency fails). Contracts *failed* that probe (>100:1 toward clean); (B) only stands if Wikipedia archives *pass* it. Cheap to check, and decisive — if archives are also recency-resolvable, (B) collapses too.

## Honest gaps / risks

- **Recency-fails density unverified** (the kill condition above) — build step 1.
- **Scale:** 8 formal subpages is thin; needs RfC-closure chains (plentiful) to reach benchmark size. The 8 are item-rich (Trump alone = 76 items, multiple chains), so the seed is usable.
- **Contamination:** Trump/COVID are heavily in training data. Mitigate exactly as contracts did — restrict test events to **post-cutoff consensus items** (Trump #67–76 are 2025–26) + value perturbation. This constrains usable N.
- **Alignment labor:** scoring recency-failure needs mapping an archive comment → the consensus item it (stale-ly) invokes. That's *alignment*, not supersession-labeling (the box gives supersession) — lighter than full LLM labeling, but real, and the place an LLM aligner could re-introduce contamination. Use string/citation anchors (editors literally cite "consensus item N") to keep alignment deterministic where possible.
- **Optics:** contentious political topics invite scrutiny in a paper; lean on the science/history/IR subset to diversify away from US politics.

## Recommended next step (its own brainstorm, then build)

(B) is GO. Before building, brainstorm the corpus design as a unit: the archive→consensus alignment method (deterministic edit-summary citations vs. an aligner), the post-cutoff/perturbation contamination plan, and the exact QA buckets (current-decision, superseded-restatement-trap, live-tension-not-supersession). Then build acquisition (the Wikipedia-API analog of E1) and run the recency-fails kill-condition probe (step 1) before anything else.

## Where this leaves the two-paper plan

- **(A)** = contracts: explicit-supersession control + sovereignty/provenance + the negative result (recency suffices, structurally). Draft-ready pending its two small experiments.
- **(B)** = Wikipedia consensus: the accuracy regime where recency fails, with clean human labels and genuine tensions. **Feasible**, gated on the step-1 probe.

Together they are the two-corpus contrast the empirical paper needs: *explicit-supersession-but-recency-works* (contracts) vs *recency-fails-with-clean-labels-and-tensions* (Wikipedia consensus). daftari targets the intersection, and (B) is the corpus that actually exercises all three guarantees (current / grounded / contested).
