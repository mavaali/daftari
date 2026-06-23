# Results — Coverage recall measurement (coverage retrieval Stage 3)

**Date:** 2026-06-22
**Spec:** `docs/superpowers/specs/2026-06-22-coverage-recall-measurement-design.md`
**Harness:** `integrations/recall-bench/{prep-vault,recall-runner}.mjs` (LLM arm `llm-arm.mjs` not run — gated out, see below)
**Verdict:** **KILL at the recall gate.** The shipped coverage pass's date-window mechanism does **not** beat naive rank-extension on Recall Bench (RB) — it is strictly worse at every retrieval budget. No LLM arm was run (correctly: the staged design caught the null for `$0`).

## What was measured

RB's 180 tag-less journal day-files were indexed as a daftari vault with a uniform `tags: [daily]` and injected `created` dates, so the shipped coverage code fires as **pure date-window gathering** (the half that applies to a journal; the discriminating-tag half is untestable on RB — out of scope). For each of 1,489 questions we retrieved once and computed two recall curves over the addition budget `m`:
- `coverage-recall(m)` — top-`10` seeds ∪ the first `m` date-window candidates (the real `applyCoveragePass`, sliced; faithfulness asserted at runtime).
- `rankExtension-recall(m)` — top-`(10+m)` by relevance (the matched-budget control: does date-window *selection* beat just asking the ranker for more?).

`recall = |returnedDays ∩ relevantDays| / |relevantDays|`, multi-day questions only (979 of 1,489; single-day excluded because coverage adds only noise there). The multi-day span-length distribution confirmed the spec's prediction: **698/979 (71%) are exactly 7-day weeks.**

## Result: rank-extension dominates at every budget

| budget `m` | coverage-recall | rank-ext-recall | gap (rx − cov) |
|---|---|---|---|
| 0 (top-10) | 0.221 | 0.221 | 0.000 (identical) |
| 5 (as-shipped) | 0.265 | 0.292 | **+0.027** |
| 10 | 0.316 | 0.358 | **+0.041** |
| 20 | 0.339 | 0.423 | **+0.083** |
| 50 | 0.417 | 0.531 | **+0.113** |
| 90 (uncapped) | 0.517 | 0.547 | **+0.029** |

The gate (spec §5) was: *proceed only if `coverage-recall` sits ≥5pp **above** `rankExtension-recall`.* It is **below** at every point. **Kill.** Per-question, at the as-shipped `m=5`: coverage **ties 72.3%, wins 6.4%, loses 21.2%**.

## Why it loses — decomposed (this is the interesting part)

**1. The date-window doesn't *reach* the relevant days for ~half the questions (the fundamental failure).** Coverage's structural ceiling — recall if it added the *entire* window — is only **0.52**. Only **48.8%** of multi-day questions have all relevant days in-window; **49% miss more than half**, even uncapped. Concrete example:

```
Q: relevant week = days 15–21
   top-10 ranked seeds land on days 55,66,67,68,73,75,77,82,112,168
   → date-window = 55..168 → relevant days in window: 0 / 7
```

The premise the date-window rests on — *"relevant docs are temporal neighbors of the top hits"* — is **false on a topical journal.** The ranker surfaces topically-related days scattered across the whole timeline; the relevant week is somewhere else. Anchoring a window on the top hits' dates gathers the *wrong dates*.

**2. Even within reach, recency-ordering adds distractors.** Added-day precision is **5.7%** at `m=5` — of the 5 days coverage adds, ~0.29 are relevant, ~4.7 are distractors. The shipped `gatherCandidates` takes the *newest* in-window days, which are rarely the relevant ones.

**3. Relevance just beats date-proximity.** In 32% of questions rank-extension reaches relevant days *outside* the window — relevance directly targets them while date-proximity is a weak, usually-wrong proxy.

**By span length:** the only length where coverage's ceiling edges out rank-extension is 5-day spans (0.746 vs 0.693). For the dominant 7-day spans, coverage ceiling 0.46 vs rank-extension 0.48 — the window can't contain a temporally-scattered 7-day span.

