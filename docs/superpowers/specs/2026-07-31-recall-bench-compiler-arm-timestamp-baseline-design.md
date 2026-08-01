---
title: "Recall-bench compiler arm and timestamp baseline: making arm C real"
date: 2026-07-31
status: final
motivated_by: >
  Daftari's competitive thesis is compilation over retrieval, but the eval
  harness has never tested the compiler. Meanwhile a rival consolidation
  paper's single largest effect was +10pp from putting timestamps in the
  prompt — no architecture at all. Until we run a compiled arm against an
  honest timestamp control, our thesis is unfalsified and possibly hollow.
---

## The problem, precisely

Daftari's thesis has two halves. The write-time half: an authoring LLM
compiles each ingested day into a structured note — frontmatter, questions
answered and raised, links, supersede decisions against prior days. The
read-time half: the consolidation loop (`src/consolidate/index.ts`) builds
the `derives_from` edge graph and tension log, so `vault_search` can surface
related and contested structure at query time, preserving contradictions as
live tensions rather than resolving them.

[DATA] Neither half runs in the benchmark today. `integrations/recall-bench/
src/adapter.ts:125` — `ingestDay` does `mapDay(day, content, meta)` and
writes raw markdown to disk; `finalizeIngestion` calls `reindexVault` and
nothing else. What the team has been calling "arm C" is a dressed-up raw
baseline. The harness measures raw-vault retrieval quality over indexed
markdown, which is precisely the thing our thesis claims to beat.

[DATA] `vault_write` is a dumb writer: the caller supplies frontmatter and
body. The compiler is not `vault_write` — it is the authoring-LLM step in
front of it, the agent deciding what to write, what to supersede, what to
link. That step is entirely absent from bench ingestion.

[DATA] The consolidation loop never runs in the bench, so at query time the
edge graph and tension log are empty. `vault_search`'s related/contested
surfacing — the retrieval-time half of the compiler — is structurally inert
in every benchmark number we have ever produced.

The external pressure makes this urgent rather than merely embarrassing.
[TRAINING] Kesselman et al. reported that aggressive summarizing
consolidation collapsed accuracy from 78.4% to 48.4%, and that their single
largest positive effect was +10 points from merely including timestamps in
the prompt, with no memory architecture whatsoever. That result is a direct
threat to our thesis: it says a large fraction of what memory systems claim
as architectural lift is actually the calendar. If our compiled arm only
beats a timestamp-blind baseline, we have measured nothing. The control we
must beat is raw retrieval *with timestamps on* — and, as the counter-
critique to the first draft of this spec established, beating that control
is still not enough on its own, because the compiled arm consumes dates at
ingest that the raw arms never touch. The experiment must be able to tell
"the architecture works" apart from "the compiler is a better
timestamp-delivery vehicle." The four-arm design below exists for exactly
that reason.

## What already exists — do not rebuild

[DATA] Synthetic calibration exists: `src/eval/generate.ts` produces
multi-hop question sets (retrieval / cross_reference / contradiction tiers)
from the vault's own subgraph, leakage-free. The streaming
ingest→query→judge loop exists in the recall-bench adapter. Multi-arm foil
scaffolding exists in contract-bench with neutral OpenRouter models. This
spec adds configuration axes to the existing adapter. It does not add
runners, judges, or question generators.

## Design decision 1: arm C routes through the real write path

Non-negotiable. Arm C's ingestion must invoke the same authoring-LLM
synthesis a real user's agent performs — the actual prompt, the actual
supersede/link decision procedure, then `vault_write` — not a bench-local
reimplementation of "something compiler-shaped."

The risk this guards against deserves a name: **the strawman-compiler
risk**. A bench-local compiler written quickly for the harness would be
weaker than the production authoring step. It would compile worse notes,
make worse supersede decisions, and the eval would then "show" that
compilation buys nothing — a false negative manufactured by the harness
itself. Given that the whole point of this eval is to falsify or defend the
company thesis, a result produced by a strawman is worse than no result: it
is a confident wrong answer. [HYPOTHESIS] This failure mode is especially
likely under schedule pressure, because a bench-local compiler is the
path of least resistance — the adapter already owns the ingest loop and
"just synthesizing inline" is a one-file change. The spec therefore treats
any compile path that does not share code *and observed call behavior* with
the production authoring step as a build error, to be caught in review, not
tuned later.

**Two-layer anti-strawman check.** Import-graph sameness is necessary but
not sufficient: two callers can resolve to the same module while passing
different system prompts, model IDs, prior-day context windows, or
supersede-candidate sets — same function, different arguments, strawman
preserved while a build-time check passes. So:

