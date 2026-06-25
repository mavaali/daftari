# Spec — SQuAD answer-quality ablation (does chunk-BM25's low-K retrieval win translate to answers?)

**Date:** 2026-06-24
**Status:** Design approved, pre-implementation
**Parent methodology:** `docs/superpowers/specs/2026-06-24-chunk-bm25-answer-quality-design.md` (already reviewed + implemented). This is a **variant on a new corpus** — it reuses that methodology wholesale and only changes the corpus, the ground-truth source, the relevance unit, and K.
**Related:** [[project_recall_bench_experiment]], `docs/superpowers/results/2026-06-24-chunk-bm25-squad-generalization.md` (the SQuAD retrieval win), `integrations/recall-bench/answerquality-lib.mjs` (reused helpers).

## Why this pivoted from RB to SQuAD

The RB answer-quality run (the parent spec) **aborted at the $0 divergence pre-step**: on a representative 200-multi-day sample, chunk−document recall divergence is ~0 at the depth an answerer uses (K=5: +0.005, K=10: +0.0005) and only material at K=20+ (+0.084 / +0.175 @20/50). The earlier RB "win" (`gapRecovered` 0.527/0.996 @K10/20) **overstated** the effect — `gapRecovered = (chunk−document)/(atom−document)` magnified a small absolute lift because the atom ceiling sat near the document floor at low K. So RB at realistic K has no recall divergence to *translate* into an answer difference — measuring it would be a null. (Cost of that discovery: $0; the pre-step guard refused to spend.)

SQuAD is the opposite regime and the right surface: single-relevant-document human queries where chunk's advantage is **largest at low K** — hit@1 0.693→0.828 (**+13.5pp**), hit@10 0.903→0.961 (+5.8pp), mrr@10 0.767→0.878. This is where chunk-BM25 demonstrably helps retrieval, so it's where "does the recall win translate to better answers" is a real, answerable question.

## Goal

Within one held-constant single-shot answerer, measure the **answer-quality delta between the two retrieval arms** (`lexicalGranularity:"document"` vs `"chunk"`) on SQuAD human queries graded against SQuAD reference answers. The answerer is identical across arms → the delta is attributable to retrieval granularity. Gate: **non-regression** (chunk ≥ document within a paired CI); on SQuAD we additionally *expect* a positive delta, since chunk genuinely out-retrieves document here.

## What is reused unchanged (from the parent methodology)

- **Answerer:** `anthropic/claude-haiku-4.5` via OpenRouter, single-shot, `answererPrompt` (context-only). Held constant across arms.
- **Judge:** `openai/gpt-5.4-mini` via OpenRouter, blind to arm, `judgePrompt` + SP1 composite (`correctness 0–3 + completeness 0–2 + hallucination 0–1`, max 6). `chatJson` (json_object).
- **Fed context:** best-matching chunk per top-K document (`assembleContext`, `bestChunkByPath` via `buildMatchQuery` + `chunks_fts`), bounded; fallback to first 1500 chars when no chunk matches.
- **Stats:** paired bootstrap CI (`pairedBootstrapCI`) over per-question (chunk−document) composite deltas.
- **Cost discipline:** smoke (N=25) first; log token usage; bounded context.
- **Lexical purity:** `weights:{bm25:1,vector:0}`, assert `vectorUsed===false` and never flips.
- **Modules:** `openrouter.mjs`, and from `answerquality-lib.mjs`: `assembleContext, answererPrompt, judgePrompt, composite, pairedBootstrapCI, shuffleSeeded`.

## What changes for SQuAD

