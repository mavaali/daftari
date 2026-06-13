# Rigorous Long-Term Memory — Landscape Research (Pearl-ladder rubric)

> Deep-research run 2026-06-13 (`wn4v5dj3v`): 5 angles → 20 sources → 93 claims →
> 25 adversarially verified (21 confirmed / 4 killed) → 8 synthesized findings.
> Hypothesis tested: *"No one is doing rigorous (Rung-2/Rung-3) long-term memory."*
> Rubric: Pearl's causal ladder — Rung 1 association (store/retrieve), Rung 2
> intervention (consolidation/contestation/earned-trust/forgetting-as-policy),
> Rung 3 counterfactual (would a stored claim survive independent re-derivation?).

## Verdict: NARROWED (strong form refuted, defensible core survives)

The blanket claim is **false** — several credible systems do genuine Rung-2
structural intervention. But three narrowings keep a real, defensible gap.

### Rung × mental-model matrix [DATA unless noted]

| | Rung 1 (assoc.) | Rung 2 (intervention) | Rung 3 (counterfactual) |
|---|---|---|---|
| **Individual / agent** | Mem0 V3 (3 parallel assoc. scores; graph layer *removed*), ChatGPT/Claude memory, personal RAG | **Zep/Graphiti** (LLM contradiction → bi-temporal edge invalidation; "new info wins"); **SmartVector** (cron ConsolidationAgent + Ebbinghaus confidence decay + provenance ripple edges); MemoryBank (decay), MaRS (6 forgetting policies) | **— empty —** |
| **Institutional** | **Glean** (entity prominence from co-occurrence/usage; trust/provenance edge-props *with no described mechanism*), Notion Enterprise Search (cross-source RAG + citations) | **ElephantBroker** (9-stage idle "sleep" consolidation + 4-state earned-trust verification biasing retrieval) | **— empty —** |

### The three narrowings (= Daftari's actual real estate)