1. **Build-time invariant:** the adapter imports the production authoring
   module; the bench compile path and the production authoring path must
   resolve to the same module in the import graph, asserted in CI.
2. **Runtime invariant:** on a fixed 3-day fixture, log the authoring
   module's actual call arguments — model ID, resolved system/user prompt,
   prior-day context supplied, supersede candidates considered — from the
   bench path and from a production-session trace of the same fixture, and
   diff them. The diff must be empty (modulo run-identifying metadata).
   This is a Phase 1 test, not an aspiration.

**Canonical-implementation selection.** If the authoring step today exists
only as agent-side prompt scaffolding with multiple variants and no single
importable module, then "extract, don't rewrite" is vacuous — a first
crystallization *is* a rewrite, and the strawman risk re-enters through the
extraction itself. The selection criterion is therefore fixed here: the
canonical variant is **the one currently running in production agent
sessions, verified by diffing the extracted module's fixture output against
a real production session log** over the same input. If more than one
variant runs in production, Phase 1 picks the highest-traffic one and
documents the choice in the results note, because that choice *is* the
strawman boundary. Production must consume the extracted module thereafter
so the two paths cannot drift.

## Design decision 2: two config axes, four arms, on the existing adapter

Arms are *configs* of one adapter, not separate runners. They reuse the
ingest loop, the MiniLM guards, the judge, and teardown. Two axes:

**`compile: "raw" | "write" | "write+consolidate"`**

- `raw` — today's behavior: `mapDay` → write raw markdown → reindex.
- `write` — `ingestDay` runs the real authoring LLM, which then calls
  `vault_write`; supersede is permitted against notes from prior days
  (never within-day, never future-day — the stream ordering is the
  contract).
- `write+consolidate` — as `write`, and `finalizeIngestion` additionally
  runs `consolidate --mode both` before any querying, so birth and
  revision populate the edge graph and tension log.

**`timestamps: "on" | "off"`**

When off, dates are stripped from what the *answerer* sees at query time —
retrieved note content, frontmatter, and any context assembly. Timestamps
remain always available to the *ingest* side: the compiler legitimately
uses dates to make supersede decisions, and stripping them there would
test a crippled compiler nobody ships.

That ingest-side asymmetry is precisely why the axes are **not orthogonal**
and why three arms were not enough. The compiled arms consume dates at
ingest *and* (when on) at query; the raw arms consume them only at query.
A three-arm C−B delta therefore conflates "the architecture helps" with
"compilation is a better timestamp-delivery mechanism." The fourth arm —
compiled vault, answerer-side dates off — is what lets the experiment see
the difference.

**Cost note.** Because the `timestamps` axis only affects answer-time
context assembly, arms sharing a `compile` setting share a vault: the raw
vault is built once and queried as A and B; the compiled vault is built
once (the expensive part — authoring calls plus consolidation fan-out) and
queried as C and D. The fourth arm costs queries and judging, not a second
compile.

## Design decision 3: consolidation must run in the compiled arms' finalize

[DATA] Without it, `vault_search` returns no related/contested structure —
the tension-surfacing half of the thesis contributes exactly nothing, and
the compiled arms degenerate into "raw plus nicer frontmatter."
`finalizeIngestion` for `compile: "write+consolidate"` runs `consolidate
--mode both` after the last day is ingested and before the first question
is asked.

Two gotchas, spec'd here so they are not discovered at 2am:

**`shadow_mode` inversion.** [DATA] Non-scan consolidate modes refuse to
run without an explicit `shadow_mode` in config, and default to
journal-only — meaning edges would be journaled but never land where
retrieval can see them. The bench must write `shadow_mode: false` into the
throwaway tmp-vault's config at setup. This is safe (the vault is an
ephemeral tmpdir destroyed at teardown) but it *inverts the production
default*, so the adapter must log a loud, explicit line when it does this,
and teardown must assert the tmpdir is gone. If that config write is ever
pointed at a non-ephemeral path, it silently converts a safety default
into live edge mutation — the setup code must refuse to set
`shadow_mode: false` unless the vault path is inside the bench's own
tmpdir.

**Spend cap.** [DATA] Birth fans out roughly 40 LLM calls per item (per
`consolidate --help`). A full corpus at that fan-out is a real bill.
`--max-llm-calls` is passed as a hard cap on all smoke runs, and the full
run's projected call count is computed and printed before execution, not
after.

## Eval design

