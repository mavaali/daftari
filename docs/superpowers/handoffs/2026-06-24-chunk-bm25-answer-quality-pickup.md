# Handoff — chunk-BM25 programme: the answer-quality gate (last default-flip blocker)

**Date:** 2026-06-24
**One-line:** The opt-in chunk-level BM25 ranker is built, generalization-tested, and title/tag-safe. **2 of 3 default-flip gates are green.** The remaining gate — does the retrieval-recall win translate into better *end-to-end answers* — is the next experiment: a within-daftari answer-quality ablation on **Haiku**. Start fresh here.

## Where the programme stands (chunk-mode = `lexicalGranularity:"chunk"`, opt-in, default still `"document"`)

| PR | What | Status |
|---|---|---|
| [#155](https://github.com/mavaali/daftari/pull/155) | chunk-level BM25 ranker (`chunks_fts` + `chunkFtsRanking`, collapse best-chunk-per-doc) | **MERGED** |
| [#156](https://github.com/mavaali/daftari/pull/156) | native-shape regression check — quantified title/tag blindness (0.0 hit@1) | **MERGED** |
| [#157](https://github.com/mavaali/daftari/pull/157) | title/tag fix — **tiered** combine (body band (0.5,1] > title-only band (0,0.5]) | **MERGED** |
| [#158](https://github.com/mavaali/daftari/pull/158) | Q1 generalization — win replicates on SQuAD (hit@1 +13.5pp) | **OPEN** (clean, rebased on main) |

**The win (recall):** chunk-BM25 recovers most of the multi-day retrieval-recall gap on Recall Bench (gapRecovered 0.527/0.996/0.880 @K=10/20/50) AND replicates on SQuAD human queries (hit@1 0.693→0.828, +13.5pp; MRR@10 +11.1pp). It's the **mechanism** (multi-topic docs dilute whole-doc BM25; per-chunk recovers), not an RB artifact.

**Title/tag safety:** chunk mode was body-only (blind to title/tag-only queries → native hit@1 0.0). #157 added a column-restricted `{title tags}` BM25 (`ftsRanking` + `columnRestrict`, no schema change) tiered below the body signal. Native title/tag 0.0→1.0; RB win byte-identical (title/tag tier is inert on RB). Dead-end recorded: a de-weighted-max (0.99) combine FAILED the RB gate (RB titles are `daily log <date>` → common-token inflation) — that's why the combine is structural tiering, not a weight.

### Default-flip gate status
- ✅ **Win generalizes** (RB + SQuAD) — #158
- ✅ **Title/tag-safe** (tiered combine) — #157
- ⏳ **Answer-quality** — UNTESTED. ← the only remaining blocker. **This is the next job.**

## The next experiment: answer-quality ablation (the last gate)

**Question:** does the chunk-mode *retrieval-recall* win translate into better *end-to-end answer accuracy*? Recall@k is necessary, not sufficient — a better-ranked context only helps if the answerer uses it.

**Shape (from prior session reasoning — brainstorm/spec it properly):**
- **Within-daftari ablation:** same answerer model held constant, two retrieval arms — `lexicalGranularity:"document"` vs `"chunk"` — feed the retrieved context to the answerer, grade the answers. The held-constant answerer **cancels the model confound**; the delta is attributable to retrieval granularity.
- **RUN IT ON OPENROUTER — no Anthropic key needed (DECISION 2026-06-24).** `OPENROUTER_API_KEY` is in `~/.zshenv`. daftari's *native* answerer (`src/eval/llm.ts`) is **Anthropic-only** (built on `@anthropic-ai/sdk`, Messages + Anthropic tool format), so it can't point at OpenRouter directly. Three ways to run on OpenRouter instead:
  - **Option A (recommended, fastest, $0-Anthropic):** a **thin single-shot answerer** — NOT `src/eval`. For each query: retrieve context under arm X (daftari `$0` lexical), feed (context + question) → answer via OpenRouter's OpenAI-compatible API. Answerer + judge both on OpenRouter. **Model = Haiku via OpenRouter** (`anthropic/claude-haiku-4.5` — confirm exact slug in OpenRouter's catalog at run time); single-shot needs no tools so OpenAI-compat format is fine. *Tradeoff:* measures a **generic single-shot** answerer, not daftari's native **agentic** `src/eval` loop — but valid for the ablation (answerer held constant across arms → delta = retrieval). This is the cleaner *direct* isolation of "given this retrieval, how good is the answer."
  - **Option B (production fidelity, more work):** adapt `src/eval` to an OpenAI-compatible `LlmClient` + tool-call shim, so the **native agentic** answerer runs on OpenRouter models. Real `src/` change (own brainstorm/spec); useful beyond this experiment.
  - **Option C:** native Haiku on a billed Anthropic key (~tens of $) — only if you specifically want the native pipeline without building B.
- **Yes, still Haiku.** Haiku is available *through* OpenRouter, so "OpenRouter" and "Haiku" aren't exclusive — Option A uses Haiku-via-OpenRouter. Caveat: Haiku's *sensitivity* to retrieval quality may differ from Opus in magnitude — treat the number as directional. **Judge = `gpt-5.4-mini` via OpenRouter (DECIDED 2026-06-24).** Different family from the Haiku answerer → no self-grading bias, and it's the same judge model as the #155 RB baseline (parity). Set via the OpenAI-compatible client (`OPENAI_BASE_URL=https://openrouter.ai/api/v1`, `OPENAI_API_KEY=$OPENROUTER_API_KEY`, model `openai/gpt-5.4-mini`).
- **Cost levers (the $400 Opus lesson, `reference_consolidate_budget_cost` / SP1 postmortem):** with Option A's single-shot there's no cumulative-transcript blow-up, but still cap context size and log tokens. (The $400 was Opus + agentic full-doc re-sends — Option A avoids both.)
- **Corpus:** Recall Bench. Option A builds a thin runner (mirror `chunkbm25-runner.mjs` for retrieval) rather than the SP1 `src/eval` adapter. Reuse the RB questions + judge.

**Open design questions for its brainstorm:** which RB question subset (multi-day, where the recall win is largest?); single-shot context cap (top-k docs/chunks to feed); how many questions for a stable signal at acceptable OpenRouter cost; whether to later run Option B/C to confirm the result holds on the native agentic pipeline.

## Key files / harnesses (all on main unless noted)

- Ranker: `src/search/hybrid.ts` — `chunkFtsRanking`, `tieredLexical`+`TIER_SPLIT`, `columnRestrict`, the `lexicalGranularity` branch in `rankDocuments`. Default `"document"`; `relatedSearch` pinned `"document"`.
- Schema: `src/storage/index-db.ts` — `chunks_fts` (FTS5 over chunk text, body-only) + triggers, `SCHEMA_VERSION` 7.
- Recall harnesses (`$0`, lexical): `integrations/recall-bench/chunkbm25-runner.mjs` (RB 3-arm), `native-regression-runner.mjs` (#156), `gen-squad-vault.mjs`+`squad-runner.mjs` (#158).
- Answer-quality harness (paid): `src/eval/` answerer, `integrations/recall-bench/recall-runner.mjs`, profile `integrations/recall-bench/profiles/ea-180d-daftari.yaml`. Judge on OpenRouter.
- Results: `docs/superpowers/results/2026-06-24-chunk-bm25-{measurement,native-regression,title-tag,squad-generalization}.md`; Stage A `2026-06-23-atomization-granularity-measurement.md`.

## Other open threads (parked)
- **Default-flip itself:** once answer-quality passes, the change is a one-line default + production regression tests + a release. Don't flip before the gate.
- **Q1 is one corpus** (SQuAD) + RB. If more external validity is wanted later, a second independent corpus (LoCoMo / a BEIR set) — but two corpora already agree on direction.
- Ephemeral `/tmp` vaults (`/tmp/squad`, `/tmp/cov-recall`, `/tmp/native-regression`) regenerate from their `gen-*`/`prep-*` scripts; SQuAD JSON cached at `/tmp/squad/train-v1.1.json`.

## Memory
Full arc in `project_recall_bench_experiment` banners (5/5b/5c/5d) + `MEMORY.md`. Cost lesson: `reference_consolidate_budget_cost`. Haiku-as-answerer precedent + judge-on-OpenRouter: in the same memory file.
