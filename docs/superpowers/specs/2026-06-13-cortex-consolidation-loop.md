# Cortex Consolidation Loop (Components A + C) — Spec

> **STATUS: spec.** This supersedes the pre-spec synthesis at
> `docs/superpowers/specs/2026-06-06-cortex-consolidation-loop-design-direction.md`
> (the "design-direction doc" below). It assumes that doc's locked decisions
> (§5.2 strength model, §5.3 scheduler, §10 the 2026-06-07 lock, §11 the
> substrate build-list) and does **not** re-derive them. Written 2026-06-13, after
> the §11 substrate shipped **6/6** (through v1.21.0).
>
> **Scope decision (2026-06-13): the full loop, one document.** A and C are the
> action and the trigger of a single loop sharing one envelope (design doc §0).
> The spec covers C, A, the envelope, B's role, calibration, and the recall set
> end to end, and stages the *build* internally (§12). Constants that can only be
> set from real data are written **`TBD — calibrate from shadow data`**, not
> invented: shadow-mode exists precisely to find out where the placeholders are
> wrong (§11.5 brief). A spec that handed you tuned numbers would be the
> ungrounded-generation failure the charter warns about.

---

## 0. What is already built (do not re-build)

The loop is **substrate-complete**. Everything below consumes shipped tools; this
spec builds the *consumer* (the scheduler + the pass + the envelope around them),
not new storage.

| Substrate | Tool / surface | Shipped | What the loop uses it for |
|---|---|---|---|
| §11.1 backfill | `vault_backfill` | 1.17.0 | Adoption; not loop-runtime |
| §11.2 staged queue | `vault_stage_action` / `vault_ratify` | 1.17.0 | A's always-stage tier |
| §11.3 edge store | `vault_edge_observe` / `_contest` / `vault_edges` | 1.20.0 | C's strength source; A's vote sink |
| §11.4 write tools | `vault_merge` / `_supersede` / `_set_confidence` | 1.20.0 | A's permitted `do()` set |
| §11.5 shadow mode | `shadow_mode` config + `.daftari/shadow-actions.jsonl` | 1.21.0 | Calibration substrate (I, B₀) |
| §11.6 agent principal | `ratify` grant + `principal` attribution | 1.21.0 | A's RBAC identity |
| Component B | `daftari eval` | 1.16.0 | The exam — **monitor, never target** |
| Trigger engine | `vault_tension_blast` / `_clusters` / `_resolve` | ≤1.16 | C's forward blast (no scheduler consumes it yet) |

**Verified shipped constants** (`src/curation/edges.ts`, `src/curation/shadow.ts`,
2026-06-13) — all **provisional**, single-sourced, exported, and the calibration
targets of §10:

```
EDGE_K_CAP = 5            EDGE_HALF_LIFE_DAYS = 90      EDGE_TRIGGER_STRENGTH = 0.5
EDGE_REPLAY_GAP_DAYS = 1  strength = min(k,5) · 0.5^(daysSince(last_rederived)/90)
SHADOW_I_BASE = {create .1, append .15, update .2, confidence-set .2,
                 promote .3, deprecate .4, supersede .4, merge .6}
SHADOW_K_BLAST = 0.05  SHADOW_BLAST_ALPHA = 1.5  (I = min(i_base + .05·(blast−1)^1.5, 1))
SHADOW_B0_BASE = 0.5   SHADOW_B0_PER_PENDING = 0.25  (B₀ = min(.5 + .25·pending, max(1, ln N)))
```

---

## 1. The loop

```
  daftari consolidate  ── invoked by cron/OpenClaw OR a human (§9)
         │
         ▼  session start: compute all three clocks
  ┌─────────────────────────────┐   COMPONENT C — the scheduler (§3)
  │ event clock  (git diff since │   builds the prioritized due-queue:
  │   last session → dependents) │     backstop-overdue ∪ event-blast ∪ decay,
  │ decay clock  (aging/TTL)     │     three tiers + a reserved periphery slice,
  │ backstop     (max-interval)  │     all under a per-session COMPUTE budget
  └─────────────────────────────┘
         │  due-queue
         ▼
  ┌─────────────────────────────┐   COMPONENT A — the re-derivation pass (§4)
  │ per due edge: cast a PANEL   │   re-DERIVE the edge independently (generation
  │   of M independent votes     │   effect), blind + varied axis; emit
  │   (varied axes), inside the  │   edge_observe / edge_contest / staged actions;
  │   ENVELOPE (§5)              │   auto-write only inside the two-gate envelope,
  └─────────────────────────────┘   else stage and surface
         │  writes (or shadowed writes during calibration)
         ▼
  ┌─────────────────────────────┐   COMPONENT B — the monitor (§6)
  │ quality (held-out exam) +    │   variance/tail of cortex quality, NOT mean;
  │ coverage/equity instruments  │   strength drift, backstop-overdue, action-mix.
  └─────────────────────────────┘   NEVER an optimization target (§3 of design doc)
```

