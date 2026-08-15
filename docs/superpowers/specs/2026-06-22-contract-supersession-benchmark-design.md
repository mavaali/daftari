# Contract-supersession benchmark — the corpus where minting fabricates (Design)

**Date:** 2026-06-22
**Status:** Design — pending spec review + user approval, then writing-plans
**Author:** brainstorming session (Claude + Mihir)

---

## Context

Every daftari memory-eval so far has run on Recall Bench (RB), and RB turned out to
be **the wrong scoreboard**: its supersession is intra-document (one daily restates
both the old and new value), n=2 tagged corrections, and — decisively — it is
**100% recency-resolvable** (latest mention always wins). ContextForge beats daftari
on RB with a free deterministic regex wiki *because* recency-extraction is a valid
resolution function there. That killed SP2-as-ranking and pushed the thesis to a
product framing ([[project_recall_bench_experiment]], [[project_currentstate_projection]]).

The open question the whole thread converged on: **daftari's bet pays off only where
minting fabricates** — a corpus that is *not* cleanly recency-resolvable, where a
deterministic wiki extracts the *wrong* value and a synthesized one *hallucinates*.
That regime is untested. No such corpus has been run.

This spec defines the first run of that corpus.

### The regime, stated formally

A corpus is in daftari's regime when **recency is not a valid resolution function**:
the correct current value of a query is *not* `argmax-by-timestamp` over mentions.
Contract sets (master agreement + amendments + side letters) satisfy this by
construction:

- **Scoped supersession** — an amendment updates §4 only; the latest amendment touches
  §7, leaving §4's current value in an *earlier* document. The latest-dated document
  does **not** carry the current value for most clauses. A recency extractor reads the
  newest doc and is confidently wrong.
- **Inter-document, explicit, labelable** — the amendment *cites the clause it amends*
  ("Section 4.2 is hereby amended to read…"), so per-clause supersession ground truth
  is bounded and recoverable, not a judgment call.

This is exactly the premise SP2 was **killed** for lacking on RB (current and stale
values in *separate* documents). Contracts are the corpus SP2's mechanism actually
requires. So this is not a new gamble bolted on — it is the missing test surface for
a mechanism daftari already reasoned through and shelved for want of the right corpus.

### What daftari already ships for this

- `[DATA]` **`resolveCurrentSource`** (`src/search/current-source.ts:28`, SP-A,
  shipped) follows a document's `superseded_by` chain to the current source. This is
  daftari's "foreground the current source, never mint a value" mechanism *in code*.
  It has **never been measured on a corpus where the chain endpoint differs from the
  latest document** — RB couldn't provide one. This benchmark is its first real test.
- `[DATA]` **`applyCoveragePass`** (`src/search/coverage.ts:147`, Stage 1, shipped) —
  the recall half; relevant if a clause-current question needs sibling-doc coverage.
- `[DATA]` **`hybrid.ts` supersession *scoring* flag does NOT exist.** Only the
  `superseded_by` annotation is carried (`src/search/hybrid.ts:231`); the SP2 scoring
  change was never implemented. **This benchmark does not require it** — clause-current
  resolution is a *chain-follow* (`resolveCurrentSource`), not a re-rank. Whether
  ranking-level downweight adds anything is a later, gated question, not a precondition.

## Goal

Measure, on real contract amendment chains, whether **edge-resolution (daftari) beats
recency-extraction (the CF-style deterministic wiki) and LLM-synthesis on
scoped-current clause queries**, and whether daftari's never-mint design produces
**near-zero fabrication** where the other two arms invent values.

Produce the first artifact that either validates daftari's regime claim or kills it —
the kill condition from the design thread, now operationalized.

## Non-goals

- Not a general legal-NLP contract-review system. We test *current-value resolution*,
  nothing else (no clause classification, no risk scoring).
- No claim of cross-system leaderboard parity with legal-LLM benchmarks. The
  contribution is the **within-corpus arm comparison** (recency-extract vs synth vs
  daftari), same posture as the RB ablation.
- Acquired (auto-detected) clause-supersession edges are **deferred** to CB4, gated on
  the oracle arm (CB3) winning. Mirrors the SP1→SP3 oracle-first decomposition.
- No `hybrid.ts` ranking change. If CB3 shows resolution wins, ranking downweight is a
  separate, later question.

## Corpus: Material Contracts Corpus (MCC)

`[DATA]` Stanford Law's **Material Contracts Corpus** — 1M+ SEC-filed contracts
(2000–2023), categorized by agreement type, party-linked, **amendment-status tagged**,
bulk-downloadable (`mcc.law.stanford.edu`, arXiv 2504.02864). It is the only public
source that supplies real **amendment chains** at scale. CUAD/MAUD are single-doc
clause-annotation sets — they give the clause layer but no supersession; usable only
as a clause-extraction sanity check, not the chain corpus.

