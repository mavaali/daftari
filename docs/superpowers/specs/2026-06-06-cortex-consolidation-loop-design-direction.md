# Cortex Consolidation Loop (Components A + C) — Design Direction

> **STATUS: pre-spec brainstorm synthesis.** This is NOT the validated spec. It is a
> working document that re-establishes the frameworks and captures decisions reached so a
> fresh session can resume the brainstorm cold and move to a real spec. Written 2026-06-06
> after the cortex quality metric (Component B) shipped in v1.16.0 (PR #99).
>
> **REVISED 2026-06-06 (same day):** grounded the autonomy/blast-radius design in Mihir's
> *Agentic Trust Protocol* paper (`~/projects/agentic-trust-protocol`). This added Framework 4
> (§3.7, path-irreversibility / trust budget), made §4 concrete (the airlock-envelope + an
> irreversibility table), fully resolved the §5 keystone via a **two-gate split** (§5.2), and
> reframed §6 around variance-reduction + a new open empirical question (§6.1, the
> comprehension-load ablation). Strength-model decisions Q1–Q5 locked (see §3.5 / §5.2).
>
> **REVISED again 2026-06-06 (scheduler pass):** added §5.3 — the scheduler (Component C):
> strength-scaled intervals + backstop (C-Q1), compounding-attenuated event-blast (C-Q2),
> three-tier priority under a compute budget (C-Q3), drain-under-ceiling with self-triggers
> deferred (C-Q4). A longitudinal "combined-budgets" review surfaced two **ratchets**
> (entrenchment, periphery starvation); §5.3.1 reopens strength-Q4 to add **strength aging** +
> **backstop-as-guarantee**, and §6 now requires B to measure **coverage/equity, not just
> quality** (second-order Goodhart). See §8 #8–#10 for newly-open items.

---

## 0. Where this sits

The "Daftari Sleep Extensions" umbrella (issue **#97**) has three components:

- **Component B — cortex quality metric.** SHIPPED (v1.16.0). `daftari eval` scores how well an
  LLM can traverse the vault via MCP tools to answer multi-hop questions. Tier-weighted
  (retrieval 1× / cross-reference 2× / contradiction 3×). This doc treats B as a given.
- **Component A — multi-pass curation.** Deferred by the B spec; now unblocked ("once the
  metric exists, the next spec asks: does N=2 curation move the number?").
- **Component C — dependency-triggered re-curation.** Deferred; "requires Component A."

**Decision (locked): one spec for the whole loop.** A and C are not two features; they are the
*action* and the *trigger* of a single loop, and they share one piece of infrastructure (the
envelope). Splitting them fragments the only decision that matters. Implementation may still
stage internally (envelope + A's action core first, then C's triggers), but the design is one
coherent thing.

**Eval (B) v1 follow-ups are tracked separately** in issue **#102** (and `daftari eval prune` in
**#100**). They are not part of this loop design.

---

## 1. The loop, in one diagram

```
   a doc changes (write / promote / deprecate / new tension)
            │
            ▼
   ┌──────────────────┐   C = the TRIGGER
   │ blast to dependents│   "which docs are now potentially stale because the thing
   └──────────────────┘    they causally depend on changed?"  (Rung 2: do(change Y) → descendants)
            │
            ▼
   ┌──────────────────┐   A = the BOUNDED ACTION
   │ re-curation pass  │   multi-pass consolidation INSIDE the envelope; STOPS and
   │ (inside envelope) │    surfaces at the boundary instead of interpolating
   └──────────────────┘
            │
            ▼
   ┌──────────────────┐   B = the PORTFOLIO MONITOR
   │ score the effect  │   did cortex quality improve? (Rung 3: counterfactual)
   └──────────────────┘    — but B is NEVER the optimization target (see §3)
```

The **envelope** is the shared spine: the same invariants gate both C's auto-triggering and A's
auto-acting.

---

## 2. Framework 1 — The Envelope (from Mihir's "Hallucinated Intent and the Envelope Problem")

Source: https://waglesworld.com/blog/hallucinated-intent-and-the-envelope-problem (2026-03-24)

**Hallucinated intent** is the dangerous failure mode: not getting *facts* wrong, but getting
*judgment* wrong while looking confident. *"The dangerous failure isn't when agents get facts
wrong. It's when they get judgment wrong and look confident doing it."* The mechanism is
autopilot-style interpolation: *"The system operates fine within its training envelope. The
moment conditions get ambiguous … it doesn't stop. It interpolates."* The output is plausible,
so you don't scrutinize it — the system succeeds at the wrong thing.

**Why human-in-the-loop collapses:** *"Assessment requires comprehension. Comprehension requires
time. And time is exactly what machine-speed execution eliminates."* Transactional review can't
keep pace; under load the human misses hallucinated intent precisely because it looks plausible
and *"supervision has already drifted."*

**The three design principles (the resolution):**
1. **Read/write segregation.** *"Let them read anything … Reads are free. But the moment an agent
   writes … that's a command. It crosses the envelope boundary."*
2. **Specification-first, not context-first.** *"A small, opinionated set of boundary conditions
   that encode the judgment calls that actually matter."* (Explicitly rejects context graphs.)
3. **Portfolio-level monitoring.** *"A coach doesn't watch every ball with the intent to
   intervene. A coach watches the pattern of play and adjusts between sessions."* Test envelope
   *invariants*, not individual decisions.

**Meta-principle:** precision *before* deployment (policy-time), not governance *after* execution.

**What this does to the naive "advisory" answer:** pure-advisory ("every pass emits more
annotations a human reviews") is the *worst* version — it generates more plausible output for an
already-drifting reviewer. Advisory does not dodge the overload problem; it feeds it. The envelope
reconceives "advisory": **advisory ≠ "human reviews every item." Advisory = "human sets the
envelope (once, at policy-time); the agent acts within it and STOPS/surfaces outside it; the human
monitors the pattern, not the items."**

---

## 3. Framework 2 — The Causal Ladder (Pearl, *The Book of Why*)

Map the three rungs of the ladder of causation onto the loop:

- **Rung 1 — seeing / association.** This is *all of Daftari today.* `vault_lint`, `tension_log`,
  the link/supersede graph: they *observe* patterns ("these docs co-occur, contradict, supersede").
  The advisory engine sees. It never acts.
- **Rung 2 — doing / intervention.** This is exactly A and C. C is `do(change Y)` → *which
  descendants are causally affected?* A is the permitted `do()` set: `do(promote X)`,
  `do(deprecate Y)`, `do(merge X,Y)`. **The envelope is a policy over interventions** — which
  `do`-operations are in-bounds.
- **Rung 3 — counterfactual / imagining.** This is B. *"Does N=2 curation move the number?"* is a
  counterfactual: score under `do(curate)` vs. not.

**The poisoning trap, stated causally (this is the load-bearing insight):** cortex-quality
*causes* B (`quality → B`; B is a measurement of quality). Optimizing the score means intervening
on the **effect** (keyword-stuffing, over-linking) instead of the **cause**, which severs the
`quality → B` link. That *is* Goodhart, stated in do-calculus. Therefore the single most important
envelope invariant:

> **A may only `do()` on the causes of quality (structural integrity). It may NEVER `do()` on the
> measure. B stays a passive observation of the effect, never a target.**

This also tells us what the envelope's invariants are *about*: **structural integrity**
(provenance intact, reversibility preserved, tensions respected, nothing deleted) — *not* the
score.

---

## 3.5 Framework 3 — Revision / Relearning (the loop is a spaced-repetition system)

Mihir's framing, and the unifying key: *"relearning builds strong memories when you are learning
new concepts as a student, not just observing the teacher do it once."* This is the **generation
effect** + the **testing effect** + **desirable difficulties** (Bjork; Roediger & Karpicke) applied
to the cortex. It is the *mechanism* under "multi-pass beats single-pass," and it resolves §5.

**The loop, re-read as a spaced-repetition system:**
- **C = the scheduler.** A dependency change (or staleness/TTL = the *forgetting curve*) marks a doc
  "due for review." C decides *what to revise, when* — you don't re-derive everything every pass
  (too expensive); you revise what's at risk. That's spaced repetition's core economy.
- **A = the revision session.** A pass that re-*derives* over the *prior pass's* annotations/tensions
  (not the raw docs) is the student relearning — the generation effect. Re-reading raw docs is
  "watching the teacher again": weak. Re-deriving is strong. This is *why* multi-pass works.
- **B = the exam.** Retrieval practice. Running B both *measures* and (via the testing effect) helps
  *consolidate* — and its failures are the **curriculum**: the multi-hop questions the vault can't
  support are the weak links a revision pass should target.

**This resolves the §5 keystone.** A declared edge and an inferred edge are each *one exposure* —
"watching once," weak either way. **An edge's trust = how many times it survived independent
re-derivation, not how it was born.** Strength = memory strength. You stop asking "declared or
inferred?" and ask "how many passes re-derived this, and did they agree?" The graph is *earned* —
revised into existence — which is the answer to "there is no free causal graph": it's not free, it's
*replicated into trustworthiness.*

**Two hard requirements the frame imposes (not just blessings):**
1. **Independence / varied retrieval.** Convergence is evidence *only if* re-derivations are
   independent. A pass that re-reads its own prior (wrong) answer entrenches it — cramming, not
   learning, = correlated error, not replication. So revision **demands variation**: different
   angles / prompts / possibly models per pass. (This is also the §6 identification story:
   replication-under-variation is the closest thing to an RCT a vault can have.)
2. **The testing effect carries the Goodhart edge.** If A revises *specifically* to make B's
   questions answerable, that's teaching to the test — the poison in a graduation gown. Resolution =
   good pedagogy: **test on held-out, varied problems, never the practice set** — i.e. the B spec's
   fresh-seed / held-out defense. "Spaced repetition with varied retrieval" is simultaneously the
   learning-science best practice **and** the anti-poison. Same mechanism — which is the strongest
   sign the frame is load-bearing, not decorative.

**Design consequences to carry into the spec:**
- Edges (and consolidations) get a **strength/confidence that accrues on survived re-derivation and
  decays when a pass fails to re-derive them** — a memory-strength model, not a boolean.
- Trigger-authority (§5) is *graduated by* that strength: an edge earns the right to wake C only
  after surviving K independent revisions.
- A pass MUST re-derive (generate), not copy; and passes MUST vary, or convergence is meaningless.
- B's question set for *validating* a revision MUST be held out from what the revision could see.

---

## 3.6 The disposition — Growth mindset ("learn-it-all, not know-it-all")

The three frameworks above are *mechanisms*; they all assume a stance. Nadella's growth mindset
(Dweck) is that stance, and it is the *why* under the whole loop — not a fourth mechanism, the
**disposition layer** above the other three.

- **Learn-it-all vs know-it-all = revised doc vs frozen doc.** A doc written once and frozen asserts
  it's done knowing (know-it-all). A doc continuously re-derived holds knowledge provisionally
  (learn-it-all). Growth mindset says the second is stronger — the *why* under §3.5's revision frame.
- **The fixed-mindset cortex IS the failure mode.** Overconfidence in what it "knows" = hallucinated
  intent (§2) = the Goodhart trap (§3): a know-it-all system *defends its B score*; a learn-it-all
  system *mines its failures*. Growth mindset is what keeps the testing effect on the right side of
  the poison line — **B's failures are the curriculum, not an embarrassment to hide.**
- **It answers a question no mechanism could:** *why revise at all, instead of defending the current
  state?* Because the stance is learning, not knowing. "Hit refresh" = the consolidation pass; the
  system owes it to itself to re-curate rather than ossify.
- **It sets the envelope's default:** at the boundary, a learn-it-all **surfaces (asks/learns)**
  rather than **asserts (acts)**. Humility = default-to-surface.

**Discipline (so this stays load-bearing, not decorative — the threat model warns "fluff" appears
first in Component A):** growth mindset earns its place ONLY by cashing out concretely:
- *provisional edge/knowledge strength* (§3.5) — nothing is "known," only "survived K revisions";
- *failure-as-curriculum* — B's unanswerable questions direct the next revision (on held-out sets);
- *default-to-surface* at the envelope boundary.
If it can't be reduced to those, it's metaphor and gets cut.

---

## 3.7 Framework 4 — Path Irreversibility & the Trust Budget (Mihir's *Agentic Trust Protocol*)

Source: `~/projects/agentic-trust-protocol` — paper *"Two-Way Doors, One-Way Trajectories: A
Compositional Account of LLM Agent Safety"* (`docs/paper/draft.md`), `docs/formal-model.md`,
`docs/failure-catalog.md`, `STATUS.md`. This is the framework that makes §4 concrete.

**The load-bearing theorem.** Per-action irreversibility `I(w) ∈ [0,1]` is distinct from **path
irreversibility** `I*(π, W₀)`. *A series of two-way doors composes into a one-way door whenever
the world moves between steps* — `I*(π)` can equal 1 even when every `I(aᵢ) < 1`. **The visibility
asymmetry:** a single forward pass is *structurally* incapable of computing `I*` — it cannot see
undecided future actions, the session-start state `W₀`, or counterfactual reversal trajectories.
This is an input-availability argument, not a model-quality argument: *better models do not fix
it.* (This is the paper's foundation, and it is a priori — it needs no experiment.)

**Four composition modes** (the failure catalog), and the Daftari loop-failure each maps to:
- **Accumulation** — too many doors before retreat is feasible → the **consolidation storm** (many
  small curation writes compound).
- **Premise** — subsequent doors are one-way given a wrong premise → a pass acts on a
  wrong-but-asserted edge; later passes condition on it.
- **Classification** — a one-way door misjudged as two-way → `merge` treated as cheap.
- **Iteration** — a locally-reversible loop exits the recoverable region → **C re-triggers itself.**

**THE TWO-GATE SPLIT (this is what the paper buys us — see §5.2).** The paper's `A₃` result is the
sharpest finding for us: the airlock did *worse* than naive because the "propose comprehensively,
gate later" pattern *reached higher-blast action types the naive baseline never got to*, and the
budget waved it through (3 × 0.9 = 2.7 < B₀ = 3.0). **The budget gates path *shape* (count,
audience, action-type), never content *veracity*.** Therefore two non-substitutable gates, catching
disjoint failure modes:

1. **Strength / independence gate (§3.5, Q1–Q4)** — the *only* defense against **premise-wrong-as-
   fact** (`A₃`). If re-derivations are *correlated* (share the wrong premise), strength climbs AND
   the budget passes it — `A₃` at the graph level. This is why Q3's "blind + varied axis"
   independence is load-bearing, not hygiene: the budget *cannot* supply this defense.
2. **Trust-budget gate (§4)** — the *only* defense against **accumulation + iteration**, which no
   single strong pass can see (the visibility asymmetry). `Σ I(aᵢ)` under-estimates `I*`, so the
   budget gates *early* = the correct error direction (conservative by construction).

**The justification shift (Daftari-specific — load-bearing, [HYPOTHESIS]).** The paper's budget is
motivated by *irreversibility* (you can't un-send an email). Daftari is git-backed + never-delete,
so *mechanical* reversal is free and that motivation **evaporates.** What remains is the *other*
justification — **reviewer comprehension load** (the Envelope essay, §2: "assessment requires
comprehension; comprehension requires time"). So in Daftari **the trust budget bounds epistemic
coherence-restoration cost + reviewer comprehension load, not irreversibility.** The metric ports;
its justification changes — which fuses the *Trust Protocol* and the *Envelope* essays, because
Daftari removes the one variable (irreversibility) that distinguished them. See §6.1 for why this
makes the consolidation loop a clean *ablation* the email setup could not run.

**Visibility × Enforcement (the paper's §7.9 — resolves our autonomy/fatigue question).** Four
cells: *Naive* (neither), *Hard-Gate* (enforcement, no visibility — safety floor, doesn't use the
model's reasoning to avoid the gate), *Prompted-Budget* (visibility, no enforcement — *"necessary
but insufficient,"* same accumulation failures), and **Synergy** (both — the pass *sees its
remaining budget before the gate fires* and self-limits). **Target = Synergy.** This is the answer
to "pure-advisory has the fatigue issue": the fix is not removing the gate (Naive) nor pure
surfacing (Prompted-Budget, insufficient) — it is a hard budget the pass can see, so it stops on
its own and the human is rarely interrupted. The paper's §6.8 corroborates: the architecture is
*cheaper, not more expensive* (read-path clarification short-circuits multi-step chains).

**Premise-freshness is mandatory and already in Daftari.** The paper's `B₁` narrative: the airlock
*fell into a trap naive caught* until premise-validity + information-sufficiency were *explicitly*
added to the read-path prompt. Daftari's `vault_read` already returns a **decay assessment +
validation report** — that is the premise-freshness hook; wire it into the pass's read path
(satisfies §4's provenance-required + tension-respect invariants from existing machinery).

**Compensation / Saga = v2.** The architecture is *preventive only* (gates before firing); the
paper defers compensating transactions (Saga; semantic, time-decaying; the compensator itself
consumes budget) to its paper 2. Daftari's advantage: `git revert` is a *genuine* compensator, not
the lossy "un-inform a recipient." But the epistemic-irreversibility point survives — reverting
pass 1 after pass 2 conditioned on it requires unwinding pass 2 (the Saga *combined-transaction*
problem). **v1 = preventive (budget + staging). v2 = compensation-aware multi-pass rollback.**

---

## 4. The envelope (the airlock, made concrete)

The envelope is the **airlock**: a read path that *proposes*, a staging area that *holds*, and a
write path that *gates*. It is a **small, opinionated, pre-declared policy over interventions** —
the human ratifies the policy once (policy-time), the pass acts within it, and surfaces at the
boundary. It has two parts: **invariants** (the premise/veracity gates) and a **trust budget** (the
accumulation gate). Per §3.7 these are non-substitutable.

**Part 1 — Invariants (the "small opinionated set" — to be finalized in the spec):**
- **Never-delete.** Curation never reaps. Deprecate/supersede/annotate only. (Existing charter.)
- **Provenance-required.** No `do()` on a doc whose provenance/derivation is unknown or broken.
- **Premise-freshness.** Read `vault_read`'s decay/validation report into the pass's read path
  (the `B₁` lesson — without an explicit freshness hook the loop walks into traps a naive pass
  catches). Stale/decayed premise → surface, don't act.
- **Tension-respect.** No auto-action on a doc touched by an *unresolved* tension; surface instead.
- **Never-optimize-the-measure.** No intervention whose justification is "this should raise B."

**Part 2 — The trust budget (the accumulation gate, ported from §3.7's formal model):**
A monotonically-decreasing per-consolidation-session scalar `Bₜ`. Each approved `do()` deducts its
irreversibility weight `I`. When `Bₜ < I(next)`, the pass **checkpoints → surfaces** (does not
auto-write). In **Synergy** mode the pass *sees* `Bₜ` and self-limits before the gate fires. The
budget bounds *comprehension/coherence load* (§3.7 justification shift), not literal reversibility.

**The Daftari irreversibility table (`I`), ported from the paper's §4.5 [HYPOTHESIS — calibrate
later via B, see §6]:**

| Daftari `do()` | Base `I` | Blast scaling |
|---|---|---|
| read / search / lint | 0.0 | — |
| annotate / `tension_log` | 0.1 | — |
| `link` (add edge) | 0.2 | downstream-conditioning count |
| `promote` / `deprecate` | 0.6 | downstream-conditioning count |
| `supersede` | 0.7 | downstream-conditioning count |
| **`merge`** | **1.0** | — (always staged, any strength) |

**Blast radius = an `I`-weight, not a standalone count.** It is the paper's audience-scaling with
"recipients" → **count of downstream edges/docs that condition on this one** (the recompute wave).
`I = min(I_base + k·(blast − 1), 1.0)`. A `do()` over a strong edge with a *large* downstream wave
still costs more budget → surfaces sooner. (Closes §4's old open question about what "blast radius"
means for a knowledge intervention.)

**Strength-gated autonomy ladder (Q5, corrected — see §5.2):** an action auto-writes only if **both
gates pass** — the edge is strength-earned (Q1–Q4) *and* the budget can absorb its `I`. v1 caps the
auto-write tier at low-`I` ops; `merge` and any contested edge always stage regardless of strength
(the `A₃` lesson: the gate meant to catch high-blast can be the thing that *reaches* it).

---

## 5. KEYSTONE OPEN QUESTION — declared vs. inferred dependency graph

C ("when Y changes, re-curate its dependents") needs a dependency graph. Everything downstream
(what `do()` propagates where, how the envelope gates blast radius) hangs on this. Two poles:

### Pole 1 — DECLARED (introduce explicit `derives_from` / `depends_on` frontmatter edges)

**Pros**
- **Causally honest.** Pearl's foundational claim: *you cannot infer causation from association.*
  Causal graphs come from domain knowledge/assumptions, not from data. A declared edge is a real
  causal claim by someone who knows. Inferring dependency from co-occurrence is Rung 1 cosplaying
  as Rung 2 — the original sin.
- **Precision.** C triggers only on real dependencies → no spurious re-curation storms.
- **Directionality.** `derives_from` is directed (X←Y), giving a proper DAG with parent/child —
  needed for propagation direction. Links/tensions are direction-ambiguous.
- **Auditable & plain-text.** Greppable, git-tracked, human-readable — fits Daftari's ethos.

**Cons**
- **It reintroduces the exact problem Daftari exists to kill.** Static declared metadata that
  humans must maintain goes stale — *"AGENTS.md gives static context that nobody updates."* A
  `derives_from` field authors forget to update is a *lying* causal graph. Self-undermining.
- **Cold-start / coverage.** Existing docs have no edges; the graph is empty until back-filled.
- **Who declares?** Human-declares → overload (the problem the envelope is dodging). Agent-declares
  at write-time → that's *inference*, just eager and frozen — and an agent-asserted `derives_from`
  is **hallucinated intent waiting to happen** (a confident, wrong dependency claim).
- **Schema surface.** New relation to spec/validate/render/migrate.

### Pole 2 — INFERRED (compute from `sources` + links + `superseded_by` + tension)

**Pros**
- **Zero maintenance burden; never stale-by-omission.** Recomputed from current vault state.
- **Works on the existing vault immediately;** no back-fill.
- **Mostly already built.** `vault_tension_blast` + the subgraph walker already traverse this graph.
- **Honest about uncertainty** — an inferred edge is explicitly a *hypothesis*, which invites a
  conservative envelope (surface, don't auto-act, on weak inferences).

**Cons**
- **Rung 1 pretending to be Rung 2** — confusing correlation for causation, the cardinal sin.
- **The existing edges are the WRONG edges for causal dependency** (verified during Task 3 of the
  B build):
  - `sources` are **external citation slugs**, not in-vault paths → they don't connect docs at all.
  - `superseded_by` is a **replacement** relation (old→new) — closest to causal succession, but narrow.
  - a **tension is a contradiction, not a dependency** — arguably the *opposite* of derivation.
  - in-vault markdown links are **sparse and vague** (a "see also" is not a derivation).
  → an inferred graph would be **low-recall** (misses real deps) AND **low-precision** (links that
  aren't deps). You'd be inferring the wrong thing well.
- **Spurious triggers / direction ambiguity** → wasted passes, drift if the envelope is loose.

### The synthesis being argued (see §5.1 in the live discussion / my recommendation)

The binary is false, and the causal frame dissolves it:

1. **Pure-inferred is disqualified for the causal role** — not because inference is bad, but
   because the *existing signals are the wrong edges*. You'd reliably infer the wrong thing.
2. **Pure-declared reintroduces AGENTS.md rot,** and agent-declared edges are hallucinated-intent.
3. **Resolution: inference PROPOSES, the envelope/eval RATIFIES, the loop RE-VALIDATES.** The
   dependency graph is *itself* subject to the envelope-bounded loop:
   - The agent infers *candidate* `derives_from` edges from **content** (not just links) — "this
     doc's claim restates/extends/depends-on that doc's claim." That's a Rung-1 *seeing*.
   - A candidate becomes a *trigger-bearing causal edge* only when it passes an **envelope gate**
     (provenance check; human ratification OR high-confidence-with-reversibility). That promotion
     is a Rung-2 *doing*.
   - Declared edges are **continuously re-validated** — an edge whose underlying claim was removed
     gets flagged stale, exactly like a tension.
   - **This is elegant and load-bearing:** you do not get to *assume* the DAG. Establishing the
     DAG is part of the work — which is *precisely Pearl's point* (the causal structure is the
     hard-won part, not the estimation).
4. **The decision is COUPLED to the envelope's autonomy level, not independent of it.** If C only
   *surfaces* ("these dependents might be stale — look") rather than auto-acting, then an imprecise
   *inferred* graph is tolerable for v1, because the cost of a false trigger is just "a human
   glances at a doc that was fine." High-autonomy C (auto-act) demands declared/ratified edges.
   → **Decide the envelope's autonomy first; the required graph fidelity follows.**

**Recommended v1 stance (to stress-test):** start C **surface-only** on a **content-inferred**
candidate graph (not the wrong existing edges); let high-confidence, ratified edges *graduate* to
trigger-bearing as they prove out; never auto-act on an unratified inferred edge. Earn autonomy;
don't assume it.

### 5.2 The keystone, fully resolved — two gates, not one (locked)

§3.5 retired the declared-vs-inferred binary (trust = survived independent re-derivations, not how
an edge was born). §3.7's `A₃` result completes the resolution by showing **strength alone is not
enough** — and *why*. The strength model and the trust budget are **two non-substitutable gates
catching disjoint failure modes:**

- **Strength / independence** (Q1–Q4) catches **premise-wrong-as-fact** (`A₃`) — content veracity.
- **Trust budget** (§4) catches **accumulation + iteration** — path shape, which the visibility
  asymmetry proves no single pass can see.

An edge earns autonomy only when **both** clear. This is the empirical (not aesthetic) justification
for the split, and it makes Q3's independence requirement load-bearing: correlated re-derivations
defeat *both* gates at once (strength inflates, budget passes), reproducing `A₃` on the graph.

**Strength model, locked (Q1–Q4):**
- **Q1 — unit:** strength lives on **edges** (PageRank analogy: earned from structure, not declared).
- **Q2 — accrual:** **flat count of independent re-derivations** (cap K), **recomputed from the
  provenance trail** (not a mutable counter), schema kept weight-ready for future recursive/PageRank
  weighting. *Caveat:* literal PageRank over the *link* topology is Rung-1-as-Rung-2 poison — any
  weighting must run over the **re-derivation graph**, not the link graph.
- **Q3 — independence:** **blind** (a pass never sees the edge's prior existence/strength) **+ ≥1
  varied axis per vote** (prompt framing / input neighborhood / model), recording *which* axis
  varied. Tighten to enforced model-diversity later if single-model votes prove correlated.
- **Q4 — decay:** a **case-2 contradiction** (re-derivation fails with *no* upstream change) =
  **contest-and-revoke** — drop the edge below trigger-authority + log a `tension` (surface, don't
  silently decrement). A **case-1 failure** (re-derivation fails *because* an endpoint changed) is
  **C's trigger**, not a penalty. **(REVISED — see §5.3.1: strength also *ages* with
  time-since-re-derivation, to make entrenchment structurally impossible.)**
- **Q5 — autonomy:** **Synergy** (§3.7) — strength-gated envelope auto-write that the pass can see;
  behaves like surface/propose at cold-start (empty ledger) and graduates itself out of fatigue.

---

## 5.3 The scheduler (Component C) — the spaced-repetition layer

C decides **what to re-derive, when**, under a scarce **compute budget** — distinct from §4's
write/trust budget. Re-derivation is read-path (`I = 0` on the *write* gate) but consumes LLM calls,
so it needs its own per-session cap. Two clocks: the **event clock** (a `do()` on Y forces
dependents due) and the **decay clock** (the forgetting curve). Decisions made (scheduler C-Q1..C-Q4):

- **C-Q1 — interval model: strength-scaled + max-interval backstop.** Review interval is a function
  of an edge's (aged) strength — well-consolidated edges reviewed rarely, fragile ones soon (the
  spacing economy). A strength-independent **max-interval cap** guarantees even the strongest edge is
  re-derived at least every N (growth-mindset "nothing is permanently trusted"; defense against
  silent rot given v1's low-recall dependency graph, §5).
- **C-Q2 — event-blast: compounding-attenuated.** When Y changes, the "due now" wave propagates but
  **attenuates by path strength** (∏ of edge strengths along the path from Y) and dies where
  compounded reliability drops below a floor — the causal blast reaches exactly as far as the signal
  survives the hops (the ATP path-irreversibility insight on the *trigger* side; third use of the
  ∏-path-strength primitive). Implemented as `vault_tension_blast` + a path-strength stop condition.
  Not 1-hop (misses transitive rot); not full-closure (the re-curation storm, §5).
- **C-Q3 — priority: three tiers under the compute budget.** When more is due than budget allows:
  (1) **backstop-overdue** edges (non-negotiable — see the guarantee in §5.3.1); (2) **event-
  triggered** items (a real change is stronger staleness evidence than time); (3) **decay-triggered**
  items. Within each tier, rank by fragility×blast ≈ `(1 − strength/K) × downstream-conditioning`.
  Operationalizes §6's confounder (causal trigger outranks mere time).
- **C-Q4 — stop condition: drain-under-ceiling, self-triggers deferred.** A session drains the
  prioritized due-queue until empty *or* the compute budget is hit. **Writes produced this session do
  NOT re-trigger the event clock within the session** — self-generated staleness queues for the
  *next* session. This terminates by construction (finite, non-replenishing queue), bounds the ATP
  **iteration mode** (the loop can't feed itself), AND enforces Q3-independence: re-deriving your own
  just-written edge in the same sitting is **cramming** (correlated, weak) — the inter-session gap
  *is* what makes the next re-derivation an independent vote. Iteration-safety and anti-cramming are
  the same rule.

### 5.3.1 Strength dynamics, revised (reopens strength-Q4) — entrenchment is the ratchet to kill

**The longitudinal hazard:** C-Q1 (interval scales with strength) × the original strength-Q4
(strength changes *only* on re-derivation outcome) **= entrenchment.** A strong edge is reviewed
least → has the fewest chances to be contested → stays strong almost regardless of continued truth.
The schedule protects an edge from the re-derivation that could falsify it — rich-get-richer, the
**fixed-mindset cortex manufactured by the scheduler itself** (contra §3.6). Fix = two mechanisms so
entrenchment is *structurally impossible*, not merely discouraged:

- **(a) Backstop-as-guarantee, not priority.** Reserve a slice of each session's compute budget for
  backstop-overdue edges (or let a backstop-overdue edge *force* a session). Makes C-Q1's cap real
  even in busy sessions.
- **(b) Strength aging (NEW — the strength-Q4 reopen).** Strength **decays gently with
  time-since-last-re-derivation.** This is NOT the silent-arithmetic contradiction-penalty rejected
  in the original Q4 (that was about *failed* re-derivations). Aging asserts nothing about
  correctness — only that the last verification is old, so confidence is provisional again. It is
  **observable** (the interval shrinks → the edge surfaces as due sooner), **reversible** (a survived
  re-derivation restores it), and it is the **forgetting curve made mechanical** = growth-mindset as
  a scheduling law: nothing stays "known" without re-test. Aging caps how long an interval can grow
  for an un-retested edge → entrenchment cannot occur.

**Revised strength model (supersedes §5.2 strength-Q4):**
- survive independent re-derivation → strength += 1 (cap K)
- **age:** strength decays slowly with time since last re-derivation (gentle; surfaces as due-sooner;
  not a contradiction)
- contest (case-2: fails, *no* upstream change) → contest-and-revoke + log tension
- upstream change (case-1) → C's trigger; mark due; no penalty
- interval = f(current *aged* strength), hard-capped by the max-interval backstop (guaranteed via
  reserved budget per (a))

### 5.3.2 Longitudinal / budget-drift hazards (the combined-budget question)

Stacked budgets (write/trust §4, compute §5.3, intervals C-Q1, priority C-Q3) interact over time to
produce **ratchets** — monotonic drift invisible at the per-session level:

1. **Strength entrenchment** — addressed structurally by §5.3.1 (a)+(b).
2. **Periphery starvation** — low-blast edges are perpetually deprioritized (low blast →
   deprioritized → never re-derived → strength stays low → always due → still low blast …). A
   well-consolidated core beside a silently rotting periphery. Mitigated by §5.3.1(a) + the B
   coverage instrumentation (§6); **not yet fully solved** — open decision.
3. **Action-mix drift toward cheap writes** [HYPOTHESIS — weaker] — persistent write-budget pressure
   could bias the loop toward cheap `link` ops over expensive-but-correct `deprecate`/`merge`. ATP
   found no within-session "Structural Gaming" at N=10, but the longitudinal version isn't ruled out,
   and link-inflation feeds the link graph (PageRank-poison adjacency, C-Q2).

**These are second-order Goodhart:** nobody games B directly (forbidden, §3), but the *budget
structure* produces drift B-as-quality cannot perceive — B would report health *during* decay.
Therefore B must be instrumented for **coverage/equity, not just quality** (see §6).

---

## 6. The hard problem — identification (and what B should actually measure)

**What B measures, corrected (from §3.7's empirical headline).** The *Agentic Trust Protocol*
paper's cleanest signal is **variance reduction, not mean** (naive write-count std up to 2.9 vs
airlock < 1.0; *"a deployer who needs a worst-case guarantee gets one from the architecture"*).
So Component B, applied to the loop, should **not** headline "did N=2 move the quality number." It
should show **the envelope bounds worst-case drift** — the variance/tail of cortex quality across
runs, not just the mean delta. This is more honest and better-supported by the analogous data.

**B must also measure coverage/equity, not only quality (the budget-drift requirement, §5.3.2).**
The stacked budgets produce ratchets (entrenchment, periphery starvation) that leave *central*
traversal quality looking fine while the vault drifts — B-as-quality would report health *during*
decay (second-order Goodhart). So B (or a sibling monitor) must track, across sessions:
- **strength distribution over time** — is variance widening (core strengthening while periphery
  flatlines)?
- **backstop-overdue count** — how many edges are past their guaranteed review and still unserved?
- **action-mix drift** — is the `do()` mix creeping toward cheap `link` ops over `deprecate`/`merge`?
These instrument the never-optimize-the-measure invariant in a new way: B must measure what the
budgets can break, or the budgets break it blind.

### 6.1 Open empirical question — the consolidation loop as the comprehension-load ablation

The §3.7 justification shift is a [HYPOTHESIS] the email paper **cannot test**: in email,
irreversibility and comprehension-load are *confounded* (every `send` is both hard to undo and hard
to review). Daftari git-zeroes the irreversibility variable, leaving comprehension-load standing
alone. **If a trust budget still improves curation quality/variance in a domain where nothing is
irreversible, that isolates comprehension-load as the active ingredient** — a result the email setup
gestures at but cannot reach. The loop is therefore not just a consumer of the metric; it is the
ablation that decouples the two justifications, and a genuine contribution back to the trust-protocol
line. *Kill condition for the justification shift:* if the budget shows no effect on quality/variance
in Daftari, then comprehension-load was *not* the active ingredient and the budget was riding on
irreversibility all along — in which case it has no role in a git-backed never-delete vault.

### 6.2 The remaining identification problems

Causal framing is the right spine, but a knowledge vault gives little to *identify* the graph with.
The spec must be honest about identifiable vs. aspirational:

- **No RCT.** You can't A/B the same vault. The counterfactual "score without this pass" is not
  directly observable.
- **Latent causal edges.** The real derivation structure is not fully encoded (see §5 cons).
- **Confounders.** A doc goes "stale" both because a dependency changed (causal) *and* because time
  passed (TTL/decay). Disentangling matters.
- **The defense already exists.** The B spec's "rotating/fresh seeds + held-out human-judged
  question set" (its Goodhart guard, §5.1/§13) is *exactly* the causal-inference move to get an
  unconfounded estimate of a pass's effect. The loop spec should lean on it: validate A's effect on
  a **held-out** question set, never the one being optimized.

---

## 7. Non-negotiables / charter constraints

- **Stays cortex, not a write-surface/compiler.** The prior brainstorm explicitly rejected
  compile-as-write; this loop sharpens the cortex, it does not produce derived "compiled" docs.
- **Advisory, reconceived** (see §2): human sets the envelope; agent acts within it; surfaces
  outside it.
- **Never auto-delete.** Git + provenance are the reversibility substrate.
- **B is monitor, never target.**
- **"Component A is the danger zone"** (prior threat-model note): outcome-driven mutation
  (poisoning) and metaphor-driven design (fluff) would first appear here. The envelope + the
  never-optimize-the-measure invariant are the defenses.

---

## 8. Open decisions for the spec (in rough dependency order)

**RESOLVED this session:**
- ~~Envelope autonomy level for C~~ → **Synergy** (§3.7, §5.2 Q5): strength-gated, budget-bounded,
  budget-visible to the pass. Not a single dial — graduated per-edge by strength.
- ~~Envelope "confidence" + "blast radius"~~ → strength (Q1–Q4) is confidence; **blast radius = an
  `I`-weight = downstream-conditioning count** (§4 table).
- ~~Strength model~~ → Q1–Q4 locked (§5.2).

**Still open:**
1. **Declared vs. inferred graph** (§5) — "inference proposes / envelope ratifies / loop
   re-validates." Pin the v1 cut (recommended: content-inferred candidate graph + surface-only C).
2. **Edge typing** — which relations are causal-derivation vs. contradiction vs. reference, and how
   each *triggers* (a new tension should re-examine; a supersede should propagate; a "see also"
   should do neither).
3. **`I`-table calibration** (§4) — finalize per-`do()` `I`, the blast-scaling constant `k`, and
   `B₀` per session. Calibrate empirically via B (the paper's `B₀ = 3.0` was re-tuned after `B₁`).
4. **A's permitted `do()` set** — promote / deprecate / link in v1; `merge` always-staged (out of
   v1 auto-write); contested edges always-staged.
5. **The multi-pass mechanic** — each pass reads the *prior* pass's annotations/tensions, not raw
   docs ("sleep loops"; arXiv 2605.26099 / 2605.08538), under blind+varied independence (Q3). Define
   a pass's input/output and the stop condition (fixpoint? N passes? budget-exhaustion? K reached?).
6. **Effect estimation** (§6) — held-out question set; attribute a *variance*/tail delta (not just
   mean) to a pass; run the §6.1 comprehension-load ablation.
7. ~~The scheduler (C) / forgetting curve~~ → **RESOLVED** (§5.3): strength-scaled intervals +
   max-interval backstop (C-Q1); compounding-attenuated event-blast (C-Q2); three-tier priority under
   a compute budget (C-Q3); drain-under-ceiling with self-triggers deferred (C-Q4). Strength model
   revised to add **aging** + **backstop-as-guarantee** (§5.3.1) to kill entrenchment.

**Newly open (from the scheduler / longitudinal pass):**
8. **Compute-budget calibration** — per-session re-derivation cap; the reserved backstop slice; the
   aging rate and interval function `f(strength)`. Calibrate via B.
9. **Periphery starvation — full fix** (§5.3.2 #2). Backstop-guarantee + coverage instrumentation
   *mitigate* but don't *solve* it. Open: a fairness floor in priority? round-robin reserve?
10. **B coverage/equity instrumentation** (§6) — strength-distribution drift, backstop-overdue count,
    action-mix drift. Required so budget-drift ratchets are *visible*.

---

## 9. Next step

Resolve open decision #1 (envelope autonomy for C), then #2, then draft the actual spec via the
brainstorming → writing-plans flow. The spec lands at
`docs/superpowers/specs/YYYY-MM-DD-cortex-consolidation-loop-design.md` and supersedes this
direction doc.

## Appendix — connections to existing machinery & prior thinking

- `vault_tension_blast` / `vault_tension_clusters` — C's trigger engine (forward-pointed blast).
- The subgraph dependency walker (B's `src/eval/subgraph.ts`) — already types tension/supersede/
  link/sources edges; the place where "the existing edges are the wrong edges" was discovered.
- `vault_provenance` — the provenance substrate the envelope's provenance-invariant reads.
- Prior framing memory: `project_offline_curation_passes_framing.md` ("Component A is the danger
  zone"); the cortex-vs-compile decision.
- Mihir's blog corpus as design DNA: *Hallucinated Intent & the Envelope Problem* (the envelope),
  *The Inference Trap* / *The Clean Data Trap* (correlation≠truth), *Trust Is a Ledger, Not a
  Feeling* (reversibility/audit over feelings).
- **Mihir's *Agentic Trust Protocol* paper** — the formal spine for §3.7/§4: path irreversibility
  `I*`, the visibility asymmetry, the four composition modes, the trust budget, the irreversibility
  table, the Visibility×Enforcement 2×2, and the `A₃` finding that grounds the two-gate split. This
  design leans on the paper's *argument* (the visibility-asymmetry / two-gate structure), not its
  effect sizes.