1. **Rung 3 is entirely empty.** [DATA] No surveyed system tests counterfactual
   re-derivation. The strongest trust mechanisms are *accumulated typed evidence
   + supervisor sign-off* (ElephantBroker), *fixed new-info-wins* (Zep), *declared
   metadata* (Glean), or *cryptographic authenticity* (Wright/Merkle — proves WHO
   said it, not whether it's true). None ask "would this survive independent
   re-derivation?" → Daftari's `strength = survived independent re-derivations`
   (design §3.5) + the §6.1 ablation is unoccupied ground.
2. **The mass market is still Rung 1.** [DATA] Every shipping commercial product
   (Mem0 V3, Glean, Notion, by extension ChatGPT/Claude memory) is association-only.
   Rung-2 lives almost entirely in 2026 research preprints. Notably, **Mem0 V3
   REMOVED its graph layer** (regression toward Rung 1) — a signal Rung-2 may not
   pay off commercially (see threats).
3. **Mechanism ≠ efficacy.** [DATA] The Rung-2 counterexamples (SmartVector,
   ElephantBroker, MaRS) are largely single-author / non-peer-reviewed preprints
   validated by *correctness tests or synthetic benchmarks* — NOT empirical
   before/after proof that consolidation/earned-trust improves memory outcomes.
   **No one has shown the rigor pays off.** → The §6.1 comprehension-load /
   variance-reduction ablation is the proof nobody has run.

**No Rung-2 system combines all four rigorous-cortex properties** (consolidation
loop + earned-trust edges + envelope governance + forgetting-as-scheduling) AND
validates them. That integrated+validated configuration is the genuinely
unoccupied gap. [DATA/HYPOTHESIS]

## Strongest counterexamples — honest prior art

- **ElephantBroker** (arXiv 2603.25097, Lupascu & Lupascu, Mar 2026; open-source
  Neo4j+Qdrant+Cognee, 2,200-test suite) — **the closest competitor, institutional
  side.** Nine-stage "sleep" consolidation (cluster near-dups cos≥0.92, canonicalize
  by majority vote, decay unused `c·0.9^tr`, promote episodic→semantic) + a
  four-state earned-trust ladder (Unverified→Self-Supported→Tool-Supported→
  Supervisor-Verified) that biases retrieval via confidence multipliers
  (1.0/0.9/0.7/0.5). **The precise line vs Daftari:** ElephantBroker earns trust by
  *accumulation + supervisor verification* (Rung 2); Daftari earns it by *survived
  independent re-derivation* (Rung 3). No envelope/budget governance; no human-model
  writeback; validated by a correctness suite, not an efficacy study. **Read it
  directly before any paper.**
- **Zep/Graphiti** (arXiv 2501.13956) — thin Rung-2: bi-temporal invalidation,
  contradiction-detection via LLM, but resolution is a fixed "new info wins" rule,
  edges tagged-not-forgotten, no earned trust, no re-derivation.
- **SmartVector** (arXiv 2604.20598) — strongest *individual*-side Rung-2:
  cron consolidation, Ebbinghaus decay, provenance ripple edges. Single-author v1
  preprint; don't lean on its 62%-vs-31% numbers.

## Threats to the thesis (sit with these)

- **Market is fleeing Rung-2.** [DATA] Mem0 V3 ripped out its graph layer. Open
  question: is association-retrieval a *stable commercial equilibrium* because Rung-2
  adds latency/cost without user-visible benefit? If rigor doesn't pay, the vision's
  ROI is unproven — and the §6.1 efficacy result could come back negative (its own
  stated kill condition). The honest stakes: nobody has proven Rung-2/3 *worthless*
  either — "no proven ROI yet" ≠ "proven no ROI." Daftari's contribution could be
  the first proof in either direction.
- **Don't overclaim.** The strong "nobody does rigorous LTM" is checkable and false.
  A paper must claim only the three narrowings (Rung-3 empty / mass-market Rung-1 /
  mechanism-not-efficacy), or it desk-rejects.

## What nobody is building (the deepest open ground) [HYPOTHESIS]

Every surveyed system consolidates the *machine's* memory for better *retrieval*.
None frame the loop as forcing *human* mental-model revision (the writeback loop /
"cortex re-surfaces → you re-derive → you rewrite the shared interpretation"). The
thinking-partner-that-makes-you-revise telos is absent because everyone is building
better RAG, not a co-evolving cortex. The whole commercial field is building a
better *Star Trek ship's computer* (omniscient retrieval oracle); Daftari is the
computer that admits it isn't omniscient.

## Sources (primary)

mem0.ai/blog/state-of-ai-agent-memory-2026 · arxiv 2501.13956 (Zep) · glean.com/blog/knowledge-graph-agentic-engine ·
arxiv 2604.20598 (SmartVector) · arxiv 2603.25097 (ElephantBroker) · arxiv 2512.12856 (MaRS/FiFA) ·
arxiv 2603.07670 (agent-memory survey) · arxiv 2506.13246 (Wright/Merkle) · arxiv 2305.10250 (MemoryBank) ·
notion.com/help/enterprise-search · github.com/Shichun-Liu/Agent-Memory-Paper-List

Full verified-claim record + verification votes: deep-research run `wn4v5dj3v`.

---

# ElephantBroker teardown (the closest competitor)

Source: arXiv 2603.25097, "ElephantBroker: A Knowledge-Grounded Cognitive Runtime
for Trustworthy AI Agents" (Lupascu & Lupascu, 26 Mar 2026; open-source,
Neo4j+Qdrant+Cognee). Fetched + read 2026-06-13. [DATA] unless marked.

## Dimension map