The **envelope** is the shared spine: the same invariants + trust budget gate both
C's auto-triggering and A's auto-acting. The loop **never auto-deletes**; git +
provenance are the reversibility substrate.

---

## 2. Foundations (locked — pointer only)

Read the design-direction doc for the *why*. This spec treats these as given:

- **Four frameworks** (design §2–§3.7): the Envelope (human sets policy once, agent
  acts within / surfaces outside); the Causal Ladder (A & C are Rung-2 `do()`, B is
  Rung-3 — **A may only `do()` on causes of quality, never the measure**); Revision
  / spaced-repetition (**trust = survived independent re-derivations**); the Agentic
  Trust Protocol two-gate split (strength catches premise-wrong-as-fact; the budget
  catches accumulation+iteration — disjoint, both required).
- **Growth-mindset disposition** (design §3.6): a revised doc is provisional; aging
  is the forgetting curve made a scheduling law. Cashes out as provisional strength
  + failure-as-curriculum + default-to-surface, or it gets cut as fluff.
- **Strength model Q1–Q4** (design §5.2) + **aging** (§5.3.1): strength on edges,
  earned by flat independent-re-derivation count (cap K), blind + ≥1 varied axis,
  contest-and-revoke-with-tension on case-2 failure, gentle aging with
  time-since-re-derivation. **Already implemented in §11.3.**
- **Scheduler C-Q1..C-Q4** (design §5.3): strength-scaled intervals + max-interval
  backstop; compounding-attenuated event-blast; three-tier priority; drain-under-
  ceiling with self-triggers deferred to next session.

---

## 3. Component C — the scheduler

C decides **what to re-derive, when**, under a scarce per-session **compute budget**
(distinct from §5's write/trust budget; re-derivation is read-path, `I=0` on the
write gate, but costs LLM calls). All three clocks are computed **at session start**
— no live hooks (the live event-hook is backlogged to v2, §11).

### 3.1 The three clocks (all session-start)

- **Event clock.** `git diff` the vault between `last_consolidation_commit` and HEAD
  → the set of changed docs → walk the `derives_from` graph (`vault_edges`)
  **forward** from each changed doc, marking dependents due. Propagation
  **attenuates by ∏(path strength)** and **stops** where the compounded product
  drops below a per-class floor (C-Q2; the ATP path-irreversibility insight on the
  trigger side). Implemented over `vault_tension_blast` + a path-strength stop.
- **Decay clock.** Each edge's aged strength (`vault_edges` returns it live) shrinks
  per the 90-day half-life; the review interval `f(aged strength)` shortens
  accordingly, surfacing edges as due. TTL on docs (`ttl_days` frontmatter) feeds
  the same clock.
- **Backstop clock.** Any edge whose time-since-`last_rederived` exceeds the
  **max-interval cap** is *backstop-overdue* — guaranteed a review regardless of
  strength or blast (§3.3).

`last_consolidation_commit` is persisted in `.daftari/consolidate-state.json`
(git-ignored, ephemeral, rebuildable: absent ⇒ first session treats HEAD as the
baseline and runs decay+backstop only — the nil path, §7).

### 3.2 Interval function `f(strength)`

`interval = f(aged strength)`, monotonic increasing, hard-capped by the
max-interval backstop. Concrete form **TBD — calibrate from shadow data**; starting
shape `interval_days = MIN_INTERVAL · 2^(strength)` capped at `MAX_INTERVAL`. With
the shipped half-life this means a k=5 edge rests longest but is still forced at
`MAX_INTERVAL`. `MIN_INTERVAL`, `MAX_INTERVAL` are calibration constants.

### 3.3 Priority — three tiers + a reserved periphery slice