Four arms:

- **Arm A** — `compile: raw`, `timestamps: off`. The naive floor.
- **Arm B** — `compile: raw`, `timestamps: on`. The honest calendar
  control. This arm embodies the rival result: everything the calendar
  buys the answerer, nothing the architecture buys.
- **Arm C** — `compile: write+consolidate`, `timestamps: on`. The full
  thesis stack.
- **Arm D** — `compile: write+consolidate`, `timestamps: off`. The
  compiled vault with answerer-side dates stripped. The compiler still
  used dates at ingest; the answerer never sees one. This is the arm that
  isolates the architectural claim from calendar delivery.

The deltas, and what each one means:

| Delta | Reads as |
|-------|----------|
| B − A | The timestamp effect on raw retrieval — replication of the rival's +10pp on our corpus. |
| C − B | Does the whole stack beat the honest calendar control. The headline number, but a composite. |
| C − D | The answerer-visible calendar effect *on the compiled vault*. Compare against B − A: if C − D ≫ B − A, compilation is amplifying calendar delivery. |
| D − A | The architecture effect with the calendar held off the answerer on both sides. The cleanest architectural read. |
| D − B | The stringent cross-test: architecture without answerer dates vs raw *with* them. Positive D − B means the architecture beats the calendar outright. |

Note the decomposition C − B = (D − B) + (C − D): the headline splits
exactly into an architecture-vs-calendar-control term and a
calendar-on-compiled-vault term. That is what makes the confound
inspectable rather than merely suspected.

Report bootstrapped 95% CIs, overall and per question tier —
[HYPOTHESIS] the contradiction tier is where tension-preservation should
show up if it shows up anywhere, and a lift concentrated there with a flat
retrieval tier is a more interesting result than a uniform lift.

**Bootstrap unit — resolved before any threshold is trusted.** Questions
generated from the same subgraph cluster are not independent; if 150
questions come from 20 subgraphs, the effective N is nearer 20 and a
question-level bootstrap understates CI width. [DATA] `src/eval/generate.ts`
derives questions from vault subgraphs, so cluster identity is available at
generation time. The resampling unit is therefore the **subgraph cluster**
(cluster bootstrap), and the power analysis below is run against that unit.
This is settled now, pre-registration, not "before Phase 3" — because the
kill threshold cannot be set honestly without knowing the effective N.

**Judge style-blindness — a validity prerequisite, not a nicety.**
[HYPOTHESIS] Compiled notes are frontmatter-structured, link-dense, and
answer-shaped; an LLM judge seeing different surface forms across arms may
score the compiled arms higher for reasons orthogonal to factual accuracy.
If the style prior is worth even +2pp, a +3.5pp C − B "pass" is a phantom.
The C − B metric is not valid without controlling this, so it is Phase 0
work: the judge scores answers against a **canonicalized context** —
retrieved context is paraphrase-normalized (structure flattened, prose
re-rendered by a neutral model) before the judge sees it, identically
across arms. Phase 0 additionally measures the style prior directly: judge
a fixed answer set with raw vs canonicalized context and report the delta.
If canonicalization itself proves lossy enough to distort judging, that is
a Phase 0 finding that must be resolved before Phase 3, not after.

**Corpus fork.** Path A: run A/B/C/D on the existing recall-bench corpus
first — fast, internal, uses the existing `src/eval/generate.ts` question
tiers. Path B: port LongMemEval sessions, questions, and its LLM judge for
a head-to-head external rebuttal of the +10pp result — built **only if**
Path A shows real lift. Path B before Path A would be spending external-
credibility effort on a thesis we have not yet checked internally.

## Pre-registered kill condition

Decided now, before any arm is built or run — but with one honest
dependency: the numeric threshold is only final after the Phase 0 power
analysis, which is itself pre-registered here in full.

**Power analysis first.** [DATA] A-arm accuracy numbers exist from prior
raw-baseline runs. Before the threshold is frozen, compute from that data
the expected cluster-bootstrap 95% CI width on a between-arm delta at
N=150 questions (at the observed subgraphs-per-corpus). If the expected CI
half-width exceeds 3.0pp, the design as stated cannot distinguish +3pp
from zero and the kill condition would be a coin flip dressed as rigor —
in that case, raise N (more generated questions / more subgraphs) until
half-width ≤ 3.0pp, rather than lowering the threshold. The threshold is a
cost floor (see below) and does not move to accommodate noise; N does.

**The kill condition, on the Path A corpus:**

The thesis survives only if **both** hold, with cluster-bootstrapped 95%
CIs:

1. **C − B ≥ +3.0pp** on overall accuracy, CI excluding zero. The full
   stack must beat the honest calendar control by more than the cost
   floor.
2. **D − A > 0**, CI excluding zero. The architecture must show up at all
   when the calendar is held off the answerer on both sides. If C − B
   passes but D − A does not, the verdict is pre-registered as
   **"calendar delivery, not architecture"** — the stack is a timestamp
   plumbing improvement, which is a publishable finding but is not the
   compilation thesis, and Path B is not built on it.

Why +3.0 and not zero: the compiled arm is not free. [DATA] Consolidation
alone is ~40 LLM calls per item, plus an authoring call per ingested day.
A statistically-nonzero-but-tiny lift would not justify that cost against
a control that costs nothing (timestamps are a prompt edit). Three points
is roughly a third of the rival's free timestamp effect — if the entire
architecture cannot buy a third of what a prompt edit buys, "compilation
over retrieval" is not a defensible competitive thesis. Why not higher:
Path A is a first internal read on a corpus generated from our own vault
structure; demanding parity with the full +10pp on the first pass would
kill a real-but-developing effect prematurely. The threshold is
deliberately a *conjunction* of magnitude and significance: a real +2.5pp
effect with a tight CI is killed *on cost grounds*, and that is the
intended reading, not a statistical artifact — the counter-critique's
worry about conflating the two failure modes is answered by naming them:
CI-includes-zero kills for "not demonstrated," sub-threshold-with-tight-CI
kills for "not worth it," and the results note must say which fired.

What the kill condition triggers is specific: no Path B, no external
rebuttal claims, and a written post-mortem separating "the thesis is
wrong" from "the authoring step is weak" (the two-layer strawman check in
Phase 1 is what licenses us to read a kill as the former rather than the
latter). What it does not trigger: deleting the compile axis — a falsified
thesis with a working harness is a research position; a falsified thesis
with no harness is a vibe.

**Escape hatches, symmetric and pre-registered:**

- If **B − A < +2pp** (we fail to reproduce the timestamp effect at all),
  the kill condition is suspended and the corpus's temporal structure is
  investigated before any conclusion is drawn in either direction.
- If **B − A > +12pp** (a timestamp effect larger than the rival's
  published +10pp), the kill condition is likewise suspended: the corpus
  may be pathologically timestamp-rich, in which case C − B underestimates
  the architecture against any realistic corpus, and killing the thesis on
  it would be as dishonest as passing it on a timestamp-poor one.

## Build plan

**Phase 0 — measurement validity (no compiler needed).** Everything the
metrics' honesty depends on, before any expensive arm exists:

- Add the `timestamps` axis to the adapter; strip structured dates
  (frontmatter, metadata, context-assembly headers) from the answerer's
  view. Test: golden-file diff of the answerer prompt with the axis on vs
  off — off contains no date tokens.
- **In-body date scrub.** Dates also leak through prose ("yesterday", ISO
  strings in bodies). Implement a regex/NER date-scrub pass over retrieved
  note content for the `timestamps: off` arms, and *measure* its cost: run
  arm A with structured-only stripping vs full scrub and report the delta.
  If in-body dates carry measurable signal, that is a finding about the
  timestamp effect itself, not a deferred detail.
- **Style-blind judging.** Implement the canonicalized-context judge path;
  measure the style prior (raw vs canonicalized context on a fixed answer
  set) as specified in the eval design.
- **Power analysis and bootstrap unit.** Extract subgraph-cluster IDs from
  question generation; compute expected cluster-bootstrap CI width from
  existing A-arm data; fix N accordingly and freeze the kill condition.
- Run A vs B on the existing corpus. Deliverable: the B − A number, the
  style-prior number, the scrub-delta number, and the frozen N. This phase
  is the cheapest result in the whole plan and stands alone even if
  everything after it slips.

**Phase 1 — real write path into `ingestDay`.** Identify the canonical
production authoring variant per the selection criterion in Design
decision 1 (production-session log diff); extract it into an importable
module; production consumes the extracted module. Wire `compile: "write"`
in `ingestDay`: authoring LLM → `vault_write`, supersede allowed against
prior days only. Tests: (a) ingest a 3-day fixture and assert produced
notes carry compiled structure (frontmatter fields, links, at least one
supersede on a fixture designed to require one); (b) build-time
anti-strawman check — bench and production paths resolve to the same
module in the import graph; (c) runtime anti-strawman check — call-
argument diff (model, prompt, prior-day context, supersede candidates)
between bench and production traces on the fixture is empty.

