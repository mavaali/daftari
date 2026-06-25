# Results — Q1: chunk-BM25 win generalizes to SQuAD (independent human-query corpus)

**Date:** 2026-06-24
**Measured commit:** `d694189` (branch `exp/chunk-bm25-squad-generalization`, on `main`'s body-only chunk-BM25 — no #157 title/tag union; neutral titles make it inert anyway)
**Spec:** `docs/superpowers/specs/2026-06-24-chunk-bm25-squad-generalization-design.md`
**Harness:** `integrations/recall-bench/{gen-squad-vault,squad-runner}.mjs`
**Verdict:** **The chunk-BM25 win REPLICATES on SQuAD — chunk-granularity beats document-granularity on every metric (hit@1 +13.5pp, MRR@10 +11.1pp), with dilution headroom present. The win is NOT a Recall Bench artifact; it holds on an independent corpus with human-authored queries.**

## What was tested

The chunk-BM25 mechanism (whole-document BM25 dilutes a relevant topic across a long multi-topic document; per-chunk BM25 recovers it) had only been measured on Recall Bench — an LLM-generated corpus *and* LLM-generated QA. Q1 asks whether the win is an artifact of that generation or holds on an independent corpus with **human** queries.

**Corpus:** SQuAD v1.1 train, reconstructed to **article-level documents** — each of 442 articles (~55 chunks/doc; mean 55.4) becomes one long multi-topic document with a **neutral** frontmatter title (`Article NNNN`), so neither retrieval arm gets a title shortcut; the real entity tokens the human questions match live in the body, fair to both arms. 1,500 questions (deterministic stride sample of 87,599), each labeled with its single source article. Two arms, lexical-only (`{bm25:1, vector:0}`, `vectorUsed:false`), document- vs chunk-granularity. `$0`, no LLM.

**Validity guards (all passed):** mean chunks/doc = 55.4 (≫ 1 → genuine multi-topic dilution); `invalidFrontmatter == 0`, `skipped == 0`; `vectorUsed == false`; document-arm hit@1 = 0.693 (**headroom present** — not ceiling'd, so the comparison can actually show a chunk advantage).

## Results (n=1,500, lexical-only)

| metric | document | chunk | Δ (chunk − doc) |
|---|---|---|---|
| **hit@1** | 0.6933 | **0.8280** | **+13.5pp** |
| **MRR@10** | 0.7666 | **0.8775** | +11.1pp |
| hit@10 | 0.9027 | 0.9607 | +5.8pp |
| hit@20 | 0.9347 | 0.9713 | +3.7pp |
| hit@50 | 0.9640 | 0.9867 | +2.3pp |

Chunk-granularity wins at **every** cutoff. The gain is largest where it matters most — **hit@1 +13.5pp** and **MRR@10 +11.1pp** — i.e. chunk-BM25 doesn't just retrieve the right article *eventually*, it ranks it *first* far more often. The gap narrows as k grows (both arms approach ceiling by k=50), exactly as expected: dilution costs you precision at the top, which deep retrieval eventually recovers.

## Verdict

**Replicates.** The direction and the magnitude both transfer from RB to SQuAD. RB showed +6–18pp recall@top-K (gap-recovery framing); SQuAD shows +2.3 to +13.5pp hit@k and +11.1pp MRR@10 on human queries. The win is a property of the **mechanism** (multi-topic documents dilute whole-doc BM25; per-chunk scoring recovers the relevant passage), not of RB's synthetic construction. This **strengthens the case** for the default-flip — but does not by itself decide it (see below).

## Honest Assessment

- **What this shows:** the doc-vs-chunk dilution advantage is real on an independent corpus with human-authored queries and a different document structure (encyclopedia articles vs daily journals). The strongest external-validity threat — "RB's QA generator writes chunk-friendly questions" — is killed: SQuAD questions predate and are blind to daftari's chunker.
- **What it does NOT show:**
  1. **Article-level qrels** (query → source article), not paragraph pinpointing — this measures *document* retrieval, which is the right granularity for testing *document* dilution, but it's not passage-level accuracy.
  2. **One corpus.** "Replicates on SQuAD" ≠ universal. Two independent corpora (RB + SQuAD) now agree on direction; that's strong, not infinite.
  3. **Recall@k, not answer quality.** Better top-k retrieval is necessary, not sufficient, for better answers — the answer-quality LLM-arm (Haiku) is the *other* gate and is still pending.
  4. **Neutral-title reconstruction** deliberately strips the article title from the matchable title field to isolate *body* dilution. A real vault with meaningful titles would also get chunk mode's #157 title/tag contribution on top — so this is a clean lower bound on the body effect, not the full picture of a titled vault.
  5. SQuAD questions are entity-rich; the headroom (document hit@1 0.69) is real but smaller than a corpus of vaguer queries would show — magnitude is corpus-dependent even though direction is robust.

## What this means for the default-flip

The chunk-mode programme now has: the win (RB), a generalization confirmation (SQuAD, this doc), a regression-safety bound (native-shape, #156), and a title/tag fix (#157). **Two of the three default-flip gates are now favorable** (the win generalizes; title/tag safe). The remaining gate is **answer-quality** (does the recall win translate into better end-to-end answers — the Haiku LLM-arm). Default-flip stays gated on that.

## What ships

- Adapter + runner committed; reproducible (`node gen-squad-vault.mjs && node squad-runner.mjs`; SQuAD cached at `/tmp/squad/train-v1.1.json`). No `src/` change — measurement only.
- Note: the runner is slow at this corpus size (~10+ min) because `rankDocuments` reloads all 442 article bodies per query for snippet generation — a harness inefficiency, not a ranker one. Fine for a one-shot; would want batching if rerun often.
