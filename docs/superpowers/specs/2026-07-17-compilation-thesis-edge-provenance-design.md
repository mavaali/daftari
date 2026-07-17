# The compilation thesis as edge provenance — design through-line

2026-07-17. Status: **draft — distilled from the #232–#235 review pass;
no implementation in this doc.**
Issues: #232 (tiered checking), #233 (compiled dependency graph),
#234 (staleness telemetry), #235 (agent proposals), #236 (sequencing +
quick wins). Constraint predecessors: CLAUDE.md invariants,
2026-07-14-edge-graph-existence-disclosure-design.md.

## The claim

The four issues are one claim: **the type system does the work; LLM
judgment and human review spend attention only on the residual the
structure cannot decide.** This doc makes that claim precise enough to
build against, using the one refinement the codebase forces: *which*
structure can decide *what* is determined by the provenance of the edge
being checked, not just its type.

## Three edge provenance classes

[DATA] The vault already carries two classes of doc-to-doc edge, and
issue #233 adds a third. They differ not in shape but in epistemology —
how the edge came to exist determines what a checker may conclude from
it:

| Class | Relation | Producer | Canonical store | Epistemic status |
|---|---|---|---|---|
| **Declared** | `sources[]` frontmatter (`src/frontmatter/types.ts:40`), body links | The author, by hand | The document itself | A *claim*. May be wrong, stale, or aspirational. |
| **Earned** | `derives_from` (`src/curation/edges.ts`) | LLM derivation panel (consolidation loop), strength recomputed from the observation trail, 90-day half-life | `.daftari/edges.jsonl`, append-only; SQLite mirror is a rebuildable cache (`src/storage/index-db.ts:147`) | A *probabilistic inference*. Strength is a survival record, never a fact. |
| **Compiled** (#233) | `consumes[edge_type, field_refs, compile_ts]` | Mechanical: run-correlation over provenance (`reads(run_id) × writes(run_id)`) | `.daftari/consumes.jsonl`, append-only; SQLite mirror as cache (same pattern) | A *certainty*. The run demonstrably read these inputs before writing this artifact. |

[DATA] There is no compiler of documents in the tree — the consolidation
loop derives edges, not artifacts (`src/consolidate/`). Compiled edges
are therefore minted from run correlation (the #235 `run_id` provenance
delta feeds the #233 producer), not from a compilation step that would
have to be invented.

## The dispatch rule

**A check's maximum tier is bounded by the provenance class of the edge
it runs on.**

- **Compiled → Tier 0/1 (hard verdicts allowed).** The edge is
  mechanically certain, so referential integrity, lifecycle
  consistency, and field-level skip decisions ("only `description`
  changed, dependent consumed `formula` — no-op") are decidable, and a
  failure is a fact, not an opinion.
- **Declared → Tier 0 shape checks only; Tier 1 conclusions are
  claim-quality.** The edge may misstate real dependence in either
  direction. A broken declared reference is a real lint finding (the
  *reference* is broken regardless), but "dependent unaffected" derived
  from a declared edge inherits the claim's uncertainty.
- **Earned → Tier 2 at most, and only as a *router*.** An earned edge
  with high strength is a good reason to *ask* the semantic question
  (#232 Tier 2); it is never grounds for a hard verdict, because the
  edge itself is an LLM inference with a decay schedule. Earned edges
  route attention; they do not decide.

This is the compilation thesis stated as a dispatch table: certainty
flows from mechanical provenance, and everything the mechanical layer
cannot certify is explicitly labeled residual and routed to the
expensive judges (LLM at Tier 2, human at ratify time) — which is where
attention *should* be spent, and nowhere else.

Corollary for #232: tier assignment keys on `(edge class, edge type,
field_refs)` — class first. An implementation that dispatches on edge
type alone will eventually issue a hard verdict off an earned edge,
which is a category error.

## Vocabulary mapping (issues → code)

The issues use a vocabulary the code does not. To prevent drift:

| Issue term | Code term |
|---|---|
| unit | document (markdown file; post-atomization granularity per 2026-06-23 spec) |
| artifact | document written by an instrumented run (has compiled inbound edges); nearest existing marker is `provenance: "synthesized"` |
| certified | `canonical` (`src/frontmatter/types.ts:13`; there is no `certified` status) |
| proposed | staged action, `pending` (`src/curation/staged-actions.ts:60`; there is no `proposed` document status, by decision — see #235) |
| compile step | an instrumented agent run (`run_id` in provenance); there is no document compiler |

## Inherited constraints (restated so no issue violates them)

- **Ephemeral index.db** (CLAUDE.md): canonical stores for compiled
  edges, telemetry, and proposals are append-only `.daftari/*.jsonl`;
  SQLite is always a rebuildable cache. Compile *history* in particular
  must survive a reindex or #233's provenance promise is false.
- **Advisory curation**: tier checks never block writes. Enforcement
  points are lint/audit (CI-gateable via `failOn`,
  `src/audit/config.ts:33`) and the ratify gate — ratification is
  already a gate, so blocking there is legitimate.
- **Existence disclosure** (2026-07-14 spec): every new agent-facing
  graph or staleness surface omits unreadable paths and coarsens hidden
  remainders to none/some/many. Exact blast integers stay
  operator-side. A consumer needing to *rank* by hidden magnitude is
  that spec's revisit trigger.
- **Frontmatter is the metadata layer**: edges carry their own stores
  by established precedent (`edges.jsonl`), but no new per-document
  metadata format is introduced.

## The free experiment

[DATA] Once #233 lands, the same corpus carries LLM-earned structure and
mechanically-compiled structure side by side, produced independently
over the same documents. That is an A/B of the two epistemologies nobody
has run:

- **Agreement rate**: of compiled `consumes` edges, what fraction have a
  surviving earned `derives_from` counterpart (and vice versa)? Earned
  edges missing from the compiled set are either hallucinated
  derivations or real semantic dependence invisible to read-correlation
  — both findings.
- **Precision proxy**: when a Tier 0/1 break fires on a compiled edge,
  did the earned graph's strength on that pair predict it? If earned
  strength carries no signal about actual breakage, the derivation panel
  is measuring something other than dependence.

Publish either way (Experiment and Publish). This experiment costs one
join over two JSONL files.

## The measurement that matters

Proposal arrival rate vs. review throughput (#235, quick win 2 in
#236). [DATA] The inputs already exist: `staged-actions.jsonl` carries
proposal and decision timestamps; witness computes per-principal
outcomes (`src/witness/track-record.ts`). This is the review-capacity
wall in miniature — the point where human certification stops scaling is
the operational form of the attention-is-the-bottleneck question, and
instrumenting it before the multi-agent feature ships means the dataset
predates the treatment. The through-line prediction, falsifiable: as
proposal volume grows, review throughput saturates, and the only lever
that moves the ratio is growing the fraction of proposals the tier
pipeline resolves without human attention — i.e., the type system doing
more of the work.

## Sequencing (decided in #236)

1. Quick wins in parallel: #232 Tier 0 (no graph dependency), #235
   review-throughput aggregate (data exists), SQL-authoritative
   `derives_from` reads (unblocks #234's read-time hop).
2. #235 deltas: `write` staged-action type, `run_id`, inter-proposal
   tension kind, `proposeOnly` role flag.
3. #233 compiled graph fed by run correlation; then #232 Tier 1 on
   compiled edges.
4. #234 staleness classes reading tier verdicts.

The inversion from the original 2 → 1 → 4 ordering follows from the
provenance-class analysis: compiled edges need `run_id` (a #235 delta),
so #235's provenance work precedes #233 — and every phase ships a
measurement that makes the next phase evidence-driven.

## Kill conditions

- [HYPOTHESIS] **Dispatch-by-class earns its keep.** Kill: if after
  #233 lands, ≥90% of compiled edges duplicate declared `sources[]`
  edges on the same pairs, the class distinction is decorative for
  checking purposes (declared would have sufficed) and Tier 1 can
  dispatch on type alone.
- [HYPOTHESIS] **Run-correlation approximates true input sets.** Kill:
  if instrumented runs habitually read far more than they use
  (`consumes` edges with no detectable influence on the artifact), the
  compiled graph over-approximates and Tier 1 skip decisions lose their
  precision advantage — field_refs coarseness (v1: frontmatter keys +
  "body") is the first suspect, span-level anchoring the escalation.
- [HYPOTHESIS] **The residual shrinks.** Kill: if the fraction of
  changes resolved at Tier 0/1 stays below ~40% after the compiled
  graph exists (#232's acceptance restated per-class), the type system
  is too coarse to carry the thesis, and the honest conclusion is that
  attention, not structure, does the work here. Publish that.

## Non-goals

- No implementation in this doc; each issue carries its own acceptance.
- No unification of the three edge classes into one store or one
  schema — their epistemologies differ; flattening them is the error
  this doc exists to prevent.
- No trust tiers or auto-promotion (deferred in #235, unchanged).
