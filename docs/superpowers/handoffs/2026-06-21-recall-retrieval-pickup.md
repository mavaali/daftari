# Handoff — edge-aware coverage retrieval (the recall feature), ready to brainstorm

**Date:** 2026-06-21
**One-line:** Recall Bench analysis proved daftari's dominant failure is **retrieval recall** (not supersession), and the fix is a **two-lever** retrieval feature. The scope is settled to **edge-aware coverage retrieval**; the brainstorm is paused at that framing, ready to resume design. Start a fresh session here.

## Why a new session
The prior session shipped SP-A (current-source foregrounding) → **v1.27.0 released**, then ran the Recall Bench re-analysis + two experiments, then began this brainstorm. Context is deep; this feature is new scope. Resume clean.

## The settled conclusion (all verified, all on main except where noted)

**daftari's RB failure is two levers, not one** — established empirically this session:
1. **Span recall (dominant).** 68% of RB hallucinations are recall-misses (the relevant days were never retrieved); only 32% disambiguation. Multi-day questions hallucinate 18.2% vs single-day 9.4%. **Oracle arm: supplying the true relevant span cut recall-miss hallucination 27.8% → 1.3%** (same answerer, only context changed). The feared "confabulation floor" was a mirage — true oracle ceiling ~1%.
2. **Distractor suppression (causal).** Adding the co-ranked **stale** distractor docs back to a *correct* context re-induced hallucination **0% → 28%** (disambiguation) / **0% → 19%** (recall-miss). So clean context ≈ 0%, but stale distractors break it.

**SP-A is rehabilitated as the suppression lever.** Foregrounding/demoting via `superseded_by` (shipped in v1.27.0) IS distractor suppression. Its only RB blockers were (a) the relevant doc must be retrieved first (recall) and (b) supersession edges must exist (raw RB has none; a native vault has them). So the recall feature and SP-A compose.

**Artifacts:** results `docs/superpowers/results/2026-06-21-recall-vs-disambiguation.md`; experiment brief+results `docs/superpowers/drafts/2026-06-21-recall-oracle-experiment-brief.md`. PRs: [#148](https://github.com/mavaali/daftari/pull/148) merged (analysis + oracle), [#149](https://github.com/mavaali/daftari/pull/149) open (the distractor placebo — **merge this**). Memory: `project_recall_bench_experiment`, `project_currentstate_projection`.

## The feature scope (settled with Mihir 2026-06-21)

**Edge-aware coverage retrieval** — ONE retrieval primitive that degrades gracefully across vault maturity, not two competing modes. The reasoning that settled it (Mihir's question: "would corpus-agnostic retrieval be wasteful on native vaults?"):
- On a **mature native vault** (one-fact-per-file + edges), pure lexical "coverage" is wasteful + noisier — it ignores the curated edge graph the cortex loop paid to build. Edge-following dominates there.
- But edge-following alone whiffs on **cold-start / edge-sparse regions**, **non-derivational relatedness** (two facts about the same entity that don't derive from each other), and **imported journals** (the RB-like corpus the evidence came from — edge-free until atomized).
- ⇒ The non-wasteful design is **edge-aware**: prefer the edge graph where dense, fall back to / blend with lexical/entity coverage where sparse. Recall (assemble the cluster) and suppression (foreground current, demote stale = SP-A) are the **two design axes**.

## What exists vs net-new (verified via Explore this session, cite before trusting)
- `vault_search` (`src/tools/search.ts`): args = `query`, `limit` (default 10, max 50), `weights`. **No date/tag/collection filter, no coverage mode.**
- `vault_search_related` (`src/tools/search.ts:164`): vector/lexical similarity, **NOT edge-following** (`hybrid.ts:285`).
- Edge store (`src/curation/edges.ts`): only `derives_from` (+ `superseded_by` as a frontmatter field, not an edge). `listEdges(filter)` is flat (by from/to/status, indexed `idx_edges_from/to`); **no graph-traversal API** — net-new.
- Index has `created`/`updated` but **no date-range query**; tags stored but **no tag-list retrieval**; `vault_themes` is k-means clustering, not entity coverage.
- Ranking (`hybrid.ts:177-236`): pure BM25+vector, top-N, **no diversity/MMR/temporal/coverage**.
- ⇒ **Every coverage lever is net-new** (traversal API, date-range, entity coverage, diversity rerank), but builds on the existing edge store + indexes + SP-A's `currentSource` consumption.

## Open design questions for the brainstorm (where it paused)
1. **Surface:** a new tool (e.g. `vault_gather`/`vault_timeline`) vs a `mode`/`coverage` param on `vault_search`? (Agent doesn't control its own search loop; daftari's lever is what one call returns.)
2. **Coverage trigger:** how is "I need the complete set" signaled — explicit param, or inferred (entity/temporal intent)? (Beware the query-conditioning fidelity trap from SP-A.)
3. **Edge blend:** when edges exist, how do they expand the result set — N-hop traversal from top lexical hits? union with lexical coverage? how to bound it?
4. **Lexical-coverage fallback:** "all docs matching entity X" (low-precision recall) vs date-window — which, and how to cap noise/tokens?
5. **Suppression integration:** does this reuse SP-A's `resolveCurrentSource`/`currentSource` to demote stale within the gathered set? (Likely yes — the two levers in one feature.)
6. **Measurement:** the oracle showed the ceiling; how to measure the *real* feature — a recall@k / coverage metric on a labeled set, and/or a cheap re-run of the oracle harness with the feature's retrieval substituted for daftari's.
7. **Journal vs native dependency:** does the lexical-coverage path make this useful on imported journals NOW, decoupling it from the cortex/atomization (SP-C) timeline? (Probably yes — a selling point.)

## Cheap experiment harnesses (reuse, ephemeral — re-create if gone)
- Corpus materialized: `/tmp/recall-review/packages/recall-bench/personas/executive-assistant/memories-180d/day-NNNN.md` (re-clone `Stevenic/recall` if gone).
- Per-question run data: `integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl` (gitignored; has `qa.relevantDays`, `retrieval[].path`, `score.hallucination` where **1=clean, 0=hallucinated**).
- Oracle/distractor harnesses: `/tmp/oracle-recall.mjs`, `/tmp/distractor-placebo.mjs`. Keys in `integrations/recall-bench/.env` (OpenRouter). Answerer `anthropic/claude-haiku-4.5`, judge `openai/gpt-5.4-mini` (note: max_tokens ≥ 16).

## Recommended first move next session
Resume the brainstorm at question 1 (surface) → 2-3 approaches for edge-aware coverage (e.g. (a) new `vault_gather` tool with edge-expansion + lexical fallback; (b) `coverage` param on `vault_search`; (c) edge-traversal-only with separate lexical-coverage tool) → design → spec → plan → subagent-TDD (the SP-A flow). Keep the two axes (recall + suppression) explicit; reuse SP-A's `currentSource` for the suppression half.