When more is due than the compute budget allows, the budget is **partitioned into
slices** (resolves design §12 #3, periphery starvation — *full* fix, not
mitigation):

1. **Backstop slice (guaranteed).** Reserved fraction for backstop-overdue edges.
   Makes C-Q1's max-interval cap real even in busy sessions (§5.3.1(a)). If
   backstop-overdue work exceeds the slice, the oldest go first; the remainder force
   capacity from the decay slice (never from the periphery slice).
2. **Main slice (event + decay).** Ranked by `fragility × blast` where
   `fragility = 1 − strength/K_CAP` and `blast = downstream-conditioning count`.
   Event-triggered items outrank decay-triggered (a real change is stronger
   staleness evidence than elapsed time — C-Q3).
3. **Periphery slice (reserved, blast-blind).** Ranked by **pure staleness**
   (longest-since-`last_rederived` first), **blast ignored**. This is the fairness
   floor: a zero-blast edge gets nonzero compute *every session*, not only when the
   backstop fires. Without it, `fragility × blast` buries the periphery for a whole
   max-interval (the starvation ratchet, design §5.3.2 #2).
4. **Birth slice (reserved).** A's birth mode (§4.0) over the unprocessed-doc queue,
   FIFO by `created`. Reserved so a fresh vault's cold-start population doesn't starve
   the maintenance slices (and vice versa — once the birth backlog drains, this slice
   yields its budget to the others). One-time per doc.

Slice fractions (backstop : main : periphery : birth) are calibration constants **TBD —
calibrate from shadow data**, instrumented by B's coverage metrics (§6.2) so the
split can be tuned when strength-distribution drift shows.

### 3.4 Stop condition (C-Q4, locked)

A session **drains the prioritized due-queue until empty OR the compute budget is
hit.** Writes produced this session do **not** re-trigger the event clock within the
session — self-generated staleness queues for the *next* session. This terminates by
construction (finite, non-replenishing queue), bounds the ATP iteration mode, and
**is** the anti-cramming rule: re-deriving your own just-written edge in the same
sitting is correlated, not independent. At session end, write the new
`last_consolidation_commit`.

---

## 4. Component A — the re-derivation pass

A is the revision session: for each due edge, **re-DERIVE its claim independently**
(generation effect — *not* re-reading the doc), then record the outcome as votes and,
inside the envelope, as `do()`s. **A is curation, not authorship** — it never writes
doc *content* (design §10.5 forbidden tier).

### 4.0 Two modes — birth and revision (resolves the cold-start gap)

A's `edge_observe` only strengthens edges that already exist, but the *first* observe
in a cycle **seeds** a `k=0` candidate (§11.3). So A is also where edges are *born* —
there is **no separate matcher pipeline** (the same move §3.5 made on
declared-vs-inferred: inference proposes, the loop re-validates). A runs in two modes:

- **BIRTH mode** (an *unprocessed doc*): retrieve the doc's top-K embedding neighbors
  via the shipped `vault_search_related`, re-derive direction for each candidate
  (`from`'s claim derive from `to`'s?), and `edge_observe` the survivors — seeding
  `k=0` candidates. This **is** the §10.2 seeding pipeline, invoked inline rather than
  as a batch job. The **recall@20 ≥ 0.70 kill condition** (§10.2) gates the neighbor
  retrieval step: if embedding recall falls below it, switch the embedding model
  before trusting birth-mode coverage. Birth is one-time per doc — once processed, its
  edges live in the store and only revision mode touches them.
- **REVISION mode** (a *due existing edge*): re-derive the edge's claim and vote
  (§4.1). This is the maintenance loop proper.

C therefore maintains **two queues** (§3): an **edge due-queue** (revision) and an
**unprocessed-doc birth queue** (birth). Both drain under the one compute budget;
birth work is a one-time backlog that drains across sessions like everything else
(§3.3 gives it its own slice). `consolidate-state.json` tracks which docs have been
birth-processed (keyed by canonical path + content hash, so an edited doc re-births).

### 4.1 The panel-per-session multi-pass mechanic (resolves design §12 #1)

When the scheduler marks edge `(from → to)` due, A casts a **panel of M independent
votes** on it within the session:

- Each vote is an independent re-derivation attempt: "does `from`'s claim still
  derive from / depend on `to`'s claim?" Each uses a **distinct varied axis** —
  prompt-framing, input-neighborhood, or model (design §10.6, Q3) — recorded per
  vote. The panel uses ≥2 *distinct* `(observer, axis)` pairs so the store counts
  them as independent in one sitting (§11.3 brief: new `(observer, axis)` pairs
  count immediately; a repeated pair is replay-guarded for `EDGE_REPLAY_GAP_DAYS`).
- **Pass input** (the generation-effect contract): the prior pass's
  *annotations/tensions* for this edge — **not** the raw doc bodies re-read
  verbatim. A pass reads `vault_read`'s **decay + validation report** for both
  endpoints (the premise-freshness hook, ATP `B₁` lesson, design §3.7) and the edge's
  existing tension trail. It re-derives from premises, it does not copy the prior
  answer (copying = cramming = correlated error).
- **Pass output, per vote:**
  - *survives* → `vault_edge_observe(from, to, observed_by, blind=true, varied_axis=…)`
    → store increments `k_survived` toward `EDGE_K_CAP=5`, refreshes the aging clock.
  - *fails, no upstream change* (case-2) → `vault_edge_contest(from, to, …, reason)`
    → store revokes + logs a tension (Q4: surface, never silent-decrement).
  - *fails because an endpoint changed* (case-1) → not a vote; this is C's trigger
    for the endpoint, already handled by the event clock. No penalty.
- **Panel cap M** is a calibration constant (starting point M=2–3) **TBD — calibrate
  from shadow data**. With M=2–3, `k_survived` reaches `K_CAP=5` in ~2 sessions, not
  ~5 — bounded per-sitting cost, spaced repetition across sittings.
- **Panel stop:** M votes cast **OR** the compute budget is hit (whichever first).
  Within-edge fixpoint and same-pair re-votes are *not* done in one sitting (anti-
  cramming; the inter-session gap is what certifies the next vote independent).

### 4.2 A's permitted `do()` set (design §10.5, locked)

- **Auto-write tier (inside the envelope, both gates pass):** `link` (ratified
  `derives_from` edge via `edge_observe`), `confidence-down` (paired with a tension
  citing the failed re-derivation), `tension_log`, `contested-edge revoke` (via
  `edge_contest` — surfaces a tension, never silent).
- **Always-stage tier (`vault_stage_action` → human `vault_ratify`):** `promote`,
  `deprecate`, `supersede`, `merge`, `confidence-up`; **any** action on a doc with an
  unresolved tension; **any** action on an edge below trigger-bearing strength
  (`< EDGE_TRIGGER_STRENGTH`).
- **Forbidden in v1:** content/authorship writes; `provenance: direct` on
  auto-actions (auto-actions are `inferred`/`synthesized`, enforced via the
  curation-log `agent`/`principal` stamp, not the frontmatter enum); **multi-action
  passes** (one `do()` per pass; composition deferred to v2, §11).

---

## 5. The envelope

Two non-substitutable gates (design §5.2). An action auto-writes **iff both pass**;
otherwise it stages and surfaces.

### 5.1 Invariants (the "small opinionated set")

- **Never-delete.** Deprecate/supersede/annotate only.
- **Provenance-required.** No `do()` on a doc whose provenance is unknown/broken.
- **Premise-freshness.** `vault_read`'s decay/validation report is read into the
  pass; a stale/decayed premise ⇒ surface, don't act.
- **Tension-respect.** No auto-action on a doc with an *unresolved* tension; surface.
- **Never-optimize-the-measure.** No intervention justified by "this should raise B."

### 5.2 The trust budget (the accumulation gate)

A monotonic per-session scalar `Bₜ`, ported from the shipped shadow math
(`shadowBudget`): `B₀ = min(0.5 + 0.25·pendingStagedActions, max(1, ln N))`. Each
approved `do()` deducts its impact `I = min(i_base + 0.05·(blast−1)^1.5, 1)`
(`shadowImpact`, the §10.4 convex scaling). When `Bₜ < I(next)`, the pass
**checkpoints → surfaces** (stages, does not auto-write). **Synergy mode** (design
§3.7): the pass *sees* `Bₜ` before the gate fires and self-limits — so the human is
rarely interrupted, and a comprehensive-propose run can't sneak a high-blast action
through a budget that's already low (the ATP `A₃` lesson).

**The budget bounds comprehension/coherence load, not irreversibility** (git zeroes
mechanical reversal — design §3.7 justification shift). Whether the budget improves
quality/variance *anyway* is the §6.1 ablation — the loop's genuine empirical
contribution and the kill condition for the justification shift.

### 5.3 Shadow-first graduation

The loop **runs in `shadow_mode` (§11.5) until the I-table and B₀ are calibrated from
real shadow data** (§10). In shadow mode every `do()` computes-but-doesn't-write,
logging `{i_base, blast, impact, budget, spent_before, would_gate, diff}` to
`.daftari/shadow-actions.jsonl`. Only after calibration does the auto-write tier
graduate out of shadow. At empty cold-start the ledger is empty, every edge is
`candidate` (`k=0`), so **every action stages** — A behaves as surface/propose and
*earns* autonomy as strength accrues (Q5 Synergy graduates itself out of fatigue).

### 5.4 v1 envelope gaps (carried from §11.6 review — written, not hidden)

- **Pure-verdict outcomes carry only the free-text claim.** A *reject* dispatches no
  write; a *contest* writes no provenance entry — so both record only `ratifiedBy` /
  `contested_by`, not an authenticated `principal`. Adding `decided_by_principal` to
  the staged-action decision record and the contest tension is **v1 work for this
  spec** (§8) — it is the audit-trail closure the loop needs.
- **Tension-resolution stays one trust tier below contest.** `vault_edge_contest` is
  `ratify`-gated, but resolving the tension it creates is any-read — a contest's loud
  surface can be resolved away a tier down. The spec **gates `vault_tension_resolve`
  on `canRatify`** for loop-created tensions (§8), closing the asymmetry.

---

## 6. Component B — monitor, never target

### 6.1 Effect estimation (resolves design §12 #2 / §6)

- **Validate on a held-out question set**, never the set a pass could see (the B-spec
  fresh-seed / rotating-seed defense — the testing-effect Goodhart guard). The
  50-pair recall set (§7) is held out from A.
- **Attribute variance/tail reduction, not mean.** The ATP headline signal is
  worst-case bound, not average lift (naive write-count std up to 2.9 vs airlock
  <1.0). B reports *the envelope bounds worst-case cortex-quality drift across runs.*
- **The §6.1 comprehension-load ablation.** Daftari git-zeroes irreversibility, so a
  trust-budget effect on quality/variance isolates **comprehension-load** as the
  active ingredient — a result the email paper can't reach. **Kill condition:** no
  budget effect on quality/variance ⇒ comprehension-load was *not* the active
  ingredient and the budget has no role in a git-backed never-delete vault.

### 6.2 Coverage/equity instrumentation (resolves design §12 #5 / §5.3.2)

B (or a sibling monitor surfaced via `vault_lint`) must track across sessions, so the
budget-drift ratchets are visible:

- **Strength-distribution drift** — is variance widening (core strengthening while
  periphery flatlines)?
- **Backstop-overdue count** — how many edges are past their guaranteed review and
  still unserved (the periphery-slice and backstop-slice fractions are tuned against
  this)?
- **Action-mix drift** — is the `do()` mix creeping toward cheap `link` over
  `deprecate`/`merge`?

These instrument never-optimize-the-measure from the other side: **B must measure
what the budgets can break, or the budgets break it blind.**

---

## 7. The 50-pair labeled recall set (resolves design §12 #7)

The dataset gate for any *measured* result. Cannot be mined from existing vault
structure (mining biases toward the link graph — the thing the matcher must beat,
design §10.6).

- **Construction: two-rater + adjudication (paper-grade).** Two independent raters
  label the same candidate pool for `derives_from` (yes/no, directed); disagreements
  adjudicated by a third pass; **Cohen's κ reported**. Stratified across the three
  edge classes (§10.3: forward-temporal / backward-causal / symmetric-re-examine) and
  across collections. **Positives may not come purely from wikilinks/superseded_by**
  — off-structure derivations are required, consciously added.
- **Hard negatives:** matched pairs that co-occur / are embedding-near but are *not*
  derivations (so recall isn't gamed by a promiscuous matcher).
- **Refresh:** quarterly, alongside the re-calibration cadence (§10).
- **NAMED DEPENDENCY (open sub-item, §13):** the **second qualified rater**. The set
  needs a second rater who knows the vault's derivation structure; that may currently
  be only Mihir. Until a second rater is sourced (recruited domain expert, or a
  documented LLM-rater protocol with human adjudication), the set is **single-expert
  smoke-grade** and *no paper-grade recall claim may be made*. This gate is explicit
  so a single-rater number is never laundered as paper-grade.

---

## 8. RBAC / principal (resolves design §12 #8)

- **Role:** `agent:curation-loop`, declared in `.daftari/config.yaml`:
  `read: ["*"], write: ["*"], ratify: false`. **The loop proposes; humans ratify.**
  Started as `daftari --user agent:curation-loop --role curation-loop` (§11.6).
- **Attribution:** every loop write records `principal: agent:curation-loop` beside
  the free-text `agent` claim (§11.6, shipped). `updated_by` renders the principal.
- **v1 closure work** (from §5.4): add `decided_by_principal` to the staged-action
  decision record and the contest tension; gate `vault_tension_resolve` on
  `canRatify` for loop-created tensions.

---

## 9. Cadence / entrypoint (resolves design §12 #6)

- **One invocable command: `daftari consolidate`.** Pure entrypoint, no self-clock.
  Computes all three clocks at session start (§3.1), drains under ceiling (§3.4),
  exits. **Same command whether invoked by cron/OpenClaw or by a human** — "who
  invokes" is deployment config, not spec. This honors C-Q4: the external clock *is*
  the inter-session gap.
- **Exit semantics:** the command reports `{edges_reviewed, votes_cast,
  auto_writes, staged, surfaced, budget_spent, backstop_overdue_remaining}` and a
  non-zero exit if backstop-overdue work was left unserved (so a cron wrapper can
  alert). Writes `last_consolidation_commit`.
- **Quarterly re-calibration** is the same external driver on a quarterly cadence,
  running the §10 protocol. The driver is external (cron/OpenClaw/human); the loop
  does not self-schedule it.
- **Live event-hook is NOT in v1** (backlogged, §11) — it buys immediacy the design
  doesn't want (fights C-Q4 anti-cramming) and couples the loop to a hook surface.

---

## 10. Calibration protocol (resolves design §12 #4 — protocol, not values)

The shipped constants (§0) are **placeholders**. The spec defines *how* they're set,
not *what* they are.

1. **Run the loop in `shadow_mode`** (§5.3) over a real working window. Every would-be
   `do()` logs its `{i_base, blast, impact, budget, spent_before, would_gate, diff}`.
2. **Re-segment sessions offline** (the §11.5 v1 limit: "session" = process lifetime;
   every record stores `spent_before`+`budget`, so true session boundaries —
   idle-gap / loop-session reset — are recoverable post-hoc).
3. **Tune** against B's quality/variance + coverage metrics (§6): the `SHADOW_I_BASE`
   table, `SHADOW_K_BLAST`, `SHADOW_B0_*`; the edge constants `EDGE_K_CAP`,
   `EDGE_HALF_LIFE_DAYS`, `EDGE_TRIGGER_STRENGTH`; the scheduler constants
   `MIN/MAX_INTERVAL`, panel cap `M`, slice fractions (backstop : main : periphery),
   aging rate. The ATP precedent: `B₀` was re-tuned after `B₁` — expect the same here.
4. **Graduate** the auto-write tier out of shadow only after the table stabilizes.
5. **Re-calibrate quarterly** (§9), refreshing the recall set (§7) alongside.

Calibration is **never** tuned to raise B (design §3 poison constraint) — it's tuned
so the *envelope's variance/coverage behavior* matches the design intent.

---

## 11. NOT in scope (deferred, with one-line rationale)

- **Live event-hook** (git post-commit / MCP write signal → live due-queue) — **v2 /
  backlog.** Buys immediacy that fights C-Q4 anti-cramming; adds hook-surface
  coupling. Session-start git-diff covers the event clock without it.
- **Compensation / Saga multi-pass rollback** — **v2.** v1 is preventive only (gates
  before firing). `git revert` is a genuine compensator but unwinding pass-2-on-pass-1
  is the Saga combined-transaction problem (design §3.7).
- **Multi-action passes** (composing several `do()`s in one pass) — **v2.** v1 is one
  `do()` per pass.
- **PageRank / recursive strength weighting** — schema is weight-ready (Q2); nothing
  computes weights. Any weighting must run over the **re-derivation graph, not the
  link graph** (link-PageRank is Rung-1-as-Rung-2 poison).
- **Standalone batch seeding command** (a separate `daftari seed`) — NOT built; the
  §10.2 seeding pipeline lives inline as A's birth mode (§4.0). The recall@20 ≥ 0.70
  kill condition still gates birth-mode neighbor retrieval.
- **Per-principal shadow filtering** — shadow is a vault posture, not a per-principal
  filter (§11.5).
- **`vault_backfill` ratification UX** (per-folder cadence, escalation) — adoption-time,
  not loop-runtime.

---

## 12. Build stages (internal staging of the one spec)

One spec, staged build (design §0 permits internal staging). Each stage is shippable
and shadow-safe.

1. **Stage 1 — C scheduler skeleton + `daftari consolidate`.** Session-start clock
   computation over the shipped `vault_edges` + `vault_tension_blast`; the four-slice
   priority (backstop : main : periphery : birth); drain-under-ceiling;
   `consolidate-state.json` (last-commit + birth-processed-docs). No A yet — emits both
   queues (edge due-queue + unprocessed-doc birth queue) to stdout/lint. Verifiable:
   the queues match hand-computed due/unprocessed sets on a fixture vault.
2. **Stage 2 — A's two modes, shadow-only.** Birth mode (§4.0: `vault_search_related`
   neighbors → re-derive direction → seed `k=0` candidates) AND the panel-per-session
   revision pass emitting `edge_observe`/`edge_contest`/`stage_action`, all under
   `shadow_mode`. Birth-mode neighbor retrieval instrumented for recall@20 (§10.2 kill
   condition). Starts the calibration data flowing (§10). No auto-write graduates.
3. **Stage 3 — envelope + the §8 closure work.** Two-gate enforcement (invariants +
   trust budget) wired live but still shadowed; `decided_by_principal`; gate
   `vault_tension_resolve` on `canRatify` for loop tensions.
4. **Stage 4 — B coverage/equity instrumentation** (§6.2) on `vault_lint` + `daftari
   eval`. Makes the ratchets visible before any auto-write graduates.
5. **Stage 5 — calibrate from shadow data; graduate the auto-write tier** (§10).
6. **Stage 6 — the recall set + effect estimation** (§7, §6.1) — gated on the second
   rater (§13).

Each stage: brief → test-first → two adversarial **general-purpose** reviewers (NOT
the squad agents — their tool bindings are broken) → fix → PR. Release ritual per
`reference_daftari_release_ritual` (npm publish is Mihir's MFA step).

---

## 13. Open sub-items (named, not invented)

- **Second qualified rater for the recall set** (§7) — the hard dependency gating any
  paper-grade recall claim. Until sourced, results are smoke-grade.
- **All calibration constants** (§10) — `TBD — calibrate from shadow data`. Listed,
  single-sourced, exported; never invented.
- **Per-class path-strength floors** for event-blast attenuation (§3.1, design §10.3)
  — the three edge classes get three floors; values are calibration constants.
- **Charter amendment (required, §14).**

---

## 14. Charter amendment (required)

`CLAUDE.md` asserts: *"The curation engine is advisory. `vault_lint` reports
problems. It does not auto-fix."* Component A's auto-write tier (§4.2) amends this.
The amendment must be **explicit**, landing with Stage 5 (graduation), not implicit:
the engine is advisory **until an action clears both envelope gates inside a
calibrated budget**, at which point the loop may auto-write the low-`I` tier; all
higher-`I` actions stay staged for human ratification. The never-delete, B-is-monitor,
and never-optimize-the-measure invariants are unchanged.

---

## Appendix — traceability to the design-direction doc's §12 opens

| §12 open | Resolution |
|---|---|
| #1 multi-pass mechanic | §4.1 panel-per-session (M votes/edge/session, varied axes, stop=panel∨budget) |
| #2 effect estimation | §6.1 held-out set, variance/tail not mean, §6.1 ablation |
| #3 periphery starvation | §3.3 reserved periphery slice (pure-staleness, blast-blind) |
| #4 compute-budget calibration | §10 protocol (shadow → tune → graduate → quarterly); values TBD |
| #5 B coverage instrumentation | §6.2 strength drift / backstop-overdue / action-mix |
| #6 cadence driver | §9 one `daftari consolidate`, external caller; live hook → v2 |
| #7 50-pair recall set | §7 two-rater + adjudication, κ; second-rater dependency named |
| #8 A's RBAC | §8 `agent:curation-loop` read:* write:* ratify:false + §5.4 closures |
