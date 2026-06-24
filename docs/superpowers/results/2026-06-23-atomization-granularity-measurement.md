# Results — Atomization granularity measurement (Stage A)

**Date:** 2026-06-23
**Spec:** `docs/superpowers/specs/2026-06-23-atomization-granularity-design.md`
**Harness:** `integrations/recall-bench/{atomize-vault,granularity-runner}.mjs`
**Verdict:** **Granularity helps retrieval — modestly (+6–18pp), lexically-driven, and the lever is chunk-level BM25 (lossless), not header-atomization.** The headline "6×" from the char-budget metric was a full-doc-feeding artifact; the deployment-grounded top-K comparison gives the honest number.

## What was tested

Stage 3 (coverage) showed daftari's whole-day retrieval recall on RB multi-day questions is ~0.22, and the date-window mechanism made it *worse*. Stage A tests the competing hypothesis: is the bottleneck **granularity** (whole multi-topic days dilute the relevant topic) or **the ranker**? We atomized the 180 RB day-files at `###` headers into **2,980 per-topic atoms** (a uniform-tagged probe — header-splitting is the *upper bound* on granularity, not a proposed product), indexed both an atom-vault and the Stage-3 day-vault, and compared recall of the true relevant days — for hybrid AND lexical-only ranking. `$0`, no LLM.

## The two metrics, and why they disagree

### Char-budget recall (the inflated upper bound)
Fill a fixed context budget by relevance, map filled docs → days. At 110k chars, multi-day (n=979):

| budget | day (hybrid) | atom (hybrid) | atom (lexical) |
|---|---|---|---|
| 16k | 0.015 | 0.253 | 0.267 |
| 110k | 0.123 | 0.730 | **0.791** |

Atom looks **6× better**. But a lift-over-chance check exposes the mechanism as **density, not targeting**: at 110k the day arm fits only **3.6 days** (whole days are huge) vs the atom arm's **57.7 days** — so the atom win is mostly "small units pack more into a fixed context," and the *full-doc-feeding assumption* is what inflates it. Per-unit, whole-day BM25 actually had *higher* lift over chance (6.2× vs 2.5×). So the char-budget number overstates the deployment effect.

### Recall@top-K (the deployment-grounded headline)
An agent calls `vault_search(query, limit=K)` and gets K hits — no full-doc-size penalty. This is the harshest test for atoms (their hits cluster into fewer distinct days). Multi-day, day-coverage:

| | K=10 | K=20 | K=50 |
|---|---|---|---|
| DAY hybrid | 0.221 | 0.359 | 0.627 |
| ATOM hybrid | 0.286 | 0.430 | 0.683 |
| DAY lexical | 0.181 | 0.281 | 0.528 |
| ATOM lexical | **0.286** | **0.418** | **0.711** |

**Atom still wins, by +6.5pp at K=10 up to +18pp at K=50 (lexical).** This survives the confound: at top-10 the day arm gets 10 *distinct* days and the atom arm ≤10 (clustered), yet atom recall is higher — the pure-signal atom ranks where the diluted day couldn't. Granularity genuinely improves retrieval, not just context-packing.

## Attribution: it's lexical, decisively

`ATOM lexical` (0.711 @K=50) is the **best** arm; `DAY lexical` (0.528) is the **worst**. Whole-document BM25 dilution — a multi-topic day's score spread across all its topics — is the bottleneck. The vector half *helps* whole days (per-chunk embeddings already rescue some dilution: DAY hybrid 0.627 > DAY lexical 0.528) but adds **nothing** to atoms (ATOM lexical 0.711 > ATOM hybrid 0.683). So the lever is **chunk-level lexical (BM25) scoring/return** — and it is **chunking-general**: since the win is unit *granularity*, not topic-perfect boundaries, any content-based chunking works; clean `###` structure is not required.

## The product implication

The lossless, markdown-general realization is **chunk-level BM25 in `hybrid.ts`** — daftari already does the vector half per-chunk (KNN over `embeddings_vec`, collapse to best-per-doc); mirror that for the lexical half (chunk-level FTS, collapse to best-per-doc) so a relevant topic isn't buried by its day's score dilution. This is a **ranker change, not an ingest pipeline** — the document stays whole on disk (no SP-C atomization, no source rewrite). It reconciles the long-running "ranking vs atomization" debate: same lever, and daftari's ethos takes the rank layer.

Expectation-setting: the honest gain is **+6–18pp recall** (growing with K), not 6×. Worth a prototype; not a silver bullet.

## Honest Assessment

- **What this shows:** sub-document granularity improves multi-day retrieval recall on RB by a real, modest margin that survives the deployment top-K framing, and the benefit is lexical (→ chunk-level BM25).
- **What it does NOT show:** (1) the 6× char-budget figure is *not* the deployment effect — it's a density artifact of feeding full doc bodies; report top-K as the number. (2) **Confound C1 (day-level truth)** stands: day-coverage can't verify the retrieved atom is the *topically*-relevant one; the top-K result bounds but doesn't eliminate this. (3) **Snippet caveat, partly resolved:** the top-K comparison is doc-size-independent, so the retrieval-recall advantage holds even though `vault_search` returns 140-char snippets — but whether feeding atom-snippets vs day-snippets changes *answer* quality is a separate, untested question. (4) RB only; header-atomization is the probe, not the product.
- **Kill-condition status:** the gate (atom dominates day at matched budget AND reaches the day asymptote at smaller budget) **PASSED** — but the honest magnitude is the top-K +6–18pp, not the char-budget 6×.

## What ships / what's next

- Harness (`atomize-vault.mjs`, `granularity-runner.mjs`) committed and reproducible. One harness bug fixed during the run: `###` titles with colons/specials broke YAML frontmatter → atoms silently skipped; titles are now JSON-quoted (2,980/2,980 indexed).
- **Next (separate spec/build):** a **chunk-level BM25 prototype in `hybrid.ts`**, measured the same way (recall@top-K, day-coverage, lexical) to confirm the +6–18pp transfers to a lossless ranker change on *whole* documents. This is the real follow-on the experiment motivates — not header-atomization, not tag-coverage.