### Contamination handling (binding)

`[DATA]` MCC contracts are public-company filings inside any model's pretraining. The
LLM-synthesis arm and the daftari answerer could "recall" a memorized value rather
than resolve it. Two mitigations, both required:

1. **Post-cutoff slice** — prefer chains whose amendments are 2022–2023 (latest MCC
   coverage), reducing memorization probability.
2. **Value perturbation** — for the *measured* clauses (caps, fees, dates, durations,
   governing-law jurisdiction), systematically substitute the numeric/entity value in
   both master and amendments with an internally-consistent fake. This forces every
   arm to *resolve from the documents*, not from priors — the only way the fabrication
   metric is honest. (Same contamination dodge flagged in [[project_daftari_paper]].)

Perturbation is a deterministic, seeded transform recorded alongside the corpus so the
ground truth is regenerable.

## Ground-truth construction (CB1 — the hard part, the durable artifact)

For ~20–50 amendment chains, build clause-current QAs in **three buckets + one probe**:

- **scoped-current** (the headline / discriminating bucket) — clause X's current value
  lives in a document that is **not** the latest in the chain (latest amendment amends
  a *different* clause). Recency-extraction is structurally wrong here; this is where
  daftari must win.
- **latest-current** (control) — clause X *was* amended by the latest document.
  Recency-extraction succeeds; **daftari must not lose**. Guards against daftari
  "winning" only by always returning something.
- **unamended** (control) — clause X never amended; value in the master. Trivial; both
  arms should pass; a daftari miss here is a retrieval-recall bug, not a supersession
  finding.
- **no-value probe** (fabrication test, the (c)-case) — ask for a clause/term that does
  **not exist** in the chain. Correct behavior = "not present / cannot determine."
  Measures whether an arm *mints* a value. This is the "synthesized value hallucinates"
  measurement.

Labeling is bounded because amendments cite the clauses they modify: a deterministic
parser of amendment preambles ("Section N is hereby amended/deleted/replaced…") plus
human spot-check produces the (clause → governing-document → current-value) map. A
human-readable pair dump is emitted for review (same discipline as the SP2
oracle-builder dump).

## Arms

| Arm | Mechanism | The failure it embodies |
|---|---|---|
| **A. Recency-extraction** | Deterministic: for clause X, return the value from the **most-recent document that mentions X**. Zero LLM. The CF `wiki.py` analog. | "Deterministic wiki extracts the wrong value" (scoped-current) |
| **B. LLM-synthesis** | Feed retrieved docs to an LLM, ask it to state clause X's current value as a single answer. | "Synthesized value hallucinates" (no-value probe; scoped-current confabulation) |
| **C. Daftari (oracle edges)** | Ingest master+amendments; build **clause-scoped `superseded_by` edges** from amendment citations; answer via `resolveCurrentSource` chain-follow + retrieval. Points to the governing source; never mints. | The thesis under test |

Arm A is the **strong** recency baseline (most-recent-*mentioning*, not most-recent
overall) — beating a weak baseline would prove nothing.

## Architecture (reuse the recall-bench harness)

`[DATA]` Reuse `integrations/recall-bench/` (adapter, `corpus-map`, `reindexVault`
path, local MiniLM, confound guards, oracle-builder/classifier/runner pattern). New
modules, same shapes:

```
MCC chains ─► perturb (seeded) ─► corpus-build ─┬─► memories/<chain>/{master,amend-*}.md
                                                │
amendment-citation parse ─► clause-edge oracle ─┤  (clause → governing doc → value, + superseded_by edges)
                                                │
qa-build ─► {scoped-current | latest-current | unamended | no-value} buckets
                                                ▼
   per QA:  Arm A recency-extract  │  Arm B synth(LLM)  │  Arm C resolveCurrentSource
                                                ▼
                          metric report (per-bucket accuracy + fabrication rate)
```

- **Daftari arm answering** is a **chain-follow**, not a re-rank: retrieve candidate
  docs for clause X, then `resolveCurrentSource` to the chain endpoint, return that
  doc's value. No `hybrid.ts` change. (If retrieval misses the governing doc entirely,
  that's a coverage failure → `applyCoveragePass` is the lever, recorded separately.)
- **Edges are oracle** in CB3 (from amendment citations, trust=1), exactly the SP2
  oracle posture: the *resolution code under test is what ships*; only the edge source
  is ground-truth rather than acquired.
- Confound guards carried over: assert `vectorEnabled` after reindex; temp vault under
  `os.tmpdir()`; MiniLM CI-load flake re-check before trusting a red.

