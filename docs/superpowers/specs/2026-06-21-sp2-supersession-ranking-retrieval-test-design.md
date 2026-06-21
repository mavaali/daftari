# SP2 (oracle) — supersession-aware ranking: zero-inference retrieval test

> **⛔ KILLED 2026-06-21 in spec review — DO NOT IMPLEMENT.** The design rests on a precondition (current and stale values live in *separate* documents) that Recall Bench EA-180d violates: supersession there is *intra-document* (one daily journal entry restates both values), with only n=2 tagged corrections and historical/current QAs sharing the same `relevant_days`. Document ranking cannot separate two values inside one document. The supersession bottleneck for journal corpora is **atomization (SP3/cortex), not ranking**. Full writeup + evidence: [../results/2026-06-21-sp2-ranking-premise-killed.md](../results/2026-06-21-sp2-ranking-premise-killed.md). The design below is retained only as the record of what was considered.

**Date:** 2026-06-21
**Status:** KILLED (premise failure caught in review). Superseded by the finding note linked above.
**Scope:** The cheap, high-value core of SP2 — prove (or kill) the thesis that wiring supersession into `hybrid.ts` makes the *current* version of a revised fact outrank its *stale* version. **Zero LLM inference** (local BM25 + MiniLM only; no answerer, no judge). Runs on any machine for $0.

## Problem

The SP1 baseline ([2026-06-21-recall-bench-baseline.md](../results/2026-06-21-recall-bench-baseline.md)) measured 15.2% hallucination, concentrated in the categories that probe temporal robustness (recency-bias-resistance 28%, decision-tracking 24%). Root cause, verified in code: daftari's ranking score is pure lexical+semantic similarity ([`hybrid.ts:210`](../../../src/search/hybrid.ts)) — a revised fact's draft and its revision are equally on-topic, so both rank high with no signal distinguishing current from stale, and the answerer confidently reports the stale one. `hybrid.ts:227` already carries `doc.supersededBy` into the hit as annotation; the *score* ignores it.

SP2's thesis: **make the score consume the supersession signal it already carries, and the current doc outranks the stale doc.** This spec tests that thesis cheaply, before any expensive answer-quality re-run.

## Non-goals

