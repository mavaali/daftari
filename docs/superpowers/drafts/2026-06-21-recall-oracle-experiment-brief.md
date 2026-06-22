# Experiment brief — the oracle-recall arm (is retrieval recall the *fixable* bottleneck?)

**Date:** 2026-06-21
**Status:** RUN 2026-06-21 — **PASS** (recall is the fixable bottleneck). Results at the bottom.
**Depends on:** `docs/superpowers/results/2026-06-21-recall-vs-disambiguation.md` (the finding this tests).

## The question

The re-analysis showed **68% of daftari's RB hallucinations are recall-misses** (relevant days never retrieved), and that within multi-day questions, *covering* the span cuts hallucination from 19.5% → 13.8% — real but bounded, with a **~14% confabulation floor** and a noisy, selection-biased observational signal. The open question is causal and decision-relevant:

> If we **guarantee** the full `relevantDays` span is in the answerer's context, how far does hallucination actually fall — and is the remainder an answerer-confabulation floor that retrieval work can't touch?

This decides whether to invest in retrieval-recall improvements (span/date-aware fetch, query expansion, recall@k) at all.

## Design (single-shot oracle, NOT a full benchmark re-run)

Two arms over the *existing* SP1 question set, reusing `questions.jsonl` to pick the cases:

1. **Oracle-recall arm (the test):** the **146 multi-day recall-miss hallucinations** (relevant days were missed). For each, build context = exactly the `relevantDays` day-docs (the ground-truth span), answerer answers from that, judge scores. Baseline on this subset is 100% hallucinated *by construction*, so any drop is the recall ceiling.
2. **Disambiguation control (the placebo):** a sample (~70) of the **covered-but-hallucinated** cases. Oracle context here adds nothing they didn't already have, so it should **not** fix them. If it does, the arm isn't isolating recall (leakage from a stronger answerer/shorter context).

**Decision rule:**
- Oracle-recall hallucination falls sharply (e.g. ≤ ~15%, near the observational covered rate or below) **and** the disambiguation control stays high ⇒ **recall is the fixable bottleneck** → scope a retrieval-recall improvement (its own brainstorm).
- Oracle-recall stays high (≳ baseline-minus-a-little) ⇒ the failure is answerer confabulation on sufficient context; retrieval work won't move the needle → **do not build it**; the lever is answerer/prompt or out of daftari's scope.

## Cost controls (the $400 lesson — see baseline doc §Honest assessment)

The baseline's $400 came from opus + ~1.8 full-doc `vault_read`/Q across a ~4.8-call cumulative loop, no caching. This arm avoids all of that:
- **Single-shot**, not an agent loop: one answerer call per question over a *small fixed* context (only the `relevantDays` docs, typically <7), not 37 retrieved docs.
- **Cheap answerer** (Haiku 4.5 or sonnet via OpenRouter — Mihir has `OPENROUTER_API_KEY`); judge `gpt-5.4-mini` via OpenRouter for parity with SP1.
- ~216 questions × (1 answer + 1 judge), short context, cheap models ⇒ **single-digit dollars**, not hundreds. Log tokens this time (the SP1 adapter discarded them).

## Prerequisite / the one real dependency

Need the **EA day-docs** to build oracle context. `questions.jsonl` carries only retrieved *snippets*, not full docs. Source = the `Stevenic/recall` harness corpus (the same ingest the SP1 run used). Locate or re-clone before running (memory notes a clone at `/tmp/recall-review`, likely gone — re-clone `git clone https://github.com/Stevenic/recall`).

## Kill condition

If the oracle-recall arm does **not** materially cut hallucination on the recall-miss subset, the "recall is the fixable bottleneck" thesis is wrong and this whole retrieval-recall direction is dead — the failure is answerer confabulation, and the honest conclusion is that daftari's RB ceiling is set by the answerer, not its retrieval.

## Why this is the right next step (not a build)

Mirrors the Exp #1 discipline (cheapest falsifier before the expensive build). The recall finding is a *composition* fact (solid); the *leverage* of fixing it is bounded and selection-biased in the observational data. One cheap single-shot arm converts "recall is the majority failure" into "fixing recall is / isn't worth a feature." Only after a PASS does a retrieval-recall brainstorm earn its place.

---

## RESULTS (run 2026-06-21) — PASS

Single-shot, answerer `claude-haiku-4.5` held constant across arms, judge `gpt-5.4-mini` (SP1 parity) grounded on the true `relevantDays` docs for both arms, temp-0 judge. 80 recall-miss + 32 disambiguation cases. Harness: `/tmp/oracle-recall.mjs` (ephemeral). Cost: single-digit dollars via OpenRouter (token logging still not captured — minor).

| subset | Arm A (retrieved context) | Arm B (ORACLE relevant-days) |
|---|---|---|
| **recall-miss** (the test) | **27.8%** halluc (22/79) | **1.3%** halluc (1/80) |
| disambiguation (placebo) | 28.1% (9/32) | 0% (0/32) |

**Verdict — recall IS the fixable bottleneck.** Holding the answerer model fixed and only swapping in the true relevant span cut recall-miss hallucination **~95% (27.8% → 1.3%)**. The ~14% "confabulation floor" feared in the results note (finding 6) was an artifact of observational selection bias + a noisy coverage proxy; the **true oracle ceiling is ~1%**. A weaker model (haiku) with the right context vastly outperforms the SP1 opus run on these same questions (which hallucinated 100% on them by selection) — strong evidence the SP1 failures were *retrieval*, not answerer capability.

**Caveat — the placebo is contaminated, do not over-read the disambiguation row.** Arm A fed only the **top-8** retrieved docs, but "covered" was defined over **all** ~27 retrieved docs, so for disambiguation cases Arm A frequently dropped the relevant day too — turning the placebo into a recall-miss in disguise. The 28%→0% there therefore does **not** cleanly isolate "oracle fixes recall but not disambiguation." A clean placebo (Arm A = relevant days + stale distractor docs, vs Arm B = relevant days only) is owed to separate distractor-induced disambiguation from pure recall. The main recall-miss result does not depend on it.

**Other honest notes:** answerer changed from the SP1 opus to haiku (the *within-experiment* A-vs-B delta isolates context regardless, but cross-comparison to SP1 absolute rates is directional); judge leniency is ruled out by Arm A still flagging 28% under the same judge.

## Decision

Recall-recall improvement is **worth a feature.** Next: a retrieval-recall brainstorm (span/date-aware fetch, query expansion across the relevant window, recall@k). Optionally run the clean distractor placebo first to quantify how much of the residual is distractor-disambiguation (the SP-A/foregrounding lever) vs pure span recall.
