# Results — synthetic contract-supersession falsifier (CB2/CB3 mechanism test)

**Date:** 2026-06-25
**Branch / commit:** `feat/contract-bench-arms` @ `f964496` (CB1 rebased clean onto main v1.29.0 + the arms).
**Verdict:** **Mechanism WIN.** On the STALE variant, daftari's clause-scoped `resolveCurrentSource` beats the strong recency baseline on scoped-current **1.0 vs 0.0** with **0 fabrication**; on the CLEAN control they tie **1.0 = 1.0** (clean scoped supersession is recency-resolvable, as predicted). → greenlight the deferred EDGAR realism run.
**Specs:** `2026-06-25-synthetic-contract-supersession-falsifier-design.md` (this), `2026-06-22-contract-supersession-benchmark-design.md` (parent methodology). **Related:** [[project_contract_supersession_benchmark]], [[project_daftari_paper]].

## What this tested (and what it did NOT)

The synthetic corpus tests the **mechanism + harness**: does daftari's clause-scoped supersession resolution beat clause-keyed recency-extraction on a corpus that *contains* scoped supersession with stale mentions, and is the arm/bucket/metric machinery sound? It does **not** test the **regime** — whether *real* contracts contain mention-without-governance often enough for recency to fail. That is the deferred EDGAR run. A synthetic WIN proves the mechanism works when the structure is present; it does not prove the structure is common in the wild.

Stale-mention presence is the **independent variable**, made explicit via two variants — not a knob smuggled into a single corpus.

## Setup

- Generator (`synth-gen.ts`): deterministic, seed 20260625, 12 Section clauses, 2 amendments. Amendment-1 restates the even-indexed clauses (governing ≠ latest → **scoped-current**); amendment-2 (latest) restates the others (→ **latest-current** control). Plus 2 absent clauses (4.99, 4.100) as the **no-value** fabrication probe.
  - **CLEAN:** scoped amendments only.
  - **STALE:** the latest amendment additionally recites **every** scoped clause at its OLD value — `"For reference, Section X remains in full force and reads as follows: '<OLD>'"` — phrased with `as follows:` but **no operative phrase**, so `parseCitations` emits no op (ground truth intact) while Arm A's most-recent-mention becomes stale.
- Pipeline: the existing CB1 `assemble()` (perturb values consistently → resolve clause chains → atomized clause-version vault with clause-scoped `superseded_by` → QAs). Vault reindexed (`reindexVault`), answered, scored.
- **Arm A (recency):** `extractValue` from the most-recent whole-contract doc that mentions the clause (the CF-`wiki.py` analog).
- **Arm C (daftari):** retrieve the clause's atomized version docs, `resolveCurrentSource` to the governing terminal, return its value. Never mints (no candidate → `NOT_PRESENT`).

## Result

| Variant | Bucket | Arm A (recency) | Arm C (daftari) | Verdict |
|---|---|---|---|---|
| CLEAN | scoped-current | 1.00 | 1.00 | **INCONCLUSIVE** (Δ 0) |
| CLEAN | latest-current | 1.00 | 1.00 | — |
| STALE | scoped-current | **0.00** | **1.00** | **WIN** (Δ 1.0) |
| STALE | latest-current | 1.00 | 1.00 | — |
| both | no-value (fabrication) | 0.00 | 0.00 | both clean |

On STALE scoped-current, recency returns the stale OLD values every time (e.g. 7% vs GT 8%; $655,928 vs $1,514,597; 238 vs 231 days); daftari resolves the clause-scoped chain to the governing value every time. Neither arm fabricates on the no-value probe (Arm A finds no mention → `NOT_PRESENT`; Arm C finds no candidate → `NOT_PRESENT`). The fabrication contrast becomes meaningful only when **Arm B (LLM-synth)** is added — deferred.

## Interpretation (honest)

- **The mechanism delivers under favorable structure** — exactly the spec's WIN condition. It does NOT yet show daftari has a real-world niche; that needs the EDGAR run measuring how often real amendment chains are STALE-shaped.
- **CLEAN ties, by design** — when later docs don't carry stale mentions, clause-keyed recency is correct and daftari adds nothing. This is the honest boundary of daftari's niche.
- **Arm A is a faithful foil, not a strawman** — it uses the same value extractor and the *strong* most-recent-mentioning rule; it fails only because the STALE recital is a genuine later mention with a non-governing value.

## Secondary finding (a chunk-default boundary)

Arm C initially missed 2 clauses (`NOT_PRESENT`) under default retrieval — a direct interaction with the **v1.29.0 chunk-BM25 default flip**: the atomized clause body is the *bare value* ("6 months") and the clause id lives only in the title/frontmatter, so body-only chunk-BM25 can't reliably retrieve by clause id among many same-titled docs. Fixed by retrieving with `lexicalGranularity:"document"` (title-indexed) + a high limit, so **resolution** (the thing under test) is isolated from retrieval ranking. Boundary worth noting: chunk-default is tuned for multi-topic *prose-body* docs; for *title-keyed, short-value* docs (atomized facts) document-granularity or the title tier carries the signal. Not a regression in the flip's validated domain, but a real edge.

## Kill condition outcome

Not killed. The mechanism beats recency materially on STALE scoped-current (Δ 1.0 ≫ 0.2 threshold) and ties on CLEAN. → proceed.

## Next

- **EDGAR realism run (deferred, now greenlit):** reconstruct real master→amendment chains from EDGAR Exhibit-10 (party + contract-number + exhibit-description), clause-annotate a 50–200 chain sample, run the same arms. Answers the regime/frequency question (MCC is not usable — binary amendment flag, no chain linkage; see the spec). Its own spec when started.
- **Arm B (LLM-synth)** and **CB4 (acquired clause-supersession edges via the cortex loop)** — the publishable contribution per [[project_contract_supersession_benchmark]] — after the realism run.

## Artifacts

- Harness: `integrations/contract-bench/src/{synth-gen,arm-recency,metrics}.ts` (+ the reused CB1 modules), `integrations/contract-bench/falsifier-runner.mjs`. 63 unit tests green; tsc clean.
- Data: `/tmp/contract-bench/{clean,stale}/{vault,summary.json}` (ephemeral — regenerate via the runner: build the package `tsc` then `node integrations/contract-bench/falsifier-runner.mjs`).
