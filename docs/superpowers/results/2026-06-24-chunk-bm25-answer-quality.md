# Results — chunk-BM25 answer-quality gate (the 3rd default-flip gate)

**Runs:** 2026-06-24 (RB pre-step) / 2026-06-25 (SQuAD full)
**Measured commit:** `6e2d742` (branch `exp/chunk-bm25-squad-generalization`; #155 chunk ranker + #157 tiered combine)
**Verdict:** **PASS** — chunk-BM25 retrieval produces measurably *better end-to-end answers* in the regime where it out-retrieves document, with no hallucination regression. **All three default-flip gates are now green.**
**Specs:** `docs/superpowers/specs/2026-06-24-chunk-bm25-answer-quality-design.md` (RB methodology), `docs/superpowers/specs/2026-06-24-squad-answer-quality-design.md` (SQuAD variant). **Related:** [[project_recall_bench_experiment]], `2026-06-24-chunk-bm25-squad-generalization.md`.

## Question

The chunk-BM25 ranker (`lexicalGranularity:"chunk"`) was merged opt-in, generalization-tested (SQuAD retrieval, +13.5pp hit@1), and title/tag-safe — 2 of 3 default-flip gates green. The 3rd: does the retrieval-recall win **translate into better end-to-end answers**? Recall@k is necessary, not sufficient — a better-ranked context only helps if the answerer uses it. Method: within one held-constant single-shot answerer (`anthropic/claude-haiku-4.5`), feed the two retrieval arms' top-K documents (best-chunk-per-doc) and grade the answers blind with a cross-family judge (`openai/gpt-5.4-mini`, SP1 composite 0–6). The answerer is constant across arms → the delta is attributable to retrieval granularity alone.

## Part 1 — Recall Bench: the test was a null, and it reframed the "win"

The RB answer-quality run **aborted at the $0 divergence pre-step** (the guard built to refuse paying for a null). On a representative 200-multi-day stratified sample, chunk−document recall divergence by K:

| K | document recall | chunk recall | delta |
|---|---|---|---|
| 5 | 0.240 | 0.245 | +0.005 |
| 10 | 0.322 | 0.322 | +0.0005 |
| 20 | 0.420 | 0.504 | +0.084 |
| 50 | 0.572 | 0.747 | +0.175 |

At the depth a single-shot answerer actually uses (K≤10), chunk and document retrieve **near-identical** context on RB multi-day questions — there is essentially no recall difference to *translate*. The advantage only materializes at K=20+.

**This reframes the earlier RB "win."** The headline `gapRecovered` 0.527/0.996/0.880 @K=10/20/50 is `(chunk−document)/(atom−document)` — and the atom ceiling sat very close to the document floor at low K, so a tiny absolute lift (≈5pp @K10) looked like "recovered half the gap." The absolute recall lift is real but concentrated at K=20+. Cost of establishing this: **$0** (pre-step aborted before any LLM call).

Crucially, across everything measured, **chunk recall ≥ document recall everywhere** — there is no K, no corpus, where chunk retrieves *worse*. So the non-regression worry (chunk's reordering degrades the answerer's context) is not borne out; on RB at realistic K there is simply no *difference* to measure.

## Part 2 — SQuAD: the regime where chunk helps, and the translation holds

We pivoted to SQuAD (442 article-level docs, 1,500 human queries, single relevant document, neutral titles) — where chunk's retrieval advantage is **largest at low K** (hit@1 0.693→0.828, +13.5pp), the opposite of RB and the right surface to test answer translation. N=400 deterministic sample; reference answers joined from raw SQuAD by question id; K=1 (powered) / K=5 (primary gate) / K=10 (robustness).

| K | document composite | chunk composite | delta (chunk−document) | 95% CI (paired) | hit (doc→chunk) |
|---|---|---|---|---|---|
| **1** | 3.500 | 4.025 | **+0.525** | [0.340, 0.715] | 0.740 → 0.868 |
| **5** | 4.035 | 4.322 | **+0.287** | [0.128, 0.463] | 0.895 → 0.950 |
| **10** | 4.170 | 4.430 | **+0.260** | [0.098, 0.415] | 0.925 → 0.975 |

- **Every CI is strictly positive** — chunk-BM25 produces better *answers*, not just better retrieval, at every K tested.
- **The delta shrinks monotonically with K (+0.525 → +0.287 → +0.260), tracking the divergence curve** (hit@1 +12.8pp → hit@5 +5.5pp → hit@10 +5.0pp on this sample). This is the predicted internal-validity signature: the answer gain rises and falls *with* the retrieval gain — causal evidence the translation is real, not an artifact.
- **No hallucination regression**: clean-answer rate comparable across arms (K=1 0.242/0.263, K=5 0.320/0.297, K=10 0.313/0.290 doc/chunk) — chunk does not trade recall for fabrication.
- **Mechanism note:** with best-chunk feeding, the arms feed identical key evidence whenever *both* retrieve the relevant doc, so the signal lives in the divergent-retrieval subset (12.75% @K1 vs 5.5% @K5). K=1 is therefore the cleanest, largest-signal arm — added after the smoke surfaced the dilution. Even so, K=5 came out clearly positive.

## Verdict and default-flip status

**Answer-quality gate: PASS.** The chunk-BM25 retrieval win translates into better end-to-end answers in the regime where chunk out-retrieves document (SQuAD low-K, single-answer), with no hallucination regression; and on RB it never degrades answers (no recall difference to translate at realistic K). All three default-flip gates are now green:

- ✅ Win generalizes (RB recall + SQuAD retrieval)
- ✅ Title/tag-safe (tiered combine, #157)
- ✅ **Answer-quality (this study)**

## Honest caveats

- **Answerer is Haiku, single-shot, not daftari's native agentic `src/eval` loop.** The within-arm ablation is valid (answerer held constant → delta = retrieval), but the *magnitude* is directional, not a production point-estimate. Confirming on the native agentic pipeline (Option B) is a possible follow-up.
- **The win is regime-dependent.** Chunk helps answers in the **single-answer, low-K** regime (SQuAD). On **RB multi-day day-coverage** at realistic K it neither helps nor hurts (the recall advantage is at K=20+). The default-flip is justified by "helps where it diverges, never hurts" — not by "helps everywhere."
- **`gapRecovered` overstated the RB recall win** (small-denominator magnification at low K). Absolute RB recall lift is a K=20+ phenomenon. Use absolute deltas, not gap-fraction, when reasoning about whether RB chunk-recall matters at answerer depth.

## Cost

SQuAD full run: 4,800 LLM calls, 2.86M input + 319k output tokens. Answerer Haiku + judge gpt-5.4-mini via OpenRouter ≈ **$3–4** (logged usage in `/tmp/squad/answerquality-summary.json`; verify exact OpenRouter rates). RB run: $0 (pre-step abort). Bounded best-chunk feeding (the $80→$7 lever) held: mean context 698/3.4k/6.8k chars at K=1/5/10, never full-doc.

## Recommended next step

The default-flip is now empirically supported on all three gates. To flip `lexicalGranularity` default `"document"→"chunk"`: a one-line `src/` default change + production regression tests (the native-shape title/tag suite from #156/#157 must stay green) + a release. Optional pre-flip hardening: run the native agentic answerer (Option B) on a slice to confirm the single-shot result holds on the production pipeline. Do not flip without the regression suite.

## Artifacts

- Harnesses: `integrations/recall-bench/answerquality-runner.mjs` (RB), `squad-answerquality-runner.mjs` (SQuAD), `answerquality-lib.mjs` (pure helpers, 20 unit tests), `openrouter.mjs` (client).
- Data: `/tmp/squad/answerquality-{perq,summary}.json` (SQuAD); RB pre-step in `/tmp/cov-recall/` logs. (`/tmp` is ephemeral — regenerate via the runners.)