**Design implication:** re-ordering candidates by relevance/proximity instead of recency would fix #2 but not #1 — the anchoring model itself is wrong for journals. This is, if anything, **evidence for the discriminating-tag half of coverage** (untestable on tag-less RB): a tag targets the topic cluster wherever it sits in time, which is exactly what the date-window can't do.

## Why this matters: it explains how ContextForge beats daftari on RB

This experiment incidentally quantifies the bottleneck behind daftari's RB scoreboard gap.

- **[MEMORY, prior source-verified]** RB numbers were daftari 81.8% composite / **15.2% hallucination** vs ContextForge 85.8% / **1.6% hallucination**. The composite gap is small (both nail the easy single-day/recency questions); the hallucination gap is the whole story.
- **[DATA, this session]** daftari's 15.2% hallucination *is* retrieval misses. When the ranker doesn't surface the relevant week — multi-day recall **0.22**, i.e. ~78% of the time — the answerer fabricates or punts. We measured exactly that miss rate, and showed coverage's date-window can't fix it.
- **[MEMORY]** ContextForge doesn't retrieve-then-read. Its `wiki.py` is a **deterministic regex pass at ingest** that consolidates the journal into a current-state structure off RB's marker-narrated corrections; at query time it does a **structured lookup**, not a retrieval. It is immune to the bottleneck we measured. Its 1.6% hallucination comes from never retrieving the wrong days.

So: **CF moved the work to ingest and sidesteps retrieval; daftari fights it at query time and loses, because retrieval recall on temporally-scattered topical questions is poor.** RB specifically rewards CF — it is 100% recency-resolvable and its corrections are marker-narrated, so a zero-LLM regex is both cheap *and* accurate, and the usual danger of consolidation (fabrication when synthesis is wrong) doesn't bite a deterministic extractor.

**The strategic read [HYPOTHESIS]:** daftari's thesis — lossless substrate, author relations not minted values, retrieve at query time — is *strictly disadvantaged* on a recency-resolvable journal, and RB is that journal (consistent with the prior "RB is the wrong scoreboard" conclusion). The daftari-native way to close the gap *without* betraying the thesis is not "retrieve better" — it is **consolidate at ingest like CF, but by atomizing / authoring edges rather than minting a value** (the cortex loop, SP-B/SP-C), making the current value *retrievable* without *fabricating* it. Whether that stays cheap, and whether it beats CF's regex on a corpus where CF's regex breaks, is the untested bet.

## Honest Assessment

- **This is a real, decisive negative — for the date-window half on journals.** It does not condemn coverage's discriminating-tag half on native vaults (distinct tags, curated clusters), which is where the feature was designed to shine and which RB cannot exercise.
- **Scope:** date-window mechanism only; multi-day questions only; RB has no `superseded_by` edges, so SP-A suppression never engaged (a second reason RB is the wrong surface for the full feature).
- **The deeper finding outlives coverage:** daftari's baseline multi-day retrieval recall is 0.22 — the ranker frequently isn't surfacing the relevant week at all. That is the recall problem the whole thread named, and coverage cannot paper over it because it anchors on the (wrong) top hits. The lever remains `hybrid.ts` ranking recall.
- **Kill condition status:** TRIPPED. Coverage curve never exceeds rank-extension at any budget → LLM arm correctly not run → no spend. The staged design did its job: a `$0` arm prevented a ~$hundreds run to discover a null.

## What ships from this

- Harness (`prep-vault.mjs`, `recall-runner.mjs`) committed and reproducible.
- Stage 3 is **complete with a negative verdict**. No code change to the shipped coverage feature is warranted by this result.
- Forward: (a) the discriminating-tag half needs a **native vault with a labeled relevant-set** to be tested at all; (b) the real recall lever is baseline ranking, not date-window expansion; (c) the ingest-time consolidation question (cortex / SP-B / SP-C) is where the CF comparison actually points.
