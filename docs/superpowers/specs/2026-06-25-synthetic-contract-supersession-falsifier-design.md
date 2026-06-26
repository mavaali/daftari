# Synthetic contract-supersession falsifier (Design)

**Date:** 2026-06-25
**Status:** Design approved (corpus strategy + Arm-A faithfulness decided with Mihir 2026-06-25), pre-implementation
**Parent:** `docs/superpowers/specs/2026-06-22-contract-supersession-benchmark-design.md` — the full methodology (arms, buckets, metrics, kill condition). This spec is the **synthetic-corpus variant** of CB1+CB2(ArmA)+CB3(ArmC); it changes the corpus source and pins the modeling, reusing everything else.
**Related:** [[project_contract_supersession_benchmark]], [[project_recall_bench_experiment]], `src/search/current-source.ts` (`resolveCurrentSource`), the MCC probe finding (below).

## Why synthetic-first (the MCC finding)

The parent spec assumed Stanford's MCC supplies real amendment chains. **It does not** (probe 2026-06-25): MCC has a binary `amendment` flag (~29% of 1.04M docs) but **zero cross-document linkage** — no parent pointer, no clause-level annotation. Real chains must be reconstructed from EDGAR Exhibit-10 filings (party + contract-number + exhibit-description signals) and clause-annotated by hand/LLM — a substantial build, not a download. The only pre-linked corpus (Song 2021) is confidential.

So the corpus splits into two efforts: a **synthetic falsifier** (this spec, the critical path) and a deferred **EDGAR realism run** (gated on the synthetic mechanism passing).

## What synthetic can and cannot answer (the load-bearing reframe)

- **CAN — the mechanism + harness.** Does daftari's clause-scoped `superseded_by` chain resolution (`resolveCurrentSource`) correctly return the governing clause value and **beat clause-keyed recency-extraction** on a corpus that *contains* scoped supersession with stale mentions? Are the arms, buckets, metrics, and fabrication probe sound? A synthetic **failure here cheaply kills the mechanism** (e.g., resolution bug, retrieval misses the governing clause-doc).
- **CANNOT — the regime.** Whether *real* contract language actually contains mention-without-governance often enough that clause-keyed recency fails. That is an empirical property of real contracts → the deferred EDGAR run. A synthetic **win does not prove the regime**; it proves the mechanism works *when the structure is present*.

This is why the strong baseline's failure can't be assumed into a generator without rigging the result — hence the two-variant design below makes the rigging an explicit independent variable.

## The two corpus variants (Arm-A faithfulness as the independent variable)

The strong baseline (Arm A) returns clause X's value from the **most-recent document that mentions X**. Whether A faithfully fails depends entirely on whether later documents *mention* a clause without *governing* it:

- **Variant CLEAN (scoped amendments only).** A document amending §7 never mentions §4. Then most-recent-mentioning §4 = the governing doc → **A ties C** (prediction). This is the spec's KILL structure made explicit: clean scoped supersession *is* recency-resolvable when extraction is clause-keyed.
- **Variant STALE (with mention-without-governance).** Later documents carry recital/boilerplate that restates earlier clauses at their *old* values ("Except as amended hereby, Section 4.2 [old value] remains in full force…"). Now most-recent-mentioning §4 grabs a stale value → **A fails, C wins** (prediction).

**Prediction (the experiment):** C ≈ A on CLEAN; C ≫ A on STALE. This pinpoints the exact condition daftari's niche requires, and frames the EDGAR run as measuring *where real contracts fall on the CLEAN↔STALE spectrum* (a publishable real-world rate).

The STALE rate is a **knob we set**, labeled as such — never reported as a finding.

## Modeling: clause-version-as-document (the daftari arm crux)

`resolveCurrentSource` follows a **document-level** `superseded_by` pointer (`current-source.ts:39`). Contract supersession is **clause-scoped**. A single amendment doc amends several clauses, so it cannot carry one pointer expressing all of them. Therefore:

- **Daftari vault = one document per (clause, version).** `chain-NN/clause-CC-vK.md`, frontmatter carrying the clause's value at that version, with `superseded_by` → the next version of *that clause*. A clause's chain: `clause-04-v0` (master) → `clause-04-v1` (amend-2) → `clause-04-v2` (amend-5, terminal-current). `resolveCurrentSource(clause-04-v0)` follows to `clause-04-v2`.
- **Scoped supersession in this model:** the terminal-current version of clause X is filed by an amendment that is **not the latest** in the chain (the latest amendment created a version of a *different* clause). The "latest contract document" is just the max-dated set of clause-versions; the current value of most clauses lives in earlier-dated versions.
- **Whole-contract documents (for Arms A and B)** are the rendered master / amend-N text: each amend-N renders the clause-versions it governs **plus** (in STALE variant) recital lines restating other clauses at stale values. Arm A/B operate over these whole-contract docs; Arm C operates over the clause-version docs + chains. All arms derive from the **same generated chain** (one source of truth → two renderings), so the comparison is fair.

