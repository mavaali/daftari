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
- Inject `tags: [daily]` (the uniform entity) and fill the other required fields with valid defaults: `collection`, `domain`, `status`, `confidence`, `updated` = `created`, `provenance`. **`title` must be inert and question-orthogonal** — use a constant template `daily log <created>`, NOT the first prose header. (FTS indexes `title + tags + body`; the uniform tag's IDF washes out, but a per-doc prose title does not, and a `qa.question` term colliding with it would perturb the very baseline ranking coverage is measured against.) Body kept verbatim.
- **Verification assertion (corrected):** the recall metric derives `returnedDays` from the **path** (`day-NNNN`), not from `created`, so `created` does not need to equal any in-body date — it only needs to be **monotonic, contiguous, one-file-per-day across 180 days** so the window pulls the right neighboring files. Assert *that* (not an in-body-date match — the earliest body date is often trip/topic prose, not the file's own day, so an in-body assertion gives false failures).
- Then `reindexVault(scratchVault)`.

### 2. A/B retrieval — `integrations/recall-bench/recall-runner.mjs`
For each RB question, retrieve at the function level (no tool changes; `hybridSearch` is async — `await` and unwrap `.ok`/`.value`), so off/on is a clean toggle:
- **coverage-OFF (baseline):** `hybridSearch(db, qa.question, {limit})` → ranked hits.
- **coverage-ON:** `applyCoveragePass(db, rankedHits, opts)` on those hits.
- **matched-budget baseline:** `hybridSearch(db, qa.question, {limit: limit + maxAdd})` → top-`(limit+maxAdd)` ranked hits.

`limit` = Stage-1 default (10). **Run coverage-ON at two `maxAdd` settings** (see Issue A): `maxAdd=5` (as-shipped) **and** `maxAdd=14` (enough to cover the 7-day modal span end-to-end, padded). This separates "the default cap starved recall" from "date-window selection genuinely doesn't help." Both are reported; the matched-budget baseline is taken at the corresponding `limit+maxAdd`.

Map each returned `path` → day number. **Pin the embedding provider** and assert `vectorUsed` is identical across all arms (a flipped vector half would change ranking and invalidate the A/B). **Record the realized doc count per arm** — coverage-ON adds only when it fires and finds new in-window docs, so it can return *fewer* than `limit+maxAdd`; the matched-budget comparison is an equal-budget *ceiling*, not equal realized count, and the report must show both.

### 3. Span-recall metric (cheap arm, the gate)
Per question: `recall = |returnedDays ∩ qa.relevantDays| / |qa.relevantDays|` at a **stated effective `k`** per series (so the three series compare at equal retrieval depth). Aggregate split by single-day vs multi-day, and — because the cap binds on the modal span — **also condition recall on `|relevantDays|` length** (report the length distribution; the length-7 cohort is cap-limited at `maxAdd=5`). Series:
- coverage-ON @ `maxAdd=5` (as-shipped) and @ `maxAdd=14` (uncapped),
- coverage-OFF (top-`limit`) — deployment-realistic "does the feature help at all",
- matched-budget (top-`limit+maxAdd`), computed **at each `maxAdd`** (top-15 for the maxAdd=5 arm, top-24 for the maxAdd=14 arm) — the **real test**: does date-window *selection* beat asking for the same number of next-ranked docs at equal budget.

**Also report, per coverage-ON arm, the relevant-vs-distractor split of the *added* docs** (how many additions were in `relevantDays` vs not). This is the key disambiguator for a later backfire: it separates "distractors swamped a real recall gain" from "the cap starved the recall gain so only distractors were added." Note the as-shipped `gatherCandidates` takes the **newest** in-window docs (`created DESC`, then `slice(maxAdd)`), so for a span like `[8..14]` the additions skew recent — a selection limitation of the shipped feature, to be reported, not silently absorbed.

No LLM; deterministic; `$0`.

### 4. Gated LLM arm (only if the recall gate passes)
Reuse the oracle harness machinery (`/tmp/oracle-recall.mjs`: answerer `anthropic/claude-haiku-4.5`, grounded judge `openai/gpt-5.4-mini`, OpenRouter via `integrations/recall-bench/.env`, concurrency 6, retries, judge `max_tokens ≥ 16`). For each **multi-day** question, build the context from coverage-OFF days and from coverage-ON days (the better-recall `maxAdd` arm), answer each, and judge `hallucination` (1=grounded, 0=hallucinated). Multi-day-only is the fair scope: on a single-day question every coverage-added doc is by construction a distractor, so including them would *guarantee* backfire and measure nothing about the recall lever — but the writeup must state explicitly that **the hallucination finding is scoped to multi-day questions** and does not generalize to the single-day majority. Multi-day-only also bounds cost to a fraction of the ~$400 full SP1 run; the gate means we only spend if recall improved.

### 5. Success / kill criteria (adjustable)
**Recall gate:**
- *Proceed* → coverage-ON multi-day recall beats both baselines, ≥ ~5pp absolute over the matched-budget baseline *at the same `maxAdd`* (evaluated on the maxAdd=14 arm, which isn't cap-starved).
- *Kill* → coverage-ON ≤ matched-budget baseline. Date-window adds nothing over rank-extension. Write the negative result; skip the LLM arm.

**Hallucination (gated).** Anchors: multi-day baseline ~18.2% hallucinated; oracle ceiling ~1.3%.
- *Win* → coverage-ON multi-day hallucination drops meaningfully below coverage-OFF, toward the ceiling.
- *Backfire / null* → coverage-ON ≥ coverage-OFF. A **legitimate, publishable** finding, not a failure to hide: RB has no supersession edges, so SP-A cannot demote the distractor days coverage adds; the recall gain is swamped by distractor cost. That would say the recall lever pays off only *with* suppression — motivating the native-vault test or an SP-A-on-RB follow-up, not more coverage tuning.
- **Disambiguating a backfire (required before attributing it):** a backfire has two distinct causes that look alike — (i) real recall gain swamped by undemoted distractors (the suppression story), vs (ii) the `maxAdd=5` cap starved the recall gain so coverage added mostly distractors and little signal (the cap story). Use the added-docs relevant-vs-distractor split (§3) and the `maxAdd=14` arm to tell them apart: if the uncapped arm recovers the relevant span but still backfires, it's (i); if recall barely moves even uncapped, the lever — not suppression — is the issue. Do not attribute the cause without this.

### 6. Deliverable (Experiment-and-Publish)
`docs/superpowers/results/2026-06-22-coverage-recall-measurement.md`: the recall table (single vs multi-day, three series), the gate decision, and if run, the hallucination table + an explicit win/backfire/null verdict against the kill condition. Both harness scripts committed under `integrations/recall-bench/` for reproducibility.

## Risks / open items
- **Ephemeral inputs.** The RB corpus (`/tmp/recall-review/...memories-180d`) and oracle harness (`/tmp/oracle-recall.mjs`) are in `/tmp` and may be gone — re-clone `Stevenic/recall` (MIT) and re-create if missing. The prep script should fail loudly if the corpus is absent.
- **Date derivation.** `day-N → base + (N−1)` assumes contiguous daily files from `2026-01-01`. Spot-check ONLY the base offset once (day-0001's body says 2026-01-01 → base = 2026-01-01); do NOT assert per-file in-body-date matches (the earliest body date is often topic prose, not the file's own day — see §1). The prep script's real assertion is the §1 monotonic/contiguous/180-day check, which is what the date-window depends on.
- **`maxAdd`=5 binds on the MODAL case, not the tail.** RB multi-day `relevantDays` are contiguous weekly spans — ~71% are exactly length 7 (>5), ~75% are ≥6. So coverage-ON recall is mechanically capped below 1.0 for the majority of multi-day questions, and a weak/null result at the default cap would be an artifact, not a finding. Mitigation is built into the design (§2 dual-`maxAdd` run, §3 length-conditioned recall + added-doc relevant/distractor split, §5 backfire disambiguation), not deferred to a follow-up. The `gatherCandidates` recency-skew (newest-5) is a real selection limitation of the shipped feature — report it.
- **Cost realism.** Even multi-day-only × 2 arms × 2 LLM calls has a real $ cost; the runner must print an up-front question count + rough estimate and support `--smoke` (a handful of questions) before the full arm.
- **Confound — injected tokens in FTS.** The uniform `tags:[daily]` washes out (uniform IDF≈0), but an injected per-doc `title` would NOT — handled in §1 by using an inert constant title. Verify on a sample that the coverage-OFF ranking on the prepped vault matches a plain/untagged index for the same queries (tag + title parity).
- **Confound — vector half must be constant across arms.** Pin the embedding provider; assert `vectorUsed` is identical across coverage-OFF / coverage-ON / matched-budget (a flipped vector half changes ranking and breaks the A/B).
- **Ephemeral inputs (restated):** the prep + runner scripts must fail loudly if `/tmp/recall-review/...memories-180d` or the question file is absent.
