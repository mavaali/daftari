# Recall Bench — daftari's dominant failure is recall, not disambiguation

**Date:** 2026-06-21
**Source:** re-analysis of the SP1 baseline run (`integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl`, 1,489 evaluated questions, EA-180d).
**One line:** ⅔ of daftari's hallucinations are the relevant content never reaching the answerer (recall/coverage), not the answerer picking a stale value it did retrieve (disambiguation). This **materially corrects** the baseline doc's "losing on disambiguation, not recall" framing and reframes the SP2/SP3/SP-A supersession thread as addressing the *minority* failure.

## Trigger

Observation (Mihir): "daftari struggled on docs that traversed multiple days." Confirmed and decomposed against the raw run.

## Method

- Per-question record carries `qa.relevantDays` (ground-truth relevant day docs), `retrieval[].path` (docs daftari actually surfaced, the union across the agent loop), `score.hallucination` (**`1` = clean, `0` = hallucinated** — verified: `(462+801)/1489 = 84.8%` clean ⇒ 15.2% halluc, matches the headline), `systemAnswer`, `toolCalls`.
- **Coverage proxy:** a failure is a *recall miss* if any `relevantDay` is absent from the retrieved day-docs; *disambiguation* if every relevant day was retrieved yet the answer is still wrong.
- **Confound check (the restatement kill-condition):** the EA journal restates facts across days, so a "missed day" could be covered by a *retrieved* restating doc. Tested via reference-answer **distinctive-term overlap** (numbers/proper-nouns from `referenceAnswer` ∩ retrieved snippet text). Script: `/tmp/recall-confound.mjs` (ephemeral; logic reproduced here).

## Findings [DATA]

### 1. The failure rate doubles with span, and the *mode* flips

| | hallucination rate | dominant mode |
|---|---|---|
| Single-day questions | **9.4%** (48/510) | disambiguation — 85% (41/48) **had** the relevant day retrieved |
| Multi-day questions | **18.2%** (178/979) | recall miss — 82% (146/178) **missed** relevant days |

### 2. Across all 226 hallucinations

- **Recall / coverage miss (relevant content not retrieved): 153 = 68%**
- **Disambiguation (had every relevant day, still wrong): 73 = 32%**

### 3. Not a top-N artifact

Recall-miss cases retrieved a **mean of 37 docs across ~6 searches** yet surfaced only **2.7 of 6.25 relevant days**. The agent searched hard; BM25+vector ranking pulled in many on-topic-*looking* dailies but missed the scattered span. The relevant days rank *below* lexically-similar-but-wrong docs.

### 4. The restatement confound is negligible — the recall split is real

| group | mean ref-term overlap w/ retrieved snippets | % with <⅓ terms present |
|---|---|---|
| recall-miss | **0.18** | 83% |
| disambiguation | 0.24 | 78% |
| clean-correct (control) | 0.32 | 63% |

Monotonic, exactly as predicted: recall-miss cases have the **lowest** overlap — the needed facts genuinely weren't retrieved. Only **2/146 (1%)** recall-miss cases had ≥67% of reference terms present (i.e. possibly restatement-covered). **62%** of recall-miss answers assert absence ("not in the vault", "the principal is Jamie, not Jordan") — the recall gap drives a confident fabricated negative. (Absolute overlap is deflated by prose paraphrase + truncated snippets; the **relative ordering** is the signal.)

### 5. Many "supersession" failures are recall failures in disguise

Canonical example — *"working purchase-price range for Project Condor?"*, reference `$620M–$760M` (the **day-28 revision**). daftari answered `$420M–$475M` "from the Day 6 entry" — it **never retrieved day-28**, so there was no current-vs-stale choice to get wrong. This is a supersession question failing at the **recall** layer, not the ranking layer. Consequence: **SP2 (supersession-aware ranking) and SP-A (foreground via edge) cannot help these** — you cannot rank-up or foreground a document that was never retrieved.

### 6. Coverage helps — but is necessary, not sufficient (the leverage is bounded) [DATA]

Conditioning **within multi-day questions** (controls for span difficulty):

| multi-day subset | n | hallucination rate |
|---|---|---|
| span fully covered | 232 | **13.8%** |
| span not covered | 747 | **19.5%** |

Covering the span cuts hallucination ~30% relative (19.5→13.8) — real, but it leaves a **~14% residual floor**: even with every relevant day retrieved, the answerer still confabulates ~1 in 7. The coverage-*fraction* gradient is **non-monotonic** (0–25%: 16%, 25–50%: **31%**, 50–75%: 19%, 75–100%: 15%, 100%: 14%), so the proxy is noisy and the relationship isn't clean-linear. **Reading:** recall composition is the *majority* of the failure (finding 2), and improving recall is the larger lever than supersession — but it is **necessary-not-sufficient**; a second factor (answerer confabulation on imperfect/sufficient context) sets a floor that retrieval alone won't clear. The observational 13.8% is also selection-biased (daftari covers the *easier* spans), so it is only a rough proxy for the oracle ceiling — which is why the oracle arm (below) is decisive, not optional.

## Implications for the programme

- The **supersession thread** (SP2, SP3, SP-A) and the **"RB is the wrong scoreboard"** conclusion both addressed the **32% disambiguation slice**. The dominant **68% is plain retrieval recall** — assembling the full multi-day span — which none of SP-A/B/C touch.
- The recall weakness is **generalizable, not RB-specific**: any multi-fact query over a journal-style vault hits it. It is a real product weakness in `hybrid.ts` ranking, not a benchmark quirk.
- **Partial rehabilitation of RB as a scoreboard:** RB is the wrong test for *supersession* (recency-resolvable; ContextForge wins cheaply with free regex), but a *legitimate* test for *multi-day recall*, where daftari has a genuine, fixable, non-minting weakness. The "wrong scoreboard" verdict should be scoped to the supersession axis, not the recall axis.
- **The lever is retrieval recall**, not foregrounding: span/date-aware retrieval, query expansion across a relevant window, recall@k tuning, or letting the answerer enumerate-and-fetch a day range. Distinct from the projection programme; deserves its own brainstorm before any build.

## Honest assessment / caveats

- The coverage proxy assumes `relevantDays` is the minimal needed set. The term-overlap confound check (finding 4) was run precisely to test the inflation risk and **the kill-condition did not trigger** (1% possible false-miss; recall-miss has the lowest overlap of all groups). Treat 68% as **robust directionally and well-supported quantitatively**, not a hair-precise point estimate.
- Within-daftari measurement: "recall" here conflates ranking quality with the opus answerer's search strategy. But toolCalls≈6 and 37 docs retrieved show the agent tried; the ranking didn't deliver the span. [HYPOTHESIS — the fix is ranking/retrieval recall; an oracle "fetch all relevantDays" arm would confirm.]
- negative-recall is noisier (its correct answer is often itself "no evidence"); excluded from the sharpest claims.

## Kill condition (for the recall thesis)

If a retrieval arm that guarantees the full `relevantDays` span is in context does **not** materially cut hallucination in the multi-day categories, then the bottleneck is answerer confabulation, not recall, and this reframe is wrong. The 68%/32% split above is the control. **This is now a concrete, scoped experiment:** `docs/superpowers/drafts/2026-06-21-recall-oracle-experiment-brief.md` — a cheap single-shot oracle arm (force the relevant span into context, re-judge) that converts "recall is the majority failure-type" into "fixing recall is / isn't worth a feature." Finding 6's bounded leverage + selection bias is exactly why it's decisive, not optional. Run it before any retrieval-recall build.