## Arms (A and C first — the cheap falsifier)

| Arm | Mechanism | Built |
|---|---|---|
| **A. Recency-extract** | Deterministic: for clause X, value from the most-recent **whole-contract doc that mentions X** (clause-keyed, the strong CF-wiki analog). Zero LLM. | CB2 |
| **C. Daftari** | Retrieve clause-X candidate docs in the vault, `resolveCurrentSource` to the chain head, return that version's value. No `hybrid.ts` change. | CB3 |
| B. LLM-synth | *(Deferred per parent spec "A and C first".)* | later |

Run A and C on both variants first. If C cannot beat A even on STALE, stop — the mechanism is dead and B/EDGAR are moot.

## Buckets (per parent spec)

scoped-current (headline — governing doc ≠ latest), latest-current (control — clause amended by the latest doc), unamended (control — value in master), no-value probe (fabrication test — clause/term absent; correct = "not present").

## Metrics

- **scoped-current accuracy** per arm per variant (exact value match). Prediction: CLEAN A≈C; STALE C≫A.
- **fabrication rate** (no-value probe): fraction returning a concrete value instead of "not present". Prediction: C≈0 (never mints — returns null/"not superseded"); A returns nearest on-topic value (record).
- **controls** latest-current + unamended: C must be ≥ A (no regression; a C miss here = retrieval/coverage bug, isolated).
- Report bucket sizes, generation seed, variant, edge-resolution spot-check.

## Win / kill (mechanism scope)

- **WIN (mechanism)** — on STALE: C ≫ A on scoped-current AND C fabrication ≈ 0. Mechanism + harness validated; greenlight the EDGAR realism run.
- **KILL (mechanism)** — C fails to beat A on STALE (resolution bug, or retrieval can't surface the governing clause-doc). Fix or abandon before any real-corpus spend.
- **Expected on CLEAN** — A ≈ C (not a failure; the designed control showing daftari adds nothing over clean clause-keyed recency, which is the honest boundary).

## Files (new; reuse recall-bench harness patterns)

| File | Responsibility |
|---|---|
| `integrations/contract-bench/gen-synthetic-chains.mjs` | Deterministic generator → both variants: clause-version docs (+`superseded_by`), whole-contract docs, QA buckets, ground-truth map. Seeded; regenerable. |
| `integrations/contract-bench/lib.mjs` | Pure helpers: chain/clause model, bucket assignment, recency-extract (Arm A), metric aggregation. Unit-tested. |
| `integrations/contract-bench/falsifier-runner.mjs` | Build vault (`reindexVault`), run Arm A + Arm C over buckets × variants, emit per-QA + summary with the WIN/KILL verdict. |
| `docs/superpowers/results/2026-06-25-synthetic-contract-supersession.md` | Results + verdict, feeding the parent benchmark + [[project_daftari_paper]]. |

No `src/` changes (Arm C uses shipped `resolveCurrentSource`). Tests mirror the recall-bench harness discipline: pure helpers unit-tested (generator consistency, bucket assignment, Arm-A faithful-foil assertion — on a STALE fixture Arm A returns the *wrong* value), runner integration-gated on `reindexVault`/MiniLM.

## Testing (the must-haves)

- **Generator unit:** seeded → identical corpus; STALE variant injects stale mentions, CLEAN does not; ground-truth map (clause → governing version → value) internally consistent.
- **Arm-A faithful-foil unit:** on a STALE scoped-current fixture, Arm A returns the *stale* value (proves it's a real foil, not a strawman); on CLEAN it returns the governing value (proves the variants differ as designed).
- **Arm-C unit:** clause chain resolves to the terminal version; no-value clause resolves to null (never mints); dangling/cycle handled (already covered by `resolveCurrentSource`, assert at the harness boundary).
- **Bucket-assignment unit:** scoped vs latest vs unamended vs no-value correctness.

## Deferred (gated on this passing)

- **EDGAR realism run** — reconstruct real master→amendment chains from EDGAR Exhibit-10 (party + contract-number + exhibit-description), clause-annotate a 50–200 chain sample (LLM + human verify), run the same arms. Answers the regime/frequency question. Its own spec when greenlit.
- **Arm B (LLM-synth)** and **CB4 (acquired edges)** — per parent spec, after A-vs-C confirms.

## Kill condition (restated, honest)

If C does not materially beat A on the **STALE** variant's scoped-current bucket, the mechanism does not deliver even under favorable structure — report it plainly (numbers, not hedge); do not proceed to EDGAR. If C beats A on STALE but ties on CLEAN (expected), the headline is "daftari's niche is the stale-mention regime; EDGAR will measure how often the real world is in it."
