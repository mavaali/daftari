# Spec — does the chunk-BM25 retrieval-recall win translate into better end-to-end answers?

**Date:** 2026-06-24
**Status:** Design approved, pre-implementation
**Context:** The opt-in chunk-level BM25 ranker (`lexicalGranularity:"chunk"`) is merged (PR #155), generalization-tested (SQuAD, PR #158), and title/tag-safe (tiered combine, PR #157). Two of the three default-flip gates are green — **win generalizes** and **title/tag-safe**. The third and last gate is **answer-quality**: recall@k is necessary but not sufficient — a better-ranked context only helps if the answerer actually uses it. This experiment is that gate.
**Related:** [[project_recall_bench_experiment]], [[project_coverage_retrieval]], `docs/superpowers/handoffs/2026-06-24-chunk-bm25-answer-quality-pickup.md`, `docs/superpowers/results/2026-06-24-chunk-bm25-squad-generalization.md` (the generalization win), `reference_consolidate_budget_cost` (the $400 cost lesson).

## Problem

The chunk-BM25 win is measured purely as **retrieval recall** (does the relevant document rank in the top-K window). Recall is necessary but not sufficient for the product claim. Flipping the production default to chunk mode is only justified if the recall win **does not degrade, and ideally improves, end-to-end answer accuracy**. The open risk is a regression: chunk-granularity ranking could reorder results such that an answerer that was previously fed the right context now isn't — or, more subtly, chunk mode could surface a focused chunk's document while dropping a document whose *surrounding* context the answerer needed. Until we feed both arms' retrieval to a held-constant answerer and grade the answers, the gate is open.

## Goal

Within a single held-constant answerer, measure the **answer-quality delta between the two retrieval arms** (`lexicalGranularity:"document"` vs `"chunk"`) on Recall Bench questions. The answerer is identical across arms, so the delta is attributable to **retrieval granularity alone**. The gate is **non-regression**: chunk ≥ document within noise (decided 2026-06-24).

## Why this shape

- **Within-daftari ablation, answerer held constant.** Same model, same prompt, same context cap — only the retrieval ranking varies. This cancels the model confound; the per-question delta isolates retrieval granularity. This is the cleanest *direct* isolation of "given this retrieval, how good is the answer."
- **Both arms return documents.** Verified at `src/search/hybrid.ts:204` — chunk mode (`chunkFtsRanking`) collapses to each document's best chunk, so the output unit is a ranked **document** list, identical in kind to document mode. Only the *order* differs. The fed unit is therefore the same (full documents); the sole varying factor is **which documents land in the top-K window**.
- **Recall Bench corpus.** Reuses the existing labeled questions (`referenceAnswer`, `relevantDays`) and the `/tmp/cov-recall/vault` already built for the chunk-BM25 recall runs. RB is partially rehabilitated as a *recall* scoreboard (memory: [[project_recall_bench_experiment]]); this experiment is on the recall axis, so RB is a fair surface.

## Non-goals (YAGNI)

- **No `src/` changes.** Measurement over the existing opt-in ranker. New harness only (`integrations/recall-bench/answerquality-runner.mjs`), mirroring `chunkbm25-runner.mjs`'s import/open pattern.
- **No native agentic answerer (Option B/C).** The thin single-shot OpenRouter answerer (Option A) is sufficient for the ablation because the answerer is held constant across arms. Option B (adapt `src/eval` to an OpenAI-compatible shim so the native agentic loop runs on OpenRouter) is a **follow-up only** — run it to confirm fidelity if and only if Option A passes and production-fidelity confirmation is wanted. Option C (native on a billed Anthropic key) is skipped.
- **No vector/hybrid arm.** Lexical-only (`{bm25:1, vector:0}`) isolates the BM25 granularity effect, matching the recall-run methodology.
- **No atom upper-bound arm.** The recall runs already characterized the day→atom ceiling; this experiment is doc-vs-chunk answer quality, two arms.
- **No second corpus.** SQuAD answered "does the recall win generalize"; this gate is about answer translation on RB. A second-corpus answer-quality run is out of scope.
- **No pairwise A/B judge.** Absolute per-answer scoring (below) avoids pairwise position bias and keeps comparability with the SP1 composite. A pairwise tiebreak is explicitly out of scope unless the absolute deltas land inside noise and a sharper instrument is needed (defer to a follow-up).

## Design

### Which tree we measure on

This branch (`exp/chunk-bm25-squad-generalization`, cut from `main`) has the merged chunk-BM25 ranker (#155) **and** the title/tag tiered combine (#157, merged to main). Build/run against this branch's `dist/`; record the measured commit in the results note. The title/tag tier is inert on RB (RB titles are `daily log <date>` — see the #157 dead-end lesson), so the arms differ only on body-chunk vs body-whole-doc ranking, exactly as in the recall runs — byte-identical retrieval to `chunkbm25-runner.mjs`.

### Pipeline (per question, per arm)

1. **Retrieve** top-K documents under arm ∈ {`document`, `chunk`} via `hybridSearch(db, q, { limit: K, weights:{bm25:1,vector:0}, lexicalGranularity: arm })`. Assert `vectorUsed === false` and that it never flips across calls (lexical purity, mirroring the other runners).
2. **Assemble context** = the full markdown body of the top-K documents, in ranked order, each prefixed with its path. Log total context chars per (question, arm).
3. **Answer** single-shot: feed (context + question) to the held-constant answerer, get a concise answer.
4. **Judge** the answer **blind to arm** against `referenceAnswer` → composite score.

The only difference between arms is step 1's ranking → which documents are in the top-K → what step 2 assembles. Steps 3 and 4 are identical.

### Component 1 — context cap K (the headroom crux)

If K is large, both arms include the relevant document → zero delta → null experiment. K must be tight enough that ranking decides top-K membership.

- **Pre-step (data-driven K):** before the answer runs, compute the **rank of each relevant document under each arm** across the sample (reuse the chunkbm25 retrieval path). Pick the K where the arms diverge most — i.e. where chunk frequently has the relevant doc in-window and document does not. Expected **K=5 primary** (the recall runs showed gapRecovered 0.527 @K=10; divergence is larger at smaller K), with **K=10 as a robustness check**.
- **Internal-validity prediction:** the answer delta should **shrink as K grows** (K=10 ≤ K=5), tracking the recall divergence. If the delta does *not* track K, that is itself a finding — it means the answerer is not sensitive to retrieval rank within the fed window, which weakens the case that the recall win matters at the answer layer. Record this either way.
- Both K=5 and K=10 are run (decided — keep the robustness arm).

### Component 2 — sampling (stratified)

- **N = 400**, split **200 single-day + 200 multi-day** (decided 2026-06-24).
- **Single-day stratum** = the regression-risk guard: document mode is at recall-parity here, so expect ~0 delta. A negative delta here would be the strongest evidence *against* the flip.
- **Multi-day stratum** = where chunk should help: sample spread across the 2/3/4/5/6/7-relevant-day buckets (cap per-bucket so the 698 seven-day synthesis questions do not dominate; document the bucket allocation).
- **Deterministic sample** — fixed seed / fixed stride, no `Math.random` (reproducibility; mirrors the SQuAD adapter convention).
- Report all deltas **split by stratum**.

### Component 3 — answerer

- Model `anthropic/claude-haiku-4.5` via OpenRouter (confirm the exact catalog slug at run time), OpenAI-compatible Chat Completions API (`OPENAI_BASE_URL=https://openrouter.ai/api/v1`, `OPENAI_API_KEY=$OPENROUTER_API_KEY`).
- Single-shot, no tools. Same system + user prompt template across both arms. Prompt instructs: answer the question **using only the provided context**, concisely, and cite the source path(s); say so if the context does not contain the answer (so a missing-context case scores as low-correctness, not a fabrication that happens to be right).
- Caveat carried into the writeup: Haiku's sensitivity to retrieval quality may differ from Opus in **magnitude** — treat the number as **directional**, not a production-fidelity point estimate.

### Component 4 — judge

- Model `openai/gpt-5.4-mini` via OpenRouter — **different family** from the Haiku answerer (no self-grading bias), and the **same judge** as the #155 RB baseline (parity).
- **Blind to arm:** the judge sees only (question, `referenceAnswer`, candidate answer) — never which arm produced it.
- **Absolute rubric mirroring SP1:** correctness (0–3), completeness (0–2), hallucination (penalty), → composite, with a one-line reasoning. This keeps the numbers comparable to the SP1 baseline composite. Structured JSON output (schema-validated, mirror `src/eval/score.ts`'s `completeJson` pattern).

### Component 5 — metrics & gate decision rule

- Per stratum (single-day, multi-day) and per K: **mean composite per arm** and the **per-question paired delta** (chunk − document) with a **bootstrap CI**.
- **Gate (non-regression):** PASS iff single-day delta ≥ 0 within CI (no regression on the parity surface) **and** multi-day delta ≥ 0 within CI (ideally strictly positive). A negative single-day delta outside noise = FAIL (the flip degrades the common case).
- Secondary readouts: hallucination-rate per arm (does chunk reduce or inflate fabrication); total context chars per arm (if chunk wins while feeding *less* text, that's an efficiency finding, not a confound); the K=5→K=10 delta trend (internal-validity check above).

### Outputs

- Harness: `integrations/recall-bench/answerquality-runner.mjs` (+ a small sampler if not folded in).
- Per-question JSON: `/tmp/cov-recall/answerquality-perq.json` (arm, K, question id, stratum, retrieved paths, context chars, answer, judge composite + axes).
- Summary JSON: `/tmp/cov-recall/answerquality-summary.json`.
- Results note: `docs/superpowers/results/2026-06-24-chunk-bm25-answer-quality.md` — with the gate verdict, per-stratum deltas + CIs, the K trend, cost/token spend, the Haiku-directional caveat, and a kill-condition for the default-flip decision.

## Cost controls (the $400 Opus lesson)

- Single-shot only — **no cumulative transcript** (the $400 was Opus + agentic full-doc re-sends; Option A avoids both).
- Cap fed context at top-K full documents; **log total chars + token usage** per call.
- Cheap models: Haiku answerer + gpt-5.4-mini judge. Estimated ~1600 calls at K=5, ~3200 across K=5+K=10 (400 questions × 2 arms × 2 Ks × {answer, judge}) → likely **< $10**. Confirm with a token log.
- **Smoke mode (N=25)** first — validate the full pipeline (retrieve → assemble → answer → judge → aggregate) end-to-end before the full run.

## Validity threats & guards

| Threat | Guard |
|---|---|
| **No headroom** (K too large → no delta) | Data-driven K pre-step; tight K=5 primary; report K trend. |
| **Answerer-strength confound** (Haiku ≠ Opus sensitivity) | Within-arm ablation is still valid (answerer constant); flag magnitude as directional in the writeup. |
| **Judge bias** (self-grading) | Judge family ≠ answerer family; judge blind to arm. |
| **Doc-length asymmetry** (arms feed different docs → different total text) | Not a confound — it's the production behavior; log per-arm context chars and report (chunk feeding less text but answering as well = efficiency win). |
| **7-relevant-day synthesis questions** (neither arm hits full recall at tight K) | The *delta* stays valid; cap their share of the multi-day stratum; report multi-day split. |
| **Lexical-purity drift** (vector half flips between calls) | Assert `vectorUsed === false` and invariant across all retrievals, mirroring the other runners. |

## Kill condition

If the single-day stratum shows a **negative chunk−document composite delta outside the bootstrap CI** at the primary K, the default-flip is **blocked** regardless of the recall win — the recall improvement does not survive contact with the answerer on the common case. (Chunk mode remains available opt-in.)
