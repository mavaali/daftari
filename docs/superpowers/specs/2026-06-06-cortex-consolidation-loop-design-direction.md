# Cortex Consolidation Loop (Components A + C) — Design Direction

> **STATUS: pre-spec brainstorm synthesis.** This is NOT the validated spec. It is a
> working document that re-establishes the frameworks and captures decisions reached so a
> fresh session can resume the brainstorm cold and move to a real spec. Written 2026-06-06
> after the cortex quality metric (Component B) shipped in v1.16.0 (PR #99).

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

## 4. The envelope (working definition)

The envelope is a **small, opinionated, pre-declared policy over interventions.** Inside it, a
pass may act without per-item review; outside it, the pass stops and surfaces.

**Candidate invariants (the "small opinionated set" — to be finalized in the spec):**
- **Never-delete.** Curation never reaps. Deprecate/supersede/annotate only. (Existing charter.)
- **Provenance-required.** No `do()` on a doc whose provenance/derivation is unknown or broken.
- **Tension-respect.** No auto-action on a doc touched by an *unresolved* tension; surface instead.
- **Reversible-only.** Only interventions that git + provenance make cleanly reversible may
  auto-apply. (Daftari already auto-commits every write → git is the reversibility substrate.)
- **Never-optimize-the-measure.** No intervention whose justification is "this should raise B."
- **Confidence + blast-radius gate.** Auto-act only above a confidence threshold AND below a
  blast-radius threshold (how many downstream docs the change touches). Big blast → surface.

**Open:** what "confidence" and "blast radius" mean concretely for a *knowledge* intervention
(unlike a $-amount on a trade) — see §6.

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

---

## 6. The hard problem — identification

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

1. **Envelope autonomy level for C** (surface-only ↔ auto-act). *Everything else keys off this.*
2. **Declared vs. inferred graph** (§5) — likely "inference proposes / envelope ratifies / loop
   re-validates," but pin the v1 cut.
3. **Edge typing** — which relations are causal-derivation vs. contradiction vs. reference, and how
   each *triggers* (a new tension should re-examine; a supersede should propagate; a "see also"
   should do neither).
4. **Envelope contents** (§4) — finalize the invariants + define "confidence" and "blast radius"
   for a knowledge intervention.
5. **A's permitted `do()` set** — promote / deprecate / link / merge? merge is the scariest
   (erases distinctions); maybe out of v1.
6. **The multi-pass mechanic** — each pass reads the *prior* pass's annotations/tensions, not raw
   docs ("sleep loops"; arXiv 2605.26099 / 2605.08538). Define a pass's input/output and the stop
   condition (fixpoint? N passes? envelope-boundary-hit?).
7. **Effect estimation** (§6) — held-out question set; how to attribute a score delta to a pass.

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