| Axis | ElephantBroker | Daftari | Edge |
|---|---|---|---|
| Trust earned by | Evidence **accumulation**: Unverified 0.5 → Self-Supported 0.7 → Tool-Supported 0.9 → Supervisor-Verified 1.0 (human sign-off); highest evidence type present wins | **Survived independent re-derivations** (blind + varied axis), aged on a curve | Daftari (the one moat) |
| Consolidation reinforcement | `c′ = min(c + s/u·0.3, 1)` — strengthen by **successful-use ratio** (usage) | strength moves only on independent re-derivation; **usage irrelevant** | Daftari (EB's formula is the Goodhart Daftari forbids) |
| Contradiction | **Resolves**: canonicalize cluster by majority vote, blacklist, archive <0.1 | **Preserves**: contest→revoke+log tension, surface | Daftari (EB does the Pluribus move at the data layer) |
| Governance | Authority tiers (0–90+, Unix-root bypass), multi-org identity, safety firewall/guards | Envelope: strength + **accumulation trust-budget**, human-sets-policy/surface-at-boundary | Split (EB richer on access; Daftari unique on accumulation gate) |
| Sleep/idle consolidation | 9 stages, **shipped** | A+C loop, **specced, 0/6 built** | EB (it exists) |
| Forgetting curve | `c·0.9^tr`, `c·0.95^td`, exp recency | `0.5^(age/90)` | Tie (neither novel) |
| Re-derivation / Rung 3 | **None** — verification is highest-priority evidence type attached | strength-by-re-derivation | Daftari (empty ground) |
| Efficacy proof | None — 2,200 **correctness** tests, no baseline | None built; §6.1 ablation designed to produce it | Tie now, Daftari's to take |
| Human-model writeback | None — consolidates for retrieval quality | the loop's telos | Daftari |
| Maturity | open-source, integrated, firewall, procedure-learning, salience EMA | substrate shipped, loop a spec | **EB, clearly** |

## What actually differentiates Daftari (narrow)

Not consolidation, forgetting, provenance, or trust-scoring — EB ships all four. It
collapses to **one axis: trust earned by independent re-derivation (Rung 3) vs.
evidence-accumulation (Rung 2)**, plus two consequences: (1) EB's `c + s/u·0.3`
reinforcement IS the usage/popularity Goodhart Daftari's §5.2 Q2 forbids — EB is a
worked counter-example of the failure mode; (2) EB canonicalizes-by-majority-vote,
Daftari keeps tensions live.

**Correction to avoid overclaiming:** EB's Supervisor-Verified=1.0 (human sign-off)
is NOT something Daftari rejects — Daftari has the same via `vault_ratify`. The
honest line is **"Daftari = EB's evidence/ratification model PLUS a
re-derivation-earned-trust layer EB lacks,"** not "re-derivation instead of human
verification." Additive, not replacement.

## The gift

EB solves two paper-feasibility blockers: (a) a **named open-source institutional
Rung-2 baseline** to benchmark against (the "no baseline" gap), and (b) the paper's
core claim — *trust-by-re-derivation vs trust-by-accumulation: which yields
better-calibrated, lower-variance memory?* — with EB as the control and §6.1 as the
first efficacy data in the field.

---

# Pressure-test of the core bet

**The bet:** trust earned by surviving N independent re-derivations beats EB's trust
earned by accumulating evidence + human sign-off. If this fails, the moat is vapor.
Tried to kill it. [HYPOTHESIS throughout.]

## Reframe (corrects the framing, upgrades the thesis)

Re-derivation is **change-triggered** — the event clock fires it *when a premise
moves* (C-Q2). So it is re-evaluation **against new information as it arrives**, not
a static internal-coherence sweep. The objective is **currency**, not truth-tracking.
Under this frame, **strength = longitudinal robustness**: a k=5 edge has stayed
robust across 5 evaluations against a changed world. EB's Supervisor-Verified=1.0 is
**point-in-time** (verified once, sticky) and structurally cannot re-judge when the
world moves. So Daftari names a dimension — *standing-in-light-of-new-information* —
where EB has **no signal at all**. This is a cleaner moat than "better truth-tracking."

(This **withdraws** the earlier "coherence ≠ correspondence" attack: it judged
re-derivation on truth-tracking, which is the wrong axis.)

## What survives the reframe — the master variable

"Re-evaluate against new information" only has value if re-derivation weighs **real
new evidence** over the **model's priors**. Same premise-grounded-vs-prior-grounded
ratio that gates everything:

> **MASTER VARIABLE:** Does re-derivation re-evaluate against real new information,
> or re-run the model's priors dressed as fresh judgment?
> - **Information-driven** → strength is longitudinal robustness; moat strong; EB has
>   no equivalent; currency-tracking is unoccupied ground.
> - **Prior-driven** → corpus-consensus theater with a conventionality bias; EB's
>   external evidence is the better signal; **moat inverts.**

## Surviving threats

1. **Conventionality bias** (orthogonal to the reframe, survives intact): an LLM
   re-deriving a *contrarian-but-correct* institutional decision applies its priors
   and can conclude "can't reconstruct why you'd hold this" even when events vindicate
   it. So re-derivation may **under-trust the most valuable (contrarian) knowledge and
   over-trust the conventional.** Consequence: re-derivation **cannot be the sole
   trust signal** — human `vault_ratify` is the load-bearing backstop protecting
   contrarian framings. (Vindicates the two-gate design for a sharper reason than the
   spec gives.)
2. **Cost overhang**: Daftari is the *most expensive* Rung-2/3 (LLM calls per edge,
   forever) in a market that watched Mem0 rip out its graph. Quality delta must be
   large, not marginal.

## Narrowed thesis (the only defensible form)

> For **novel/interpretive institutional knowledge with no external ground truth**,
> trust-by-independent-reconstruction is the only available calibrated signal and
> tracks a dimension (longitudinal robustness under new information) that
> accumulation-based systems cannot — **provided** (1) re-derivation is
> information-driven not prior-driven, and (2) human ratify backstops contrarian
> framings against conventionality bias.

## Experiments, re-sequenced (the master variable comes first)

**§6.1 efficacy is NOT first.** Two cheaper, prior experiments gate the vision.

### Experiment #1 — Information-vs-Priors Discriminator (the master-variable test; cheapest falsifier; NO loop required)

Tests whether re-derivation reads the premises or its priors. A labeled claim set,
each with its supporting premises in the vault + a conventional/contrarian label.
Hold the model fixed; manipulate the **information** the re-deriver sees:

- **C1 Premise-grounded:** re-derive given the actual premises.
- **C2 Prior-only:** re-derive given only the claim text ("from your own knowledge,
  does this follow?"), no premises.
- **C3 Counterfactual-premise (the decisive probe):** re-derive given *flipped /
  contradictory* premises.

Metrics:
- **Information sensitivity** = verdict shift C1→C2. Low shift = prior-driven.
- **Counterfactual response (C3)** = the clean falsifier: a premise-grounded
  re-derivation MUST flip when premises are flipped. If the verdict is the **same**
  whether fed true or contradictory premises, re-derivation is ignoring the evidence
  = pure priors.
- **Axis decorrelation**: do varied axes (prompt/input-neighborhood/model) agree
  because they read the same premises (good) or share priors (bad)? Disentangle by
  checking whether agreement is *higher* in C2 (prior-only) than C1 — if so, the
  agreement is prior-driven. (This subsumes the bare "decorrelation test.")

**KILL CONDITION (whole vision):** if C3 doesn't flip the verdict — re-derivation
returns the same answer on true vs contradictory premises — the strength signal is
prior-theater and the moat inverts to EB. Cheap, decisive, runnable before the loop
is built (just the re-derivation prompt + a claim set + premise manipulation).

### Experiment #2 — Conventionality-bias test
Stratify claims by conventional vs contrarian-but-validated; measure the
false-negative rate (contrarian claims that fail re-derivation despite being
event-validated). High FN rate ⇒ ratify-backstop is mandatory; quantify how much.

### Experiment #3 — §6.1 efficacy ablation (only meaningful if #1, #2 pass)
Does the consolidation loop + budget reduce variance/tail of cortex quality (vs EB as
the Rung-2 baseline)? The first efficacy result in the field.

## Bottom line

The moat is a **knife-edge, not a wall**: it depends on the master variable
(information-vs-priors) resolving favorably, it's domain-limited to interpretive
knowledge, it has a conventionality-bias failure mode making human ratify
non-optional, and it's the priciest option in a cost-skeptical market. A legitimate,
fundable **research bet** — gated on Experiment #1, which is cheap enough to run
before almost anything else and can falsify the whole vision in a week.