**Phase 2 — consolidate in finalize.** Wire `compile: "write+consolidate"`:
`finalizeIngestion` writes `shadow_mode: false` into the tmp-vault config
(with the tmpdir-path guard and loud log line), runs `consolidate --mode
both` under `--max-llm-calls`, then reindexes. Test: after a smoke ingest,
`vault_search` on a fixture question returns non-empty related/contested
structure; teardown leaves nothing on disk. Print projected LLM call count
before the run.

**Phase 3 — Path A full run.** A/B/C/D at the Phase-0-frozen N, sharing
vaults pairwise (raw vault → A and B; compiled vault → C and D),
cluster-bootstrapped CIs overall and per tier. Deliverable: a written
results note containing B − A, C − B, C − D, D − A, D − B, per-tier
breakdowns, the C − B decomposition, and an explicit verdict against the
pre-registered kill condition — including, on a kill, which clause fired
("not demonstrated" vs "not worth it" vs "calendar delivery, not
architecture"). The run is not complete until that artifact exists.

**Phase 4 — Path B (conditional).** Only if Phase 3 clears the kill
condition: port LongMemEval sessions, questions, and its LLM judge into
the adapter as a second corpus config; re-run all four arms head-to-head
against the published +10pp framing.

## Open questions

- **Does `compile: "write"` (without consolidate) get its own arm?** The
  four-arm design still collapses the two compiler halves into one delta.
  Adding write-only arms would attribute lift between write-time synthesis
  and read-time tension structure. Deferred to after Phase 3; the kill
  condition applies to the combined `write+consolidate` arms as specified.
- **Canonicalization fidelity.** The style-blind judge depends on
  paraphrase-normalization not destroying answer-relevant content. Phase 0
  measures the style prior, but if canonicalization proves both necessary
  and lossy, the judge design needs rework before Phase 3. Unsettled until
  the Phase 0 numbers exist.
- **Multiple production authoring variants.** The selection criterion
  (highest-traffic production variant, log-verified) is fixed, but if
  production traffic is split near-evenly across materially different
  variants, a single canonical choice under-represents production. Phase 1
  documents the split if found; whether that warrants a variant-comparison
  arm is not settled here.

## Design log (jugalbandi)

Counter-critique points, adjudicated:

- **#1 / edit 1 (axes not orthogonal; add arm D):** Accepted, load-bearing.
  The draft's own Design decision 2 granted the compiler ingest-time date
  access that raw arms never get; C − B conflated architecture with
  calendar delivery. Four-arm design integrated; metrics and kill
  condition re-derived around the C − B = (D − B) + (C − D)
  decomposition. Refinement beyond the counter: since the timestamp axis
  is answer-time-only, D reuses C's vault (and B reuses A's), so the
  counter's ~1.3x cost estimate was pessimistic — arm D costs queries and
  judging only.
- **Edit 2 (style-blind judging to Phase 0):** Accepted. It is a validity
  prerequisite for C − B, not a deferrable nicety; moved to Phase 0 with a
  direct measurement of the style prior.
- **Edit 3 (power analysis; symmetric B − A escape):** Accepted. Power
  analysis from existing A-arm data pre-registered; N moves, the cost
  threshold does not. B − A > +12pp guard added, symmetric to the < +2pp
  hatch. Partially rejected the framing that conjoining magnitude and
  significance conflates failure modes: the conjunction is deliberate
  (cost floor AND demonstration), and the fix is naming which clause
  fired, not splitting the condition.
- **Edit 4 (runtime argument diff):** Accepted. Import-graph sameness is
  build-time only; a runtime call-argument diff on a fixed fixture added
  as Phase 1 test (c).
- **Edit 5 (bootstrap unit before threshold):** Accepted. Cluster
  bootstrap by subgraph fixed at pre-registration; power analysis runs
  against the cluster unit, since effective N drives whether the
  threshold is meaningful at all.
- **Edit 6 (canonical selection criterion):** Accepted. "Extract, don't
  rewrite" was vacuous absent a canonical module; criterion fixed as the
  production-session variant verified by log diff, with the multi-variant
  case documented as the strawman boundary.
- **Edit 7 (in-body date leakage to Phase 0):** Accepted. Scrub
  implemented and its effect on arm A measured in Phase 0; a half-strip
  is exactly the failure the rival result punishes.

No counter point was rejected outright; one framing (edit 3's
conflation charge) was rejected with the conjunction defended as
intentional.
