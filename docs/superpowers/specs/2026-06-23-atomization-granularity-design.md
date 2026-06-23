# Design — Atomization granularity measurement (Stage A)

**Date:** 2026-06-23
**Status:** approved design, pre-implementation
**Lineage:** follows the coverage Stage 3 KILL (`docs/superpowers/results/2026-06-22-coverage-recall-measurement.md`), which showed daftari's whole-day retrieval recall on RB multi-day questions is ~0.22 and that the date-window mechanism can't fix it. Tests the long-standing hypothesis ([[project_recall_bench_experiment]]: "bottleneck is ATOMIZATION (SP3/cortex), not hybrid.ts") against the competing "the bottleneck is the ranker" reading.

## Problem

On Recall Bench (RB), a whole day-file bundles ~5–13 unrelated topics. A question about one topic may rank its day low because most of the day is off-topic — so the relevant day isn't retrieved (Stage 3: multi-day recall 0.22). **Hypothesis (H-retrieval):** retrieving at *atom* (per-topic) granularity lets the relevant topic rank high on its own, recovering relevant content that whole-day retrieval missed. This experiment tests H-retrieval directly and cheaply, and in doing so adjudicates whether the recall bottleneck is **granularity** (→ atomization / SP-C is the lever) or **the ranker itself** (→ `hybrid.ts`).

This is **Stage A** (retrieval granularity, no tags, no LLM). **Stage B** (per-topic entity tags → test the discriminating-tag coverage half) is gated on Stage A passing and gets its own design.

## Goal / non-goals

**Goal:** a reproducible, `$0` measurement answering: does atom-granularity retrieval recover more of the true relevant days than whole-day retrieval, *at matched context budget*?

**Non-goals:**
- No LLM (retrieval-recall only; no answerer/judge).
- No tagging scheme, no coverage pass (atoms carry a uniform tag). That is Stage B.
- No change to shipped daftari code. The harness calls retrieval functions over two prepared vaults.
- No atomization of non-RB corpora; no productionization of atomization (this measures whether it's worth building).

## Design

### 1. Atomization — `integrations/recall-bench/atomize-vault.mjs`
Split each of the 180 RB day-files at `###` headers into per-topic atoms (verified structure: `# session:` blocks containing `### Topic` subheaders, 3–24 per day, mostly 5–13; no deeper nesting; ~1,800 atoms total). Each atom is a daftari doc written to a scratch atom-vault:
- **Body** = the `###` block (its title line + content up to the next `#`/`###` header), with the parent `# session:` name prepended as a one-line context prefix.
- **`title`** = the `###` topic text (inert w.r.t. questions in the same way Stage 3's title was — but here the topic text is real content; see confound C2). `created` = the day's date (`day-N → 2026-01-01 + (N−1)`, reusing the Stage 3 mapping). `tags: [daily]` (uniform — Stage A). Other required frontmatter = valid defaults.
- **Path** = `notes/day-NNNN-aKK.md` (KK = atom index within the day) so the **day number is recoverable** from the path for scoring.
Then `reindexVault(atomVault)`. The Stage 3 day-vault (`/tmp/cov-recall/vault`) is the comparison baseline (re-run `prep-vault.mjs` if gone).

Assertions: every atom maps to a valid day in `[1,180]`; total atom count logged; each day contributes ≥1 atom.

### 2. Two-vault retrieval + token-budget recall curves — `integrations/recall-bench/granularity-runner.mjs`
For each of the 1,489 questions, retrieve by relevance (`hybridSearch`, generous limit) over **each vault**. Then **fill a context budget `B`** (in characters — a token proxy, **same unit for both vaults** so the comparison is fair): walk retrieved units in rank order, accumulating `content.length`, until the next unit would exceed `B`; the filled set is everything admitted. Map filled units → their day numbers.

`recall@B = |relevantDays ∩ days(filled)| / |relevantDays|`. **Sweep `B`** across a range that brackets realistic context sizes (from a few thousand chars up to ~the size of Stage 3's top-10 days). Output two curves: `dayRecall(B)` and `atomRecall(B)`, aggregated over **multi-day** questions (single-day split reported but not the focus). Stage 3's day-level number is one point on `dayRecall`.

Determinism + parity: pin the embedding provider; assert `vectorUsed` is identical across all retrievals and both vaults. Report realized filled-unit counts and realized char totals per arm at each `B` (the budget is a ceiling, not an exact fill).

### 3. Metric meaning + the one honest confound
If `atomRecall(B)` dominates `dayRecall(B)` — more relevant days recovered at equal-or-smaller `B` — granularity is the lever.

**Confound C1 (day-level truth):** ground truth is day-level, so day-coverage cannot verify the retrieved atom is the *topically-relevant* one — atom-retrieval could "cover" a relevant day via its *wrong* atom. **Mitigation:** the token-budget axis is exactly what controls for this. Reaching relevant days at a *small* budget requires the *right* atom to rank high (a wrong atom wouldn't rank there; a whole noisy day costs far more budget). So the *shape* — atom recall rising at smaller `B` — is the real signal, not the asymptote. A stronger test needs atom-level relevance labels (out of scope; noted in the writeup).

**Confound C2 (atom title content):** unlike Stage 3's inert `daily log <date>` title, an atom's title is real topic text and enters FTS. That is intended (the topic title is legitimate signal for that atom), but it means the day-vault and atom-vault index different title tokens. Keep the day-vault as the as-measured Stage 3 baseline; do not retro-fit day titles. Note that the comparison is "whole-day docs vs atom docs," each indexed naturally — which is the real deployment question.

### 4. Stage A → B gate
- **Proceed to Stage B** if `atomRecall(B)` ≥ `dayRecall(B)` by ≥ ~5pp at the budget matching Stage 3's top-10-days context size, **and** atom-retrieval reaches a given recall at a smaller `B` (curve dominance, not a single point). Then build per-topic entity tags (heuristic slug from the `###` title's leading entity) and test the discriminating-tag coverage half — separate design.
- **Kill / stop** if atom-retrieval does not beat day-retrieval at matched budget. Granularity is not the bottleneck; the ranker is. Write up the negative; do not build the tagging scheme.

### 5. Deliverable (Experiment-and-Publish)
`docs/superpowers/results/2026-06-23-atomization-granularity-measurement.md`: the two-curve recall@budget result (multi-day, with realized counts), the gate decision with numbers, confound C1/C2 stated plainly, and the verdict on **ranking vs atomization** + whether SP-C is worth building. Harness committed under `integrations/recall-bench/`.

## Risks / open items
- **Ephemeral inputs.** RB corpus (`/tmp/recall-review/...memories-180d`) and the Stage 3 day-vault (`/tmp/cov-recall/vault`) are in `/tmp`; the scripts must fail loudly if absent (re-clone `Stevenic/recall`; re-run `prep-vault.mjs`).
- **Char-as-token proxy.** Using `content.length` (chars) as the budget unit is a proxy; it is applied identically to both vaults, so the *comparison* is fair even if absolute token counts differ. State the proxy in the writeup.
- **Atom boundary edge cases.** Content before the first `###` (e.g. a `# session:` line, or preamble) must be attached to the following atom or its own atom — don't drop it. Whitespace-only atoms skipped. Assert no day loses content vs its original file (sum of atom bodies ≈ original body).
- **Vector half availability.** If embeddings fail to load (`vectorUsed=false`), ranking degrades to lexical-only for *both* vaults — still a valid comparison, but record it; do not mix a vector run with a lexical run across the two vaults.
- **Atom-vault size.** ~1,800 docs reindexed with MiniLM embeddings — a one-time prep cost (seconds–minutes), acceptable.
