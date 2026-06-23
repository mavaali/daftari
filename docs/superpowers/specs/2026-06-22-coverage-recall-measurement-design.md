# Design — Coverage recall measurement (coverage retrieval Stage 3)

**Date:** 2026-06-22
**Status:** approved design, pre-implementation
**Lineage:** Stage 3 of edge-aware coverage retrieval ([[project_coverage_retrieval]]; Stage 1 shipped v1.28.0). Closes the loop on the Recall Bench thesis that motivated the feature (recall is the dominant failure; oracle arm cut recall-miss hallucination 27.8% → 1.3%). Stage 2 (edge expansion) is deferred — near-silent on real vaults today.

## Problem

Stage 1 shipped a coverage pass that widens `vault_search` with same-entity, in-window documents. Its tests prove *behavior* (it fires, bounded, composes with SP-A). They do not prove *impact*: does it actually retrieve the relevant documents that ranking missed, and does that cut hallucination toward the oracle ceiling? Stage 3 measures that on Recall Bench (RB), the corpus the motivating evidence came from.

### The corpus mismatch (and its resolution)

Stage 1 fires on a **shared frontmatter tag** among ≥2 top seeds. The RB corpus is 180 tag-less journal day-files (`type: daily`, prose body, multiple topics each). So on raw RB the entity signal never fires — coverage would measure nothing.

**Resolution:** index the RB day-files as a daftari vault where every day-file carries one **uniform tag** and `created` = its day's date. `detectSharedEntity` then trivially matches that shared tag on any seed pair, and the coverage pass **degenerates into pure date-window gathering** — "pull the day-files in the date-neighborhood of the top hits." This exercises the *actual shipped code path* with no changes.

**Scope (chosen):** this measures the **date-window / recall half** of coverage — the part that applies to a journal corpus and the generalizable recall lever the thread identified. It does **not** exercise the discriminating-tag half (which needs a native vault with distinct tags + a labeled relevant-set; deferred, no RB ground truth).

## Goal / non-goals

**Goal:** a reproducible measurement answering, on RB: (1) does coverage retrieve more of the true relevant days than ranking alone, beyond what naive rank-extension would; (2) if so, does that cut hallucination toward the oracle ceiling — or backfire.

**Non-goals:**
- No change to the shipped Stage 1 code. The measurement calls retrieval functions; it does not modify `vault_search`/`coverage.ts`.
- No tag/atomization synthesis of RB content (that is SP-C / a separate corpus). Uniform tag only.
- No tuning sweep of `CoverageOptions` in the first cut — run at defaults, report; sweeping is a follow-up only if results warrant.

## Design

### 1. Corpus prep — `integrations/recall-bench/prep-vault.mjs`
Transforms the 180 RB day-files into an indexable daftari vault (written to a scratch dir):
- Inject `created` = each day's date: `day-0001` → `2026-01-01`, `day-N` → base + (N−1) days (UTC). **Load-bearing** — the date-window keys on `created`; without it the window is empty.
- Inject `tags: [daily]` (the uniform entity) and fill the other required frontmatter fields with valid defaults (`title` from the first `#` header or the filename, `collection`, `domain`, `status`, `confidence`, `updated` = `created`, `provenance`). Body kept verbatim.
- Then `reindexVault(scratchVault)`.

### 2. A/B retrieval — `integrations/recall-bench/recall-runner.mjs`
For each RB question, retrieve at the function level (no tool changes), so off/on is a clean toggle:
- **coverage-OFF (baseline):** `hybridSearch(db, qa.question, {limit})` → ranked hits.
- **coverage-ON:** `applyCoveragePass(db, rankedHits, DEFAULT_COVERAGE_OPTIONS)` on those hits.
- **matched-budget baseline:** `hybridSearch(db, qa.question, {limit: limit + maxAdd})` → top-`(limit+maxAdd)` ranked hits.