## Metrics

- **Primary — scoped-current accuracy** (exact perturbed-value match), per arm.
  Thesis: C ≫ A on this bucket (A is structurally incapable; B confabulates).
- **Fabrication rate — no-value probe**: fraction of queries where the arm returns a
  concrete value instead of "not present." Thesis: C ≈ 0; B > 0; A returns nearest
  on-topic value (also a fabrication of sorts — record it).
- **Controls — latest-current & unamended accuracy**: C must be ≥ A (no regression on
  the easy cases). A daftari loss here is a retrieval bug, isolated from the thesis.
- Report bucket sizes; perturbation seed; edge-resolution spot-check pass rate.

## Win / kill conditions

- **WIN** — C materially beats A on **scoped-current** *and* C's fabrication rate on
  the **no-value probe** is near-zero where B fabricates. This is the first evidence
  daftari has a niche RB could never show.
- **KILL** — if A matches C on scoped-current (i.e. scoped supersession turns out
  *also* recency-resolvable once you key extraction on clause sections), the regime
  collapses and daftari has no niche even here. **This is the load-bearing falsifier
  from the design thread.** Run A and C first, cheaply, before B — if A already ties C,
  stop; the LLM-synthesis arm and CB4 are moot.
- **Partial** — C beats A on scoped-current but only with oracle edges, and CB4 later
  shows clause-supersession can't be acquired unaided → daftari's niche is real but
  gated on a curation cost; that cost becomes the honest headline.

## Decomposition (sub-projects, each spec→plan→impl)

- **CB1** — corpus construction + perturbation + ground-truth labeling (the data
  artifact; outlives the experiment).
- **CB2** — Arm A (recency-extract) + Arm B (LLM-synth) foils.
- **CB3** — Arm C (daftari oracle edges + `resolveCurrentSource` answering). **The
  cheap falsifier — build A and C first.**
- **CB4** — *(deferred, gated on CB3 win)* acquired clause-supersession edges via the
  cortex loop / SP3 detector. Answers "can daftari acquire this unaided."
- **CB5** — synthesis + writeup; feeds the §6.1 contribution in [[project_daftari_paper]].

## Testing (mirrors `src/`)

- `corpus-build` + `perturb` units — hermetic, no model/network; assert
  internally-consistent perturbation and regenerability from seed.
- `clause-edge oracle` unit — on a small synthetic chain: amendment cites §4 ⇒ §4
  governing doc = that amendment, §7 governing doc = master; plus a deletion case.
- `qa-build` unit — bucket assignment correctness (scoped vs latest vs unamended vs
  no-value).
- Arm A unit — most-recent-mentioning resolution on a fixture; asserts it returns the
  *latest* value (i.e. the *wrong* one) on a scoped-current item (proving the arm is a
  faithful foil, not a strawman).
- Runner integration-gated (`reindexVault` loads MiniLM; re-check the CI flake).

## Risks / open questions

- **Edge-resolution accuracy is the main correctness risk** (parsing amendment
  citations to clauses). Mitigated by the human-readable pair dump + golden chains;
  tighten the parser before trusting the metric. `[HYPOTHESIS]` amendment preambles
  are formulaic enough ("Section N… is hereby amended") that a deterministic parser
  clears most cases; kill: if >20% of citations need hand-resolution, the labelability
  claim weakens and the corpus is more expensive than advertised.
- **Chain selection bias** — hand-picking chains with juicy scoped-supersession could
  inflate C. Mitigate: sample chains by amendment-count strata from MCC, report the
  scoped-current bucket's natural frequency (how often does latest≠governing actually
  happen in the wild — itself a finding worth publishing).
- **Arm B prompt sensitivity** — synthesis quality depends on the prompt/model;
  fabrication rate is the robust signal (a "I cannot determine" instruction in the
  prompt is the *charitable* baseline — if B still fabricates *with* that instruction,
  the finding is strong).
- **Contamination residue** — perturbation handles measured clauses; structural
  memorization of contract *form* is fine (we measure values, not form).

## Definition of done

- CB1 corpus: N≥20 perturbed MCC chains with the four QA buckets, regenerable from
  seed, pair dump spot-checked.
- CB2+CB3: Arm A, B, C runners produce a per-bucket report (scoped-current accuracy,
  fabrication rate, control accuracies, bucket sizes).
- Result interpreted against the **kill condition** explicitly: a one-line verdict —
  regime confirmed (C≫A on scoped-current, C fabrication≈0) or regime collapsed
  (A≈C) — with the numbers, not a hedge.
- A short results note in `docs/superpowers/results/`, cross-system caveat stated,
  feeding [[project_recall_bench_experiment]] / [[project_currentstate_projection]].
