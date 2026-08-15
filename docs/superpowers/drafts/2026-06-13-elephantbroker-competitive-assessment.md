# ElephantBroker — independent assessment + source verification

**Date:** 2026-06-13. **Author stance:** builder-experimenter; written to
need no further qualification on what was *verified*, and to mark explicitly
what remains *open*. Claims labeled [DATA] (read this session), [TRAINING]
(model knowledge), [HYPOTHESIS] (inference, kill condition stated).

> **One-line:** ElephantBroker is a real, ~30k-LOC autonomous cognitive-memory
> runtime that has *built* the consolidation machinery Daftari only specced —
> **including evidence-graded trust wired end-to-end into its live scorer**
> (an earlier draft of this doc wrongly called that part stubbed; retracted in
> §3). Its trust model is *attestation-graded* (trust by who attested), a
> different epistemic from Daftari's *re-derivation* trust. **That fork — not a
> missing verification step — is the real difference.** Irreversibility /
> accumulation-pole foil, not a refutation.

---

## 1. What it is

[DATA] `elephant.broker` is a placeholder landing page ("Persistent Memory for
AI Agents"). The substance is the GitHub org `elephant-broker` — repo
`elephant-broker/elephant-broker`, **Python, AGPL-3.0, 3 stars**, last pushed
2026-04-30, single visible author `alexandru_lupascu` (Romania, +0300), plus a
1-star `research` repo.

[DATA] It self-describes as "a unified cognitive runtime that gives AI agents
durable memory, goal-aware context assembly, evidence-backed verification, and
cheap-first safety enforcement." Four layers:

- **A** — TypeScript OpenClaw plugins (pass-through HTTP adapters)
- **B** — Python runtime (FastAPI :8420, ~84 endpoints)
- **C** — knowledge plane via **Cognee SDK** (graph + vector)
- **D** — infra: **Neo4j 5 + Qdrant + Redis + SQLite**, LiteLLM (gemini-2.5-pro
  default), `openai/text-embedding-3-large`, `Qwen3-Reranker-4B`,
  Prometheus/OTel/Grafana

Memory model: 5 classes (EPISODIC / SEMANTIC / PROCEDURAL / POLICY /
WORKING_MEMORY) × 8 scopes (GLOBAL→ARTIFACT), 7 graph DataPoint subclasses,
12 fact types. Retrieval = 5 concurrent sources (structural / keyword / semantic
/ ego-net / artifact) → 4-stage rerank → 11-dimension scorer. Plus a 6-layer
"red-line" guard pipeline and 3-level org/team/session isolation.

## 2. Source verification — did the code match the README?

The prior worry (kill condition for the whole assessment): README-driven
development, i.e. a polished spec with stubs underneath. **Cloned and checked.
Kill condition did not trigger.**

| Claim | Verdict at source |
|---|---|
| Substantial system | [DATA] ~30k LOC Python, coherent package layout, real API surface |
| "2,405 unit tests" | [DATA] **understated** — 3,214 `def test_` across 290 files |
| 9-stage "sleep" pipeline | [DATA] **real** — all 9 stages are non-stub files under `runtime/consolidation/stages/` |
| decay / strengthen formulas | [DATA] **real, richer than README** — config-driven; decay has 3 categories + scope multipliers + exponential half-life (`decay.py`) |
| EPISODIC→SEMANTIC after 3+ sessions | [DATA] **real** — 2-D (class×scope) decision matrix, `GLOBAL`-never-auto-promote rail (`promote.py`) |
| 4-state evidence machine | [DATA] **real** — UNVERIFIED→SELF/TOOL/SUPERVISOR, terminal REJECTED with audit-trail protection (`evidence/engine.py`) |

[DATA] Hand-written, not generated: in-code references to a real issue tracker
(`#1186`, `TF-FN-019`, `AD-12/13`, "Fix A/Fix B"), and a genuine reconstruction
bug at `strengthen.py:63`.

**Not verified (honest gaps):** the "(1−1/e) submodularity guarantee" and the
11-dimension scorer math were not line-checked; `.git-crypt` encrypts a slice of
the repo; git history was shallow-cloned so iteration depth is inferred from
in-code issue refs, not the log.

## 3. The trust coupling — corrected after a source check

[DATA] EB's confidence multipliers keyed to verification state are **wired
end-to-end in the live scorer**, not stubbed. Chain: `evidence/engine.py` state
machine → `ClaimDataPoint.status` on a `SUPPORTS` edge →
`working_set/manager.py:422` `_query_verification_index()` (real Cypher) →
`working_set/scoring.py:108` `compute_confidence` → `min(1.0, confidence ×
multiplier)` as one of the 11 scoring dimensions. Multipliers (`config.py:217`):
supervisor 1.0 / tool 0.9 / self 0.7 / unverified 0.5 / **no_claim 0.8**.

**Retraction.** My first-pass [HYPOTHESIS] — "EB asserts evidence-graded trust
more cleanly than it implements it" — was **wrong for the scorer path**, and the
kill condition I set is **triggered**. The only residual gap is narrow and real:
the *promotion-to-GLOBAL* decision (`promote.py:75`) proxies supervisor-verified
via `confidence >= 1.0` instead of reading claim status — even though the Cypher
that would read it exists elsewhere. Scoring reads evidence state; promotion
proxies it. A local inconsistency, not a missing trust model.

**What actually survives — a cleaner fork.** EB's model is **attestation-graded
trust**: trust = confidence × *authority of who attested* (self/tool/supervisor),
accumulated via strengthen/decay over usage. Daftari's thesis (Exp #1) is
**re-derivation trust**: `strength = survived independent re-derivations against
the premise`, independent of who attested. Different epistemics — not "verified
vs unverified" but "trusted because attested/used" vs "trusted because it
re-derives under challenge."

> **Earlier draft note.** A previous version of §3 cited the
> `no_claim (0.8) > self_supported (0.7)` ordering as a "tell" of the
> attestation worldview. Retracted on a closer read: with five hand-tuned
> multipliers and no calibration procedure, reading worldview into the
> specific ordering is mining noise. What reveals the worldview is the
> *architecture* — that there's a ladder keyed to who-attested at all —
> not the values in it.

**The structural argument (the real one).** Accumulation/attestation models
*have nowhere to source their constants from*. The five multipliers, the decay
`0.9` / `0.95`, the strengthen boost factor — all are static config with no
internal signal to improve them. You could fit them on a downstream task, but
the fit is task-specific and brittle, and the model has no held-out ground truth
against which "is 0.7 right for self-attestation?" is even a well-posed
question. They are *weights in an output composition*, not parameters of any
procedure.

Re-derivation knobs (K independent re-derivations, judge threshold, premise
variation, what counts as survived) are a different shape. They are countable
procedural parameters mapping onto real methodological tradition — replication,
cross-validation, jury models, consensus rules — with defaults derivable from
pilot calibration, ROC analysis, or methodological convention. Crucially,
*you can do science on them*: K=5 vs K=7 has an empirical answer, the judge
threshold has an ROC curve, and every protocol run produces data about the
protocol itself. Tuning them is meta-learning over a coherent procedure.
Exp #1 is literally an instance of that — the protocol evaluated as a
discriminator and shown to work.

That is the **learning/relearning paradigm fit**. Re-derivation is not a static
scoring formula; it is a process whose parameters are themselves objects of
inquiry, and whose outputs are checkable against ground truth. Accumulation's
multipliers do not compose into a learnable protocol — they are terminal weights
in a pipeline with no internal signal to improve them.

*Honest guard.* The line blurs at the edges — picking `K=5` by convention is
also somewhat arbitrary. The argument is not "we have no knobs"; it is that the
*shape* of the knobs — countable, procedural, calibratable, with a methodological
pedigree, producing data on themselves — is structurally different from
output-space weights, and that difference is what makes one paradigm a
learning/relearning loop and the other a static composition.

Exp #1 (`2026-06-13-exp1-results.md`) showed re-derivation does **not** reduce
to accumulation. **EB is the concrete running instance of the accumulation /
attestation pole** the experiments discriminate against — a sharper, more honest
foil than "they hand-wave verification." The claim changes from *"they didn't
build it"* to *"they built a different trust law — one whose constants have
nowhere to come from but taste."*

## 4. Two axes of genuine difference

[HYPOTHESIS] Not nostalgia — these are real design forks:

1. **Source of truth.** Daftari: human-legible markdown + YAML, git-diffable,
   advisory curation, every write auto-commits. EB: opaque graph-vector store,
   automatic consolidation, trust-the-machinery. → the **comprehension-load vs
   irreversibility** axis (the planned §6.1 ablation), with EB as a live
   irreversibility-pole comparator.
2. **Trust semantics.** Daftari: trust = *survived re-derivation* (information).
   EB: trust = *accumulated successful use* (priors/usage). Exp #1 is the
   discriminator between these; EB embodies the arm it loses.

## 5. Implications

**Endorsed (paper strategy).** The two-paper fork in
`project_daftari_paper` collapses. A "systems-now" novelty paper is no longer
defensible against EB on the same ground — EB is more complete and more
rigorously engineered as a *system*. **Go empirical.** The contribution is the
ablation + the trust discriminator, with EB cited as the named
irreversibility/accumulation-pole comparator. This *strengthens* the empirical
paper: "here is the mechanism the field is converging on (sleep, promotion,
evidence states) **and** here is the experiment showing which design choice
actually carries weight — and where the leading implementation hand-waves it."