1. **Corpus:** `/tmp/squad/vault` (442 article-level documents, neutral titles) + `/tmp/squad/queries.jsonl` (1500 records: `{id, query, relevantPath}`). Both already built (gen-squad-vault.mjs / squad-runner.mjs).
2. **Reference answers (NEW):** `queries.jsonl` carries NO answer. Build an `id → answer` map from `/tmp/squad/train-v1.1.json` (raw SQuAD: `data[].paragraphs[].qas[] = {id, question, answers:[{text}]}`); use `answers[0].text`. Verified: 87,599 answers map; sample joins correct. A query whose id has no answer in the map is **dropped with a logged count** (don't grade against a null reference).
3. **Relevance unit:** single relevant document (`relevantPath`), not multi-day. `hit@K` = `relevantPath ∈ top-K paths`. **No stratification** — one stratum; deterministic sample = `shuffleSeeded(queries, SEED).slice(0, N)`. (Do NOT use `stratifiedSample`, which is multi-day-specific.)
4. **Divergence pre-step ($0 gate):** divergence = mean over sampled queries of (chunk hit@PRIMARY_K − document hit@PRIMARY_K). Expected strongly positive on SQuAD (hit@5 lies between hit@1 +13.5pp and hit@10 +5.8pp). Abort if ≤ 0.01 (guard; should pass easily).
5. **K:** **K=5 primary + K=10 robustness** (decided 2026-06-24). RAG-conventional, not tautological with hit@1, real divergence at both. Internal-validity check: answer delta should **shrink as K grows** (tracks the SQuAD divergence curve — which decreases with K, unlike RB).
6. **Aggregation:** single stratum; per-K mean composite per arm, paired delta + 95% CI, hallucination rate, mean context chars. Gate verdict: PASS iff chunk−document delta CI lower bound ≥ −0.1 (non-regression) at K=5; report whether it's strictly positive (the translation claim).
7. **N = 400** (deterministic sample of the 1500). ~3200 LLM calls across K=5+K=10, ~$3–6 (same profile; SQuAD chunks are similar size).

## Files

| File | Responsibility |
|---|---|
| `integrations/recall-bench/squad-answerquality-runner.mjs` | **Create.** The runner: answer-join, single-stratum sample, hit@K divergence pre-step, answer/judge loop (reusing `answerquality-lib` + `openrouter`), aggregation + non-regression gate. Mirrors `answerquality-runner.mjs` structure. |
| `docs/superpowers/results/2026-06-24-chunk-bm25-answer-quality.md` | **Create (S4).** ONE results note covering both the RB pre-step null/reframe (the motivation) and the SQuAD answer-quality verdict. |

No `src/` changes. No new `answerquality-lib.mjs` exports needed (all reused).

## Outputs

- `/tmp/squad/answerquality-perq.json`, `/tmp/squad/answerquality-summary.json`.
- Results note with: the RB→SQuAD pivot rationale (incl. the `gapRecovered` overstatement), SQuAD per-K document-vs-chunk composite + paired CI, the K-trend, hallucination rates, mean context chars, actual token spend × verified pricing, the Haiku-directional caveat, and the default-flip 3rd-gate verdict + recommended next step.

## Validity threats & guards

| Threat | Guard |
|---|---|
| No headroom (K too large) | $0 divergence pre-step; K=5 primary where SQuAD divergence is large. |
| Answerer-strength confound (Haiku ≠ Opus) | Within-arm ablation valid (answerer constant); flag magnitude as directional. |
| Judge bias | Judge family ≠ answerer family; blind to arm. |
| Missing reference answer | Drop query with logged count; never grade vs null. |
| Title leak (article title discriminative) | Vault already uses neutral titles (`Article <NNN>`) — chunk title/tag tier inert; comparison is body-chunk vs body-whole-doc, same as the retrieval generalization run. |
| Lexical-purity drift | assert `vectorUsed===false`, never flips. |
| Determinism | single fixed SEED (sample + bootstrap); temperature 0 (answerer + judge). |

## Kill condition

If the SQuAD chunk−document composite delta CI **straddles or falls below 0** at K=5 despite the +13.5pp retrieval divergence, that means the retrieval win does **not** translate to answers even in the favorable regime — a strong signal against the default-flip on answer-quality grounds (retrieval-recall ≠ answer accuracy). Report it plainly; do not spin a null as a pass.