- No answer-quality / end-to-end benchmark (that's the expensive opus+judge run, deferred).
- No SP3 auto-detection of supersession (that needs the cortex loop = inference). This test uses **oracle** edges from ground-truth corpus metadata.
- No query-conditioning (constraint #5) implemented — deliberately deferred and *measured* instead (see Metrics).

## Win condition

**Current-above-stale rate** on revised-fact, current-seeking QAs: the fraction where the current-version doc outranks its superseded version, baseline vs. oracle-edges-on. A material rise validates the thesis; no rise kills it (and points the failure elsewhere — answerer confabulation or retrieval recall).

## Architecture

One production change (`hybrid.ts`) + a self-contained harness under `integrations/recall-bench/`. Data flow:

```
arcs-180d.yaml (type:correction)  ┐
qa-180d/                          ├─► oracle-builder ─► (asOfDate → supersededPaths)  ┐
memories-180d/                    ┘                  └─► (stale/current doc pairs)     │
qa-180d/ ─► qa-classifier ─► {lift | harm | no-regression} buckets                    │
memories-180d/ ─► ingest once (temp vault, MiniLM) ─► index ──────────────────────────┤
                                                                                       ▼
                              per QA: hybridSearch(baseline) vs hybridSearch(oracle-on)
                                                                                       ▼
                                                      metric report (rates + sweep)
```

### Component 1 — `hybrid.ts` supersession flag (production, default-off)

`hybridSearch`'s options gain:
```ts
supersession?: { supersededPaths: ReadonlySet<string>; weight: number }  // weight ∈ [0,1)
```
In the scoring loop, immediately after the existing mix:
```ts
let score = weights.bm25 * bm25Score + weights.vector * vectorScore;
if (supersession && supersession.weight > 0 && supersession.supersededPaths.has(path)) {
  score *= (1 - supersession.weight);   // soft, multiplicative, deterministic
}
```
- Absent option (or `weight === 0`) ⇒ **byte-identical** to current behavior.
- The hit's `decay`/`superseded_by` annotation (lines 221–227) is unchanged.
- **Source of `supersededPaths`:** the test injects it (oracle). In production SP2 the same set is built from the `doc.supersededBy` already on the hit — so the *scoring code under test is exactly what ships*; only the data source differs.

### Component 2 — oracle-builder (`src/oracle.ts`, deterministic, no LLM)

- Parse `arcs-180d.yaml`; extract `type: correction` entries (`id`, `correctedDay`, `correctedBelief`, references to original).
- Resolve each correction to **stale doc(s)** (days `< correctedDay` in the arc's session carrying the original value) and **current doc(s)** (days `≥ correctedDay` carrying `correctedBelief`), by deterministic token match against `memories-180d/` files.
- Expose `supersededAsOf(date) → Set<path>`: union of stale docs whose correction's `correctedDay ≤ date` — this handles time-layered corrections (e.g. Condor day-13 then day-100) with no re-indexing.
- Emit the full resolved stale/current pair list to a file for human spot-check.
- **Golden cases** (already hand-verified, must resolve correctly): Condor synergy (stale=`day-0005`, current=`day-0013/0014`); Jamie briefing (`correction-jamie-preference`, `correctedDay: 19`).

### Component 3 — qa-classifier (`src/classify.ts`, deterministic, no LLM)

Bucket each `qa-180d` QA:
- **lift** — answer (`relevantDays`) is a corrected belief and the question asks for the *current* value.
- **harm** — question asks for the *original* / pre-correction value (downweighting stale must not bury this).
- **no-regression** — QA touches no correction.

Linkage by arc/topic + `relevantDays` vs `correctedDay`; current-vs-historical phrasing by keyword heuristic (`original`, `first`, `corrected to`, `currently`, …). All deterministic.

### Component 4 — runner + report (`src/sp2-retrieval-eval.ts`)

- Ingest `memories-180d/` once into a temp vault under `os.tmpdir()`; `reindexVault` (local MiniLM). Assert `vectorEnabled` (same confound guard as the SP1 adapter).
- Per QA: effective date = max(`relevantDays`) (the as-of point the question is asked). `supersededPaths = oracle.supersededAsOf(date)`. Run `hybridSearch` baseline (`{}`) and oracle-on (`{ supersession: { supersededPaths, weight } }`). Record rank of current doc and stale doc; recall@15 of current doc.
- Report:
  - **Primary:** current-above-stale rate, baseline vs oracle-on, on the **lift** bucket.
  - **Harm:** rank movement of the *historical* answer for the **harm** bucket (cost of flat downweight; what #5 must recover).
  - **No-regression:** assert ordering byte-identical for **no-regression** QAs (no superseded paths ⇒ identical scores).
  - **Weight sweep:** 0.25 / 0.5 / 0.75.
  - Output JSON + a short markdown summary into `integrations/recall-bench/results/` (gitignored).

## Testing

- `hybrid.ts` units: (a) no `supersession` opt ⇒ ranking identical to a captured baseline (regression guard); (b) a superseded path + `weight: 0.5` ⇒ that doc's score halved, ordering shifts as expected; (c) `weight: 0` with a non-empty set ⇒ no-op.
- oracle-builder unit on a small fixture arc with one `correction` ⇒ correct stale/current day resolution; plus the two golden cases above.
- classifier unit on representative QAs for each bucket.
- Harness is integration-gated (`reindexVault` loads MiniLM); re-check the known CI MiniLM load flake before treating a red as a regression.

## Fidelity constraints

1. **Soft, not exclude** — multiplicative `(1-weight)`; superseded doc remains in the result set.
2. **Edge-based, not recency** — downweight is keyed on the correction-derived `supersededPaths`, never on document dates/timestamps.
3. **Earned confidence** — oracle edges are ground-truth (trust = 1); SP3 will earn confidence. The `weight` is the trust dial.
4. **Determinism preserved** — no randomness; default-off path asserted byte-identical.
5. **Query-conditioned** — *deferred by design*; the harm-bucket metric quantifies the damage flat downweighting does to historical-seeking queries, defining the gap #5 must close.

## Definition of done

- `hybrid.ts` supersession flag implemented, default-off, with the 3 regression/behavior unit tests green.
- oracle-builder resolves both golden cases correctly; pair dump produced for spot-check.
- Runner produces the report with all four sections (primary / harm / no-regression / sweep).
- Result interpreted against the **kill condition**: if oracle-on does not materially raise current-above-stale on the lift bucket, the supersession-ranking thesis is wrong and the SP2 programme is reconsidered.

## Risks

- **Stale-doc resolution accuracy** is the main correctness risk (token-matching corrections to docs). Mitigated by the golden cases + the human-readable pair dump; if resolution is noisy, tighten the matcher before trusting the metric.
- **Classifier precision** (current- vs historical-seeking) affects bucket purity, not the core mechanism; report bucket sizes so a skewed split is visible.