**OPEN — not decided (do not bake into the build yet).** Whether EB's existence
means *scope the consolidation loop down to minimum-viable-for-experiments*.
The argument *for*: the loop's value is no longer "prove it's buildable" (EB
did), so build only what the experiments need. The argument *against* (why this
is not settled): the comprehension-load-favorable consolidation — legible,
advisory, git-native — is its own design space EB never explored; a *minimal*
loop may underbuild the very thing that differentiates, and Daftari-as-substrate
may have value independent of the paper. **This needs its own brainstorm before
it changes the build plan.** Stated here unhedged as an open question, per the
"write to validate" tenet — it is not ready to be a decision.

## 6. Honest Assessment (adversarial pass)

- **Adoption threat today ≈ zero.** 3 stars, one author, AGPL. The threat is to
  *novelty and framing*, not market. Don't over-rotate.
- **AGPL-3.0** means cite-and-learn freely, but **no code reuse** without
  copyleft contamination.
- **The convergence is the real signal.** An independent builder reached the
  same primitives Daftari specced — "sleep," 3+-session promotion, decay,
  evidence states. That validates the *direction* and removes "is this novel
  machinery" as a defensible claim. What survives as defensible is the
  *empirical* question of which design choice wins — which is exactly the work
  already in flight.
- **Counter to my own read — now realized.** The §3 kill condition triggered:
  EB's verification→trust coupling is fully wired in the scorer, so the "they
  hand-wave the cognitive claim" wedge is **retracted**. What survives is
  narrower but cleaner — *attestation-graded* (EB) vs *re-derivation* (Daftari)
  trust, plus substrate legibility. Lean on that fork in any write-up, not on a
  missing-verification claim. (Process note: this is the second pass catching a
  first-pass error — the source check earned its keep.)

## 7. Provenance

[DATA] from this session: WebFetch of `elephant.broker` + `github.com/elephant-broker`;
`git clone --depth 1` of `elephant-broker/elephant-broker`; Read of
`runtime/consolidation/stages/{strengthen,decay,promote}.py` and
`runtime/evidence/engine.py`; counts via `grep`/`git log`. Cross-referenced with
`2026-06-13-exp1-results.md` and memory `project_daftari_paper`,
`project_cortex_consolidation_loop`, `project_offline_curation_passes_framing`.
