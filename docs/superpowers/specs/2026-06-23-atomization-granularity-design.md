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
Split each of the 180 RB day-files at `###` headers into per-topic atoms. **Verified structure (corrected):** `# session:` blocks containing `### Topic` subheaders, **3–37 per day**, **~2,980 atoms total** across the 180 days; `####` sub-subsections exist in 3 files (day-0168/0169/0171) and **must stay inside their parent `###` atom** — do NOT add `####` to the split delimiters. Atom boundaries are exactly the lines matching `/^(# |### )/m`: a `# ` line starts a **session** (its name becomes the context prefix for following atoms, but is not itself an atom), a `### ` line starts an **atom**; `## ` and `#### ` lines match neither and fall inside the current atom. Each atom is a daftari doc written to a scratch atom-vault:
- **Body** = the `### ` block (its title line + content up to the next `# ` or `### ` boundary), with the current `# session:` name prepended as a one-line context prefix.
- **`title`** = the `###` topic text (inert w.r.t. questions in the same way Stage 3's title was — but here the topic text is real content; see confound C2). `created` = the day's date (`day-N → 2026-01-01 + (N−1)`, reusing the Stage 3 mapping). `tags: [daily]` (uniform — Stage A). Other required frontmatter = valid defaults.
- **Path** = `notes/day-NNNN-aKK.md` (KK = atom index within the day) so the **day number is recoverable** from the path for scoring.
Then `reindexVault(atomVault)`. The Stage 3 day-vault (`/tmp/cov-recall/vault`) is the comparison baseline (re-run `prep-vault.mjs` if gone).

Assertions: every atom maps to a valid day in `[1,180]`; total atom count logged; each day contributes ≥1 atom.

### 2. Two-vault retrieval + token-budget recall curves — `integrations/recall-bench/granularity-runner.mjs`
For each of the 1,489 questions, retrieve by relevance (`hybridSearch`) over **each vault**. **Pin each vault's retrieval `limit` to its document count** (180 for days, ~2,980 for atoms) so budget-fill is never truncated by retrieval depth. Then **fill a context budget `B`** (in characters — a token proxy, **same unit for both vaults** so the comparison is fair): walk retrieved units in rank order, accumulating each unit's **on-disk body length**, until the next unit would exceed `B`; the filled set is everything admitted. Map filled units → their day numbers.

**CRITICAL — where the char length comes from.** The `hybridSearch` hit object carries only `path / title / score / snippet` — there is **no `content` field**, and `snippet` is a truncated excerpt. Using `snippet.length` would make day-docs and atom-docs ~equal cost and **silently destroy the measurement**. Get the true body length from the index: `getDocument(db, hit.path).content.length` (the indexed body, frontmatter already stripped). Same source for both vaults.

`recall@B = |relevantDays ∩ days(filled)| / |relevantDays|`. **Sweep `B`** across a range that brackets realistic context sizes (from a few thousand chars up to ~the size of Stage 3's top-10 days, ≈110k chars). Output two curves: `dayRecall(B)` and `atomRecall(B)`, aggregated over **multi-day** questions (single-day split reported but not the focus). Stage 3's day-level number is one point on `dayRecall`.

**Secondary lexical-only arm.** Run the whole sweep a second time with `weights: { bm25: 1, vector: 0 }`. This isolates the **BM25-granularity** effect from the **embedding-granularity** effect (short atoms embed more cleanly than long days — confound C3). Reporting hybrid AND lexical-only tells us whether atomization helps lexically, semantically, or both — which is exactly what the ranking-vs-granularity adjudication needs.

Determinism + parity: pin the embedding provider; assert `vectorUsed` is identical across all hybrid retrievals and both vaults. Report realized filled-unit counts and realized char totals per arm at each `B` (the budget is a ceiling, not an exact fill).

### 3. Metric meaning + the one honest confound
If `atomRecall(B)` dominates `dayRecall(B)` — more relevant days recovered at equal-or-smaller `B` — granularity is the lever.

**Confound C1 (day-level truth):** ground truth is day-level, so day-coverage cannot verify the retrieved atom is the *topically-relevant* one — atom-retrieval could "cover" a relevant day via its *wrong* atom. **Partial mitigation:** the token-budget shape helps — reaching relevant days at a *small* budget requires the *right* atom to rank high, since a whole noisy day costs far more budget. But it does not *eliminate* the issue: a day has 3–37 atoms, some sharing entity tokens, so a wrong atom of a relevant day can still "cover" it by luck. So read the *small-budget shape* as the signal, **never the asymptote as truth**. A clean test needs atom-level relevance labels — out of scope; stated as a limitation in the writeup, not papered over.

**Confound C2 (atom title content):** unlike Stage 3's inert `daily log <date>` title, an atom's title is real topic text and enters FTS. That is intended (the topic title is legitimate signal for that atom), but the day-vault and atom-vault index different title tokens. Keep the day-vault as the as-measured Stage 3 baseline; do not retro-fit day titles. The comparison is "whole-day docs vs atom docs, each indexed naturally" — which is the real deployment question.

**Confound C3 (embedding quality shifts with length):** a ~1.5k-char atom embeds as 1–few topic-focused chunks; an ~11k-char day pools many chunks and embeds more diffusely. So the vector half behaves *qualitatively* differently between arms — atoms get cleaner embeddings. This is **arguably part of the treatment** (it is *why* atomization may help), not a nuisance, but a positive hybrid result conflates "shorter docs rank their topic higher in BM25" with "shorter docs embed better." The **lexical-only secondary arm (§2)** isolates the BM25 contribution so the writeup can attribute the effect.

**Confound C4 (session-prefix token injection):** the prepended `# session:` name (`principal`, `board-prep`, `family`, …) is low-entropy and repeats across all ~2,980 atoms, with no analogue in the day-vault. Low risk (uniform-ish), but it is a non-inert injection. Justification: the session label is genuine document context an agent would see; if a positive result is marginal, re-run a no-prefix sensitivity cut to confirm the prefix isn't carrying it.

### 4. Stage A → B gate
- **Proceed to Stage B** if `atomRecall(B)` ≥ `dayRecall(B)` by ≥ ~5pp at the budget matching Stage 3's top-10-days context size (≈110k chars), **and** the atom arm reaches the **day arm's max-budget (asymptotic) recall at a strictly smaller `B`** (the quantified "curve dominance" check). Hybrid arm is the primary; the lexical-only arm tells us *why*. Then build per-topic entity tags (heuristic slug from the `###` title's leading entity) and test the discriminating-tag coverage half — separate design.
- **Kill / stop** if atom-retrieval does not beat day-retrieval at matched budget. Granularity is not the bottleneck; the ranker is. Write up the negative; do not build the tagging scheme.

### 5. Deliverable (Experiment-and-Publish)
`docs/superpowers/results/2026-06-23-atomization-granularity-measurement.md`: the two-curve recall@budget result (multi-day, with realized counts), the gate decision with numbers, confound C1/C2 stated plainly, and the verdict on **ranking vs atomization** + whether SP-C is worth building. Harness committed under `integrations/recall-bench/`.

## Risks / open items
- **Ephemeral inputs.** RB corpus (`/tmp/recall-review/...memories-180d`) and the Stage 3 day-vault (`/tmp/cov-recall/vault`) are in `/tmp`; the scripts must fail loudly if absent (re-clone `Stevenic/recall`; re-run `prep-vault.mjs`).
- **Char-as-token proxy.** Using `content.length` (chars) as the budget unit is a proxy; it is applied identically to both vaults, so the *comparison* is fair even if absolute token counts differ. State the proxy in the writeup.
- **Atom boundary edge cases.** Content before the first `###` (e.g. a `# session:` line, or preamble) must be attached to the following atom or its own atom — don't drop it. Whitespace-only atoms skipped. Assert no day loses content vs its original file (sum of atom bodies ≈ original body).
- **Vector half availability.** If embeddings fail to load (`vectorUsed=false`), ranking degrades to lexical-only for *both* vaults — still a valid comparison, but record it; do not mix a vector run with a lexical run across the two vaults.
- **Atom-vault size.** ~2,980 docs reindexed with MiniLM embeddings — a one-time prep cost (under a few minutes), acceptable.
- **Content conservation.** Assert per day that the concatenated atom bodies cover the original body (modulo the session-prefix + whitespace) so atomization drops no content; this is the backstop that catches a broken split rule.