Map each returned `path` → day number (`day-NNNN`). `limit`/`maxAdd` = Stage-1 defaults (10 / 5); recorded in the output so a later sweep is comparable.

### 3. Span-recall metric (cheap arm, the gate)
Per question: `recall = |returnedDays ∩ qa.relevantDays| / |qa.relevantDays|`. Aggregate **split by single-day vs multi-day** (`|relevantDays|` == 1 vs > 1). Report three series:
- coverage-ON,
- coverage-OFF (top-`limit`) — the deployment-realistic "does the feature help at all",
- matched-budget (top-`limit+maxAdd`) — the **real test**: does date-window *selection* beat asking for the same number of next-ranked docs.

No LLM; deterministic; `$0`.

### 4. Gated LLM arm (only if the recall gate passes)
Reuse the oracle harness machinery (`/tmp/oracle-recall.mjs`: answerer `anthropic/claude-haiku-4.5`, grounded judge `openai/gpt-5.4-mini`, OpenRouter via `integrations/recall-bench/.env`, concurrency 6, retries, judge `max_tokens ≥ 16`). For each **multi-day** question, build the context from coverage-OFF days and from coverage-ON days, answer each, and judge `hallucination` (1=grounded, 0=hallucinated). Multi-day-only bounds cost to a fraction of the ~$400 full SP1 run; the gate means we only spend if recall improved.

### 5. Success / kill criteria (adjustable)
**Recall gate:**
- *Proceed* → coverage-ON multi-day recall beats both baselines, ≥ ~5pp absolute over the matched-budget baseline.
- *Kill* → coverage-ON ≤ matched-budget baseline. Date-window adds nothing over rank-extension. Write the negative result; skip the LLM arm.

**Hallucination (gated).** Anchors: multi-day baseline ~18.2% hallucinated; oracle ceiling ~1.3%.
- *Win* → coverage-ON multi-day hallucination drops meaningfully below coverage-OFF, toward the ceiling.
- *Backfire / null* → coverage-ON ≥ coverage-OFF. A **legitimate, publishable** finding, not a failure to hide: RB has no supersession edges, so SP-A cannot demote the distractor days coverage adds; the recall gain is swamped by distractor cost. That would say the recall lever pays off only *with* suppression — motivating the native-vault test or an SP-A-on-RB follow-up, not more coverage tuning.

### 6. Deliverable (Experiment-and-Publish)
`docs/superpowers/results/2026-06-22-coverage-recall-measurement.md`: the recall table (single vs multi-day, three series), the gate decision, and if run, the hallucination table + an explicit win/backfire/null verdict against the kill condition. Both harness scripts committed under `integrations/recall-bench/` for reproducibility.

## Risks / open items
- **Ephemeral inputs.** The RB corpus (`/tmp/recall-review/...memories-180d`) and oracle harness (`/tmp/oracle-recall.mjs`) are in `/tmp` and may be gone — re-clone `Stevenic/recall` (MIT) and re-create if missing. The prep script should fail loudly if the corpus is absent.
- **Date derivation.** `day-N → base + (N−1)` assumes contiguous daily files from `2026-01-01`. Verify against a day-file's in-body date (day-0001 body says 2026-01-01) before trusting; the prep script asserts the mapping on a sample.
- **`maxAdd`=5 may undershoot** long relevant spans (a multi-day question whose relevant set > 5 days can't be fully recovered at default cap). Report the relevantDays-length distribution; if recall is capped by `maxAdd`, note it and consider a sweep as the follow-up rather than silently under-measuring.
- **Cost realism.** Even multi-day-only × 2 arms × 2 LLM calls has a real $ cost; the runner must print an up-front question count + rough estimate and support `--smoke` (a handful of questions) before the full arm.
- **Confound — uniform tag changes ranking?** Injecting `tags: [daily]` adds the token "daily" to every doc's FTS text. Verify it doesn't distort BM25 (it's uniform, so it should wash out, but confirm the baseline ranking matches an untagged index on a sample of queries).
