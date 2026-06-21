# Handoff — SP1 baseline done, SP2-as-ranking killed; next is SP3 (atomization)

**Date:** 2026-06-21
**Prev session:** Ran the SP1 Recall Bench baseline; designed SP2 (supersession-aware ranking) and **killed it in spec review** when the corpus turned out to violate its premise. Banked both as written findings.

---

## TL;DR

- **SP1 baseline is run and written up.** daftari on Recall Bench EA-180d: **81.8% composite, 15.2% hallucination**, and the hallucination is *verified-real supersession* (daftari returns stale revised values; the answerer reports them confidently). `daftari@1.26.0` is live on npm.
- **SP2-as-ranking is dead for this corpus.** Recall Bench supersession is **intra-document** — document ranking can't fix it. The corpus says the real bottleneck is **atomization**, i.e. **SP3 / the cortex loop**, not `hybrid.ts`.
- **The next real experiment is SP3**, but unlike the killed SP2 test, **SP3 costs inference** (atom extraction is LLM work). And the SP1 run taught an expensive cost lesson, so **cost controls are a prerequisite** before any further answer-quality run.

## What's written (all on `main`, this session)

| File | What |
|---|---|
| `docs/superpowers/results/2026-06-21-recall-bench-baseline.md` | SP1 baseline: numbers, degradation curve, per-category, supersession evidence, cross-system caveat, kill condition |
| `docs/superpowers/results/2026-06-21-sp2-ranking-premise-killed.md` | Why SP2-as-ranking is the wrong lever for journal corpora; the atomization reframe; scope caveat |
| `docs/superpowers/specs/2026-06-21-sp2-supersession-ranking-retrieval-test-design.md` | The SP2 design, **marked KILLED** at the top, retained as record |
| `integrations/recall-bench/profiles/ea-180d-daftari.yaml` | The run profile (Anthropic answerer + OpenRouter judge). **Absolute paths are machine-specific — adjust before reuse.** |
| `integrations/recall-bench/results/` (gitignored) | Preserved 27-checkpoint run artifacts (`progress.jsonl`, `questions.jsonl`) |

Memory updated: `project_recall_bench_experiment` (SP1 done + SP2 killed + cost lesson) and `MEMORY.md`.

## Why SP2-as-ranking died (don't re-attempt it on Recall Bench)

The thesis required the current and stale values of a revised fact to live in **separate documents** so ranking could move one above the other. Verified false on EA-180d:
- `memories-180d/day-0100.md` carries *both* "Current base case **$465M**" and "Superseded banker memo **$510M**" in one doc.
- QAs `q001` (asks for the value *before* correction → 7:00 AM) and `q002` (value *after* → 6:30 AM) **share `relevant_days: [1]`** — same document.
- Only **n=2** tagged `type: correction` arcs exist anyway.

Document ranking cannot separate two values inside one retrievable document; downweighting "the stale doc" also buries the current value and breaks historical-seeking QAs. → **The unit of supersession must match the unit of truth: atoms, not documents.**

## The next experiment: SP3 — atomization + atom-level supersession

**Hypothesis:** if the cortex consolidation loop extracts *atomic claims* from the running journal and attaches `superseded_by` edges *between atoms*, then retrieval/answering can surface the current atom and suppress the stale one — fixing the failure SP1 measured. This is the thing the corpus actually calls for.

**Before building SP3, settle:**
1. **Does daftari retrieve at atom/chunk granularity, or only whole documents?** SP2 died partly because retrieval is doc-level. If SP3 produces atoms, confirm whether they become separately-retrievable units (own files / own index rows) or stay embedded in the daily doc. This is the load-bearing design question — re-run a brainstorm on it.
2. **Cost controls (PREREQUISITE — the SP1 run cost ~$400, ~$25/7 min):**
   - Prompt-cache the answerer's cumulative transcript (the eval client sets no `cache_control`; rounds re-pay full price for prior `vault_read`s).
   - Cap `maxRounds` (6) and trim `vault_read` (full long dailies are the token sink).
   - Log actual token usage — the adapter gets `input_tokens`/`output_tokens` back and **discards** them; wire them through so runs self-report cost.
   - Use sonnet for comparison arms; opus only where the headline needs it.
   - SP3 atom extraction is itself LLM spend — budget it (`reference_consolidate_budget_cost` applies).
3. **Comparability:** any arm you compare must share the same answerer model as its control.

## Salvage option for the ranking thesis (optional, separate)

SP2-as-ranking isn't wrong *in general* — it's wrong for journal corpora. daftari's **native** model (one fact per markdown file + `vault_supersede` edges between files) IS a document-relationship, so a `hybrid.ts` supersession downweight is the right, testable lever there. If anyone wants to validate the ranking idea, build a **native/synthetic corpus** (separate-file facts with explicit supersede edges) — not Recall Bench. The `hybrid.ts` change was never written, so there's no dead code.

## State / environment

- Run is stopped; nothing spending. v1.26.0 published.
- Clones: `/tmp/recall-review` (Recall Bench harness, built). Ephemeral — re-clone if gone.
- Keys: `integrations/recall-bench/.env` (gitignored) holds `ANTHROPIC_API_KEY` + `OPENAI_API_KEY` (OpenRouter) + `OPENAI_BASE_URL`. Mihir's billed keys — treat as live spend.
- Open tracked follow-up from SP1 (still open): add a real `satisfies MemorySystemAdapter` typecheck in `integrations/recall-bench/src/adapter.ts` once the bench pkg is a dependency.

## Memory pointers

- `[[project_recall_bench_experiment]]` — programme status (now: SP1 done, SP2 killed).
- `[[reference_recall_bench]]`, `[[project_cortex_consolidation_loop]]` (SP3 lives here), `[[project_daftari_paper]]`, `[[reference_consolidate_budget_cost]]`.
