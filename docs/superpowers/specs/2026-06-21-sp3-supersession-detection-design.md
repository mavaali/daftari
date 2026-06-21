# SP3 — supersession-detection acquisition test (doc-level, Recall Bench EA)

> **⛔ KILLED 2026-06-21 in spec review — DO NOT IMPLEMENT.** Same intra-document wall as SP2: verified **zero pure-stale docs** in EA (every doc with "7:00" also has "6:30" 11/11; every doc with "510" also has "465" 81/81), so there is no (stale-doc → current-doc) gold edge to score doc-level detection against. The unit must be sub-document (atoms). Separately, ContextForge was found to beat daftari on RB via free deterministic methods and RB supersession is 100% recency-resolvable — so the RB-supersession experimental thread is concluded. Forward path is the current-state **projection** (foreground, don't mint). See handoff `docs/superpowers/handoffs/2026-06-21-projection-ethos-and-cf-verdict-pickup.md`. Retained as record.

**Date:** 2026-06-21
**Status:** KILLED (intra-document wall, caught in review).
**Scope:** Test whether daftari can **auto-detect** supersession relationships from a raw corpus — the novel half of the programme. Measures *acquisition* (precision/recall of detected `superseded_by` edges vs ground truth), **not** answer quality. **No answerer, no judge.** Haiku-first. Cheap (a few dollars).

## Why this, and why doc-level

SP1 ([baseline](../results/2026-06-21-recall-bench-baseline.md)) measured 15.2% hallucination from stale-fact retrieval. SP2-as-ranking was [killed](../results/2026-06-21-sp2-ranking-premise-killed.md): Recall Bench supersession is *intra-document*, so document **ranking** can't fix it. But SP3 measures **detection**, not ranking — and the supersession *relationship* is recoverable at doc level (a later daily explicitly records "retired the earlier $510M baseline"). The intra-doc problem that kills ranking does **not** kill detection. So SP3 runs doc-level on the real external corpus.

Key finding from exploring the loop: **daftari does not atomize.** The cortex loop (`src/consolidate/`) births docs and draws `derives_from` edges *between docs* via an LLM `DerivationVerdict` (`derivation-prompt.ts`); there is **no supersession detection and no atom concept**. SP3 mirrors the derivation machinery to add `superseded_by` detection. Atomization (atom-level supersession) is a larger net-new build, deferred.

## Non-goals

- No answer-quality / end-to-end benchmark (the expensive opus+judge run — deferred).
- No atomization (atom-level units — deferred; a separate, bigger project).
- No production wiring into the live `consolidate` loop yet — the detection *core* is production-shaped, but it's driven by a standalone eval harness. Wiring is a follow-on if detection proves out (same posture as SP2).
- No ranking change (`hybrid.ts` untouched).

## Win / kill condition

LLM detection (stripped of explicit markers; Haiku, escalated if needed) **materially beats the recency-overlap baseline on F1** of `superseded_by` detection ⇒ thesis holds: daftari can acquire supersession beyond a recency heuristic. If LLM ≤ recency, escalate Haiku→sonnet/opus to disambiguate model-weakness from approach-failure; if even opus ≤ recency, auto-detection adds nothing over a heuristic ⇒ reconsider SP3.

## Architecture

Detection core (production-shaped, in `src/consolidate/`) + eval harness (`integrations/recall-bench/`). Data flow:

```
arcs-180d.yaml (type:correction) ┐
qa-180d/questions.yaml           ├─► gold-builder ─► gold superseded_by edges (stale-doc → current-doc)
                                 ┘
memories-180d/ ─► ingest once (temp vault, MiniLM) ─► index ─► per doc: top-K neighbors (candidate pairs)
                                                                          │
   candidate pairs ─► recency-overlap baseline (no LLM) ─────────────────┤
                  └─► detectSupersession (Haiku): with-markers + stripped ┤
                                                                          ▼
                       score all three vs gold (P/R/F1) + coverage diagnostic ─► report
```

### Component 1 — `src/consolidate/supersession-prompt.ts` (new)

Mirrors `derivation-prompt.ts`. Exports:
- `SupersessionVerdict { supersedes: boolean; authoritative: "A" | "B" | null; reason: string }`
- `SUPERSESSION_VERDICT_SCHEMA`, `SUPERSESSION_SYSTEM`, `supersessionUserBody(docA, docB)`, `parseSupersessionVerdict(raw)` (reject-and-continue parser, mirrors `parseDerivationVerdict`).
- Prompt content: *"Do these two documents assert different values for the **same entity and attribute**, such that one is a corrected/updated version of the other? If so, which is authoritative (the current/correct one)? If they are about different things, merely co-occur, or are consistent, set supersedes=false."*
- **Guard A — no dates in the prompt.** Document dates / day-numbers are withheld so the LLM must reason from content/authority, not recency. (Recency is the baseline's job; constraint #2.)
- **Guard B — `stripMarkers(text)`.** Neutralizes explicit supersession keywords (`superseded`, `corrected`, `retired`, `revised`, `replaces`, `no longer`, `updated from`, …) for the stripped pass. With-markers pass uses raw (truncated) text.

### Component 2 — detection core

`detectSupersession(docA, docB, llm, model): Promise<Result<SupersessionVerdict, Error>>` — calls `llm.completeJson` with the schema at temperature 0. Truncates each doc as `birth.ts` does (central claim is early). Reusable; the harness supplies the corpus pairs.

### Component 3 — gold-builder (`integrations/recall-bench/src/sp3-gold.ts`, deterministic, no LLM)

- Parse `arcs-180d.yaml` `type: correction` entries (`correctedDay`, `correctedBelief`, original reference) and `qa-180d/questions.yaml` `irrelevant_after` cutoffs.
- For each corrected fact, resolve **stale-bearing doc(s)** (carry the original value) and **current-bearing doc(s)** (carry the corrected value) by deterministic token match.
- Emit gold edges as (stale-doc → current-doc) for the same fact. **Lenient credit:** because values co-reside, a detection counts as correct if it links *a* stale-bearing doc to *a* current-bearing doc for the right corrected fact (fact/arc-level match, not exact doc-pair).
- Dump the resolved gold set to a file for human spot-check. **Golden cases:** Jamie 7:00→6:30 (`correction-jamie-preference`, `correctedDay: 19`); Condor $510M→$465M (`correction-condor-valuation`, `correctedDay: 100`).
- **Field names (verified):** single `questions.yaml`, snake_case `relevant_days` / `answer` / `irrelevant_after`.

### Component 4 — recency-overlap baseline (`sp3-baseline.ts`, no LLM)

For each candidate pair that shares a topic/entity (embedding-neighbor overlap or shared arc tag): predict "later doc supersedes earlier." Scored against the same gold. This is the bar.

### Component 5 — runner + report (`sp3-detection-eval.ts`)

- Ingest `memories-180d/` once into a temp vault under `os.tmpdir()`; `reindexVault`; assert `vectorEnabled`.
- Candidate pairs = each doc's top-K (K≈5) embedding neighbors (mirrors `birth`; bounds cost).
- Per pair: recency prediction; `detectSupersession` with-markers; `detectSupersession` stripped (Haiku).
- Report:
  - P/R/F1 for **recency baseline**, **LLM with-markers**, **LLM stripped** vs gold.
  - **LLM-stripped − recency** gap (the meaningful result).
  - **with-markers − stripped** gap (marker leakage).
  - **Candidate coverage:** fraction of gold pairs reachable in the top-K neighbor set (recall is capped by retrieval, not detection — surface this so a retrieval miss isn't blamed on detection).
  - Haiku token cost.
- Output JSON + markdown into `integrations/recall-bench/results/` (gitignored).

## Testing

- `supersession-prompt.ts` units: parser accepts a valid verdict, rejects malformed (mirrors `parseDerivationVerdict` tests); `stripMarkers` removes the keyword set and leaves values intact.
- gold-builder unit on a fixture arc + the two golden cases.
- recency-baseline unit on a tiny synthetic pair set.
- Detection-core integration test is LLM-gated (real Haiku call) — gate behind an env flag; the rest is hermetic.
- Harness ingest is MiniLM-gated; re-check the known CI MiniLM load flake before treating a red as regression.

## Fidelity constraints

1. **Soft / never hide history** — N/A to detection (no ranking/exclusion here); detected edges are advisory.
2. **Edge-based, not recency** — *the central thing under test.* Enforced by withholding dates from the LLM and requiring it to beat the recency baseline.
3. **Earned confidence** — in production, detected edges enter as k=0 and earn strength via observe/contest. This test measures *raw* detection; it does not auto-apply edges (shadow posture).
4. **Determinism** — temperature 0; residual Haiku nondeterminism noted as a caveat (optionally average N runs if it proves noisy).
5. **Query-conditioned** — N/A (no retrieval/answer step in this test).

## Definition of done

- `supersession-prompt.ts` + detection core implemented with unit tests green.
- gold-builder resolves both golden cases; gold set dumped for spot-check.
- Runner produces the report with all three P/R/F1 rows + both gaps + coverage diagnostic + cost.
- Result interpreted against the kill condition (LLM-stripped vs recency).

## Risks

- **Gold-edge resolution accuracy** (mapping corrections to docs) — same risk that surfaced in SP2 review; mitigated by golden cases + the human-readable gold dump. Validate before trusting metrics.
- **Sparse ground truth** — 2 tagged corrections in EA-180d; `irrelevant_after` adds 14 (64 in EA-500d). If n is too thin for a stable F1, run EA-500d or pool personas before concluding. State n in the report.
- **Candidate coverage ceiling** — if gold stale/current docs aren't mutual top-K neighbors, detection recall is capped by retrieval; the coverage diagnostic exposes this.
- **Haiku nondeterminism** at temp 0 — note; escalate or average if it destabilizes the comparison.
