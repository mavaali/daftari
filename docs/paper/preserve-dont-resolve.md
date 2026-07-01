# Preserve, Don't Resolve: Non-Fabrication and Provenance as the Axis for Agent Memory, Across Regimes Where Recency Works and Where It Fails

**Draft, 2026-06-29.** Working draft of the two-corpus sovereignty paper. Design:
`docs/plans/2026-06-29-two-corpus-sovereignty-paper-design.md`. Status: first full pass;
related-work section needs a grounding pass before submission.

---

## Abstract

Agent memory systems are evaluated on accuracy: can the system return the current value
of a fact after a long, noisy history? We argue this is the wrong axis once a trivial
baseline already wins it, and the right axis is two guarantees a consolidating memory
sacrifices: **non-fabrication** (never asserting a current value that was not established)
and **provenance** (preserving which source governs and what it superseded). We study these
across two contamination-controlled corpora chosen as a *control and a treatment* on the
recency axis. In the **control**, formal contract amendment chains, a most-recent-
mentioning baseline is accuracy-sufficient by drafting convention (operative-amendment
idioms outnumber stale-restatement idioms >100:1), so accuracy does not separate
architectures; yet a value-minting baseline still fabricates a governing value on partial
amendments, and a recency baseline mis-attributes provenance. In the **treatment**,
Wikipedia "Current consensus" records, where recency returns a stale value on 33/33 of
its supersession traps, a memory that maintains a single consolidated current-state must
collapse a genuine, editor-certified *tension* into a false supersession; we measure this
directly. Our central finding is the **invariance**: across both regimes, the separating
axis is the same (non-fabrication + provenance), and the system that holds it is the one
whose guarantee is *structural* rather than contingent on model choice. We are explicit
about the limit: a careful, capable, abstain-prompted LLM approximates the non-fabrication
guarantee in the average case, but only by abstaining on the relations it should detect,
and without the structural guarantee an auditor needs.

---

## 1. Introduction

A memory system for an autonomous agent is usually benchmarked the way a database is: pose
a question whose answer changed over a long history, and score whether the system returns
the *current* value. This framing makes recall the figure of merit and "staying current"
the hard problem, which in turn motivates **consolidation**, periodically rewriting the
store into a compact, current summary (the "sleep" or "dreaming" pass of recent agent-
memory systems).

We make two claims against this framing. First, the consumer of the memory is an *agent*,
not a human reader, and what the agent needs is not a pre-computed answer but **structure
it can reason over**: what is current, what that rests on, and what is contested. Second,
once a system *resolves* a history into a single current value, it has discarded exactly
that structure, and the discarding is not free, because the resolution can be *wrong* in
two ways a recall metric does not see: it can **fabricate** a value that was never
established, and it can **erase provenance** (which source governs, what it superseded,
whether the matter was ever settled). We call the design that refuses to resolve
**preserve-not-resolve**, and its load-bearing invariant:

> **A tension may never masquerade as a supersession.**

A *supersession* is a settled replacement (B is now current, it replaced A on the merits).
A *tension* is an unresolved disagreement (A and B are both live; neither has won). A
consolidating memory that must store one current value has no representation for the
second, so it records the first: it lets a tension wear the clothes of a supersession.
The agent downstream then reads a confident "current value" where the truth is "contested,
status quo by default."

This paper evaluates preserve-not-resolve against consolidation across two corpora chosen
to differ on the one axis a skeptic cares about: *whether recency already solves
accuracy*. Contracts are the **control**: a trivial baseline is accuracy-sufficient, so
accuracy cannot be the contribution, which forces the honest question of what a memory owes
you when recency is already right. Wikipedia consensus records are the **treatment**:
recency genuinely returns stale values, and the corpus contains real, editor-certified
tensions. Our contribution is the **measured invariance**, that the separating axis is the
same in both regimes, and a precise account of where the guarantee is structural and where
it softens to a model-dependent behavior.

We describe the system under test (§2), the two-regime design (§3), the control and
treatment results (§4–5), the direct measurement of the keystone (§6), the synthesis (§7),
and an adversarial self-assessment with explicit kill conditions (§8).

## 2. The system under test: a preserve-not-resolve memory

We evaluate **daftari**, an MCP server that exposes a curated markdown vault to agents. Its
design choices are the ones that matter for this paper:

- **Markdown + YAML frontmatter** is the substrate; the frontmatter is the metadata layer.
  Every fact is a document an agent (or human) can read directly.
- **Git is the version layer.** Every write auto-commits; nothing is destroyed. This zeroes
  *irreversibility* as a variable, a property we exploit in §8 and that the empirical
  companion paper builds on.
- **Supersession is a pointer, not a value.** When a document is superseded, daftari records
  an edge `superseded_by → <successor path>`; it never mints a new consolidated value. A
  query that asks for the current value follows the pointer; it does not read a rewritten
  summary.
- **Tensions are first-class and are not auto-resolved.** A contested relationship is logged
  as a tension (`vault_tension_log`, `vault_edge_contest`); the system surfaces it and
  leaves resolution to a human. There is, by design, **no automatic pass that converts a
  tension into a supersession**.
- **The query path calls no LLM.** Retrieval and current-source resolution are deterministic
  (lexical + vector ranking, pointer-following). The consolidation ("cortex") loop, which is
  advisory and out of scope for this paper's measurements, emits *edges*, never prose.

The single structural fact that drives every result below: **daftari has no operation that
mints a current value from a contested history.** Its no-mint property is therefore a
guarantee by construction, not a behavior we hope a model exhibits. The systems contribution
is that a memory built this way is still *useful*: it answers "what is current" by
following pointers, while never being forced to manufacture an answer it does not have.

**What the agent does with this.** The payoff of preserving structure is a decision the agent
could not otherwise make. Consider an agent asked to act on a contested fact: to execute a
clause whose governing value is disputed, or apply a policy two stakeholders still disagree
on. Against a consolidating memory it receives a single confident current value and acts; the
tension is invisible, so the wrong action is indistinguishable from the right one. Against
daftari the same query returns the *structure*: a `superseded_by` pointer where the matter is
settled, or a logged tension where it is not. On the tension the agent reads *contested,
status quo by default*, and can take the branch a minted value would have hidden: abstain from
the irreversible action, surface both positions, escalate to a human. We do not evaluate this
downstream behavior (that is a claim about agents, not memory); we note only that the structure
daftari preserves is the input such behavior requires, and that a minted value destroys it
before the agent ever sees the choice.

## 3. Two regimes, one axis

The competitor we measure against is a **consolidating / value-minting memory**: a system
whose job is to maintain a single current-state record, of which the deterministic
"most-recent-mention" baseline and an LLM-consolidation step are two instances. The question
is when, and how, such a system fails in a way preserve-not-resolve does not.

We select two corpora as a **control / treatment pair on the recency axis**:

- **Control: formal contracts (recency works).** Amendment chains where a trivial
  most-recent-mention baseline returns the correct current value. If a difference shows here,
  it is *not* about accuracy.
- **Treatment: Wikipedia consensus records (recency fails).** Human decision records where
  recency returns stale values, and where genuine unresolved tensions exist.

Two corpora that differ on the axis a skeptic cares about is a *design*, not a sample size;
adding a third corpus of the same shape would answer "does it replicate?", which is not the
question. The contribution is the **invariance** of the separating axis across the two
opposite regimes (§7).

## 4. Control: contracts, where recency is accuracy-sufficient

**Corpus.** Real SEC EDGAR credit-agreement amendment chains (e.g., Natural Gas Services
Group), pulled deterministically, with a zero-LLM resolution pipeline that classifies each
amendment operation as recoverable (whole-clause/defined-term restate, delete, add) or
unrecoverable (partial edits, "the last sentence of Section X is amended…"). Contamination
is controlled by value-perturbation (type/magnitude-preserving substitution of durations,
amounts, percentages) so memorized contracts cannot be answered from priors.

**Accuracy is solved by a trivial baseline.** A stale-restatement probe over both real
chains found **zero** cases where a later document quotes a *superseded* value as current;
the structural reason is incorporation-by-reference drafting ("terms have the meaning set
forth in the Credit Agreement, *as amended*"), so recitals never quote stale values. Corpus-
wide, operative-amendment idioms outnumber the only stale-value-quoting idiom by **>100:1**.
On a clean real chain, most-recent-mention recency and daftari's chain-following resolution
*tie* on accuracy. **The formality that makes contract supersession explicit and labelable
is the same formality that makes it recency-resolvable**, so accuracy cannot be the
contribution here. Good: it forces the question this paper is about.

**Non-fabrication (the partial-amendment subset).** Where a clause's current value is *not
recoverable* from what was retrieved (partial amendments that edit a sub-part without
restating the whole), a value-minting baseline must still emit a value. Under the realistic
consolidation shape (a forced answer, no abstain), the minting baseline **fabricates a
governing value on 4/7** partial clauses; daftari emits **0/7** by construction (it points
to the governing source and flags the clause unrecoverable). With an abstain option offered,
the LLM baseline fabricates less (1/7), the first appearance of a pattern we quantify in §6.

**Provenance (where LLMs actually fail).** Asked for the per-clause governing source and
supersession history, an LLM-over-raw-documents baseline reproduces provenance for *clean*
clauses (history 5–6/6, governing 4/4) but mis-attributes governance on the *partial*
clauses **0/2**: it defaults to the last-touched amendment where the correct answer is the
master agreement, *even when the resolution rule is stated in the prompt*. daftari's
deterministic resolution is **6/6**. Provenance is the axis where the gap is not soft: a
consolidation discards which source governs by construction.

**Reading.** On contracts, daftari's value concentrates entirely on the unrecoverable/partial
subset, exactly where minting fabricates and naive provenance mis-attributes, while clean
clauses are recency-resolvable. Accuracy is not the axis; non-fabrication and provenance are.

## 5. Treatment: Wikipedia consensus, where recency fails

**Corpus.** The `Talk:<Article>/Current consensus` subpages, human-maintained, dated
decision records for high-conflict articles, with explicit consensus-citing reverts in the
article's revision history. Ground truth is the editor-maintained consensus box (no LLM
labeler → no contamination); alignment of a stale edit to the governing decision is
editor-provided ("rv per consensus #N"); memorization is controlled by post-cutoff items
(2025–26) and value-perturbation.

**Recency fails; daftari never goes stale.** Across the 33 scorable supersession traps, a
stream-recency baseline (trusting the latest ingested edit) returns a **stale** value 33/33
before the governing edit and the correct value after (a fair foil); daftari's chain-
following resolution is **never stale (0/33)**.

**Auto-acquisition is hard, by design, and the result reflects it.** We tested whether
daftari's *actual* derivation classifier auto-acquires the stale↔governing relation: recall
**1/33**, because competing wordings are a *tension*, not a load-bearing derivation, so the
classifier correctly declines and the system mints **0**. A bespoke contradiction detector
(the "right lens") recovers little more: 2/33 over full passages, 4/33 when narrowed to the
changed span, because most of these disputes are *framing/detail* differences (both
versions true), not logical contradictions, with false-positive 0/16 and 0 minted
throughout. The honest reading: these conflicts are largely **not recoverable from text
alone**; the editor process surfaces them from edit/rule context. daftari's claim is
**no-mint**, not auto-acquisition.

**The minting foil fabricates, but how much is model-dependent.** A value-minting baseline,
forced to assert a directional supersession on the 49 stale/governing and cross-item pairs,
is position-biased and fabricates: total fabrication **F = 26/49** for a cheap model
(Haiku-4.5), **24/49** for GLM-4.6, but only **6/49** for GPT-4o, which, offered the abstain
option, takes it (it returns "neither" on 25/33 real pairs). So the abstain-offered
fabrication is **model-dependent (6–26/49)**, and capability does not predict aggressiveness:
the most capable model is the most restrained. This is the same softness as §4's
abstain-offered 1/7. It is *not* the robust headline; §6 is.

## 6. The keystone, measured

The claim that names the paper, *a tension may never masquerade as a supersession*, would
be empty if it held only "by construction." We measure it directly.

**Genuine tensions, editor-certified.** A consensus item closed **"no consensus"** is a
genuine tension: the status quo holds *by default*, not by superseding the alternative on the
merits. The editors label this verbatim (e.g., "…there is no consensus on specific wording,
but the status quo is X"; an RfC closed "status=No consensus"). We collected the six
currently-active such items across the three articles whose consensus box records
them (Donald Trump ×4, Joe Biden, COVID-19 pandemic; a survey of 12 candidate articles found
the box is a rare institution). For each, the two competing positions were distilled from
the linked RfC and **gated by a blind, cross-family second-rater** ("is this a genuine
unresolved disagreement where neither has won out?"), **6/6 validated**. Ground truth =
**NEITHER supersedes**.

**Two conditions.** A consolidation memory whose architecture maintains a single current
value has no "tension" slot; we model this with the **forced** condition (the foil must pick a
direction). An LLM consolidation step that *could* decline is modeled by the **abstain-
offered** condition.

| condition | Haiku | GLM-4.6 | GPT-4o |
|---|---|---|---|
| **Forced masquerade** (architectural) | 5/6 | 6/6 | 6/6 |
| Abstain-offered (LLM judgment) | 3/6 | 5/6 | 2/6 |

- **Forced: 17/18 across the panel**: a memory that must emit one value collapses a genuine
  tension into a supersession, *near model-independently* (GPT-4o masquerades 6/6 when it
  cannot abstain). Not a sterile tautology: Haiku *refused* once.
- **daftari mints 0/6 and manufactures 0/6 false conflicts.** Its contradiction detector
  flags the 3 genuinely oppositional items and correctly declines on the 3 framing disputes:
  it neither mints a supersession nor invents a contradiction; it preserves both positions.
- **Abstain-offered is model-dependent (2/6–5/6)**: GLM-4.6 most aggressive, GPT-4o most
  restrained. The honest softness, quantified.

This is the keystone as an **architectural fact**, not a claim about model quality.

## 7. Synthesis: the invariance

Place the two regimes side by side:

| | Control: contracts (recency works) | Treatment: Wikipedia (recency fails) |
|---|---|---|
| Accuracy | recency sufficient (>100:1); tie | recency stale 33/33; daftari 0/33 |
| Minting fabricates | partials: forced 4/7 (abstain 1/7) | forced tensions 17/18; abstain-offered F=6–26/49 |
| Provenance | LLM governing 0/2 on partials; daftari 6/6 | supersession pointer preserved; tension preserved |
| daftari mints | 0 | 0 |

The separating axis is the **same in both regimes**, non-fabrication and provenance, not
accuracy, and the system that holds it does so **by construction**. Where recency already
wins (contracts), accuracy cannot distinguish architectures, yet minting still fabricates on
partials and erases provenance. Where recency fails (Wikipedia), a memory that must resolve
collapses genuine tensions. In neither regime does daftari mint, for any model, with no
prompt engineering. That invariance, not any single fabrication number, is the
contribution.

## 8. Honest assessment and kill conditions

We hold ourselves to an adversarial read.

- **The non-fabrication gap over a *careful, abstain-prompted* LLM is small, and model-
  dependent.** Offered an abstain option, GPT-4o fabricates little (6/49 on Wikipedia, 1/7 on
  contracts). A reviewer will say: "then just use GPT-4o and let it abstain." Three answers.
  (i) **It abstains by failing to detect what is there**: on the 33 real supersessions it
  returned "neither" 25/33; low fabrication bought with low recall is not a memory you trust.
  (ii) **daftari's guarantee is structural**: it holds for any model, with no prompt
  engineering and no dependence on someone remembering to offer the abstain option; that is
  an auditability/worst-case property, not an average-case one. (iii) **The real competitor
  is not "a careful LLM you may ask to abstain"**: a consolidation/accumulator memory emits
  a single current value (the forced condition, where the contrast is model-independent); a
  memory that abstains on every contested point is not doing the job daftari does (answer
  *and* preserve the tension).
- **The components are not individually novel (§9).** Bi-temporal supersession-without-
  deletion (Graphiti), unresolved-contradiction representation (ATMS), the supersession-vs-
  contradiction distinction (ElephantBroker), and supersession-preserving provenance (Roynard)
  all predate us. We claim the *structural conjunction*, no-mint of a tension as a
  by-construction invariant, and the empirical measurement of §4–6, not the constituent ideas.
  A reviewer who knows ElephantBroker will press hardest here; the defense is that EB's
  tension/supersession split is LLM-extracted and resolved by confidence decay (model-
  dependent), which is precisely the difference §6 quantifies.
- **The keystone is measured at n=6.** Small, because the consensus box is a rare institution
  (3 articles). The structural guarantee is the backbone; the measurement is support. Scaling
  needs broad RfC-close harvesting, which loses the clean editor label.
- **Tension pairs are distilled, then gated.** The status-quo side is grounded in the box;
  the alternative is distilled from the RfC (a judgment step), so the blind second-rater gate
  (6/6) is load-bearing, not decorative.
- **Auto-acquisition on Wikipedia is low (1–4/33).** We claim no-mint, not auto-acquisition;
  we report the gap rather than hide it.
- **The consolidation loop is described, not powered.** This paper makes no variance/quality
  claim about the loop; that is the empirical companion paper.

**Single kill condition.** daftari has no niche if a consolidation baseline *both* (i)
abstains as reliably as daftari on unrecoverable / genuinely-tense cases **and** (ii)
reproduces provenance / never mints, across *both* regimes, **and** without sacrificing the
recall that (i)'s abstention costs. Measured: it does not. The careful model that abstains
loses recall (25/33 missed); the aggressive models fabricate (F up to 26/49); none reproduce
partial-clause provenance (0/2). The forced/architectural minter masquerades tensions 17/18.

## 9. Related work

*(Grounded by a deep-research pass, 2026-06-29; all cited IDs re-verified against primary
sources 2026-06-30: each resolves and every attributed claim is body-grounded (the Graphiti
"consistently prioritizes new information" quote, the Cartridges 38.6×/26.4× figures, and the
57%-unfaithful figure confirmed verbatim). Several closest competitors are 2026 preprints with
no citation track record; re-verify currency again at submission.)*

The individual components of preserve-not-resolve are **not novel**, and we cite the prior
art rather than claim them; the contribution is their *structural conjunction* on a specific
substrate, plus the empirical measurement of §4–6.

**The consolidation / accumulation pole.** The dominant frame for agent long-term memory is
consolidation, periodically rewriting memory toward a compact current state. Mem0
[2504.19413] dynamically extracts and consolidates via ADD/UPDATE/DELETE operations that
overwrite prior entries; A-MEM [2502.12110] performs "memory evolution," mutating existing
memories in place; MemGPT/Letta [2310.08560] self-edits hierarchical memory blocks,
resolving a changed fact by overwriting it in place (`core_memory_replace`); and Cognee
is a multi-store knowledge-graph memory layer whose enrichment pass (`memify`) updates and
prunes nodes, with explicit `delete`/`prune` operations (mechanism per its documentation;
[2505.24478] is a tuning/evaluation study of the framework). A recent 2026 survey
[2603.07670] names "continual consolidation" and "learned forgetting" as open frontiers and
treats contradiction handling as a write-path engineering concern, not a first-class
invariant. Generative Agents [2304.03442] is the
important exception on the preservation axis: its reflections are an *additive* layer over a
retained observation stream, prior art for "preserve raw, layer inference on top," though it
makes no supersession or non-fabrication claim.

**Two preservation axes, often conflated.** "Preserving structure" splits into two distinct
properties, and the prior art sits on different ones:

*Supersession-preservation*: keep the *old* fact as history, but resolve which is current.
Zep/Graphiti [2501.13956] is the strongest instance: a bi-temporal graph that *invalidates*
(not deletes) an edge on contradiction, setting the old edge's `t_invalid` to the new edge's
`t_valid` and retaining it as queryable history, but it always **resolves**, "consistently
prioritizes new information when determining edge invalidation," yielding a single current
state per relationship. Roynard's "Knowledge Layer" [2604.11364] similarly records
supersession as a relationship and preserves both claims append-only with explicit
provenance, but it has no first-class unresolved state: supersession, evidence-gated, is its
only preservation-with-linkage mechanism (it resolves). SmartVector [2604.20598] makes the pattern explicit: it
preserves every superseded vector (an `ARCHIVED` state with `supersedes`/`superseded_by`
edges, "nothing deleted") yet **resolves every contradiction by a recency / source-authority /
feedback majority vote**: preserve the past, vote-away the present, the move our keystone
forbids. daftari sits on this axis too, and we claim **no novelty** for keeping the
superseded fact. Notably, Graphiti's recency-prioritized resolution is the
*foil* behavior of §5: on our treatment corpus the governing value is not the latest edit, so
a recency-resolving memory goes stale exactly as the recency baseline does (stated as
positioning; we did not run Graphiti).

*Tension-preservation*: hold *two still-live* claims open, unresolved, and never let one
quietly become current. This is the keystone axis, and it has prior art too. The classical
deep precedent is the assumption-based truth-maintenance system (ATMS) [de Kleer 1986]:
contradictory derivations coexist across assumption-environments via consistent labels and
recorded "nogoods," never collapsing to one belief set. In agent memory, ElephantBroker
[2603.25097] is the sharpest: it emits a *contradiction edge* (both facts retain confidence)
distinct from a supersession edge, directly our distinction. **So representing a tension is
not our novelty either.** What no system makes it is a *structural, by-construction*
property (see below).

**Why the tension-preservers fall short of a structural guarantee.** ElephantBroker, the
sharpest case, represents the tension/supersession distinction but does not *guarantee*
no-mint: (i) the classification is made by an LLM extractor, *model-dependent*, exactly the
dependence §6 measures; (ii) it does not preserve a tension neutrally: the contradiction edge
carries a retrieval-scoring penalty and the supersession path decays the old fact's
confidence; (iii) its consolidation engine canonicalizes near-duplicates and archives
low-confidence facts (an accumulation move); and (iv) its only *architecture-enforced*
guarantees concern safety/contamination, not the minting of values. So the closest competitor
*confirms* the gap: representing a tension is not the same as a by-construction invariant that
one can never become a supersession. Two other recent systems frame the contrast. TOKI
[2606.06240] formalizes contradiction *resolution* as a bitemporal operator algebra, the
opposite choice: resolve, with theory, rather than preserve. And classical TMS (ATMS) achieves
its no-collapse property *structurally* (nogoods are pre-compiled so a label can never contain
an inconsistent environment), but over logical assumption-sets, not over a human-readable,
agent-consumed memory substrate.

**Non-fabrication and provenance are behavioral, not structural, in prior work.** Faithfulness
in RAG is achieved by model alignment, not architecture: Trust-Align [2409.11242] improves
correct refusal via preference tuning with no by-construction guarantee, and "Correctness is
not Faithfulness" [2412.18004] shows models post-rationalize (up to 57% of citations unfaithful
in their experiment). Provenance exists but targets a different relation: Portable Agent Memory
[2605.11032] provides a Merkle-DAG of derivation lineage (tamper-evidence), not provenance over
what-supersedes-what; AIS [2112.12870] is an attribution *measurement* framework, not a
guarantee. The **inverse-substrate pole** writes memory *into the model* rather than an
external store: Cartridges [2506.06266] distills a corpus offline into a trainable KV-cache
(key/value vectors trained by back-propagation; 38.6× less memory and 26.4× higher throughput
than in-context learning), productized as Engram (2026). Such memory is opaque, non-versioned,
and carries no supersession or provenance representation, the inverse substrate choice to a
human-readable, git-versioned store. It optimizes for token-cost, not supersession, so the
contrast is one of substrate and aim, not a head-to-head on our axis.

**The gap this paper fills** (narrowed to be reviewer-defensible):
- **A structural, by-construction no-mint invariant *in an agent-memory system*.** Classical
  TMS (ATMS) has a structural no-collapse guarantee, but over logical assumption-sets in a
  reasoning engine, not a persistent, natural-language, agent-consumed memory. Among
  *agent-memory* systems, none makes no-mint architectural: the closest (ElephantBroker)
  represents the tension/supersession distinction but resolves it via LLM extraction +
  confidence decay, exactly the model-dependence §6 measures (the architectural minter
  masquerades model-independently; the LLM minter's restraint is model-dependent). Our
  contribution is porting the TMS no-collapse property *to the agent-memory substrate as a
  by-construction invariant*.
- **The empirical two-corpus invariance.** No prior system is evaluated for non-fabrication +
  provenance across a recency-*works* control and a recency-*fails* treatment.
- **Provenance over supersession.** Existing provenance is lineage/tamper-evidence (Portable
  Agent Memory) or source attribution (Roynard); provenance over *what governs and what it
  superseded* is thinner prior art.
- **The substrate.** No cited system targets a human-readable, git-versioned, agent-consumed
  markdown vault: the surveyed systems store memory in databases (Cognee: graph + vector +
  relational backends), opaque trainable tensors (Cartridges/Engram), or knowledge graphs
  (Graphiti); and a competitor has publicly argued markdown is *not* agent memory [Zep blog]:
  that plain files lack the structured query surface a graph gives you. We take the
  point and invert it. In daftari the query surface *is* a graph-and-vector index (SQLite plus
  embeddings, §2), but a **derived, rebuildable** one; the markdown files are the durable layer
  beneath it. Retrieval is served by the index; provenance is served by the files, because every
  superseded value survives as a git object a human or auditor can read *without trusting the
  system that wrote it*. The property the critique calls a limitation, that memory is plain
  inspectable files rather than an opaque store, is precisely the property an auditability
  guarantee needs. Markdown is the deliberate choice for the axis this paper measures, not a
  retrieval concession.

## 10. Limitations and future work

- **A genuine-tension corpus at scale** (beyond n=6) would move the keystone from "measured
  on a rare institution" to "powered", the natural next acquisition.
- **The §6.1 comprehension-load ablation** (does the consolidation loop's trust budget reduce
  retrieval-quality variance in a domain where git has zeroed irreversibility?) is the
  empirical companion paper; it needs a derivation-rich corpus and a variance harness, both
  absent here.
- **Stronger-model and forced-condition coverage on contracts** (the contract forced Arm B is
  n=7) would tighten §4 the way §6's panel tightened the keystone.

---

### Appendix: evidence map (all runs produced; pointers)

| claim | artifact |
|---|---|
| recency sufficient on contracts (>100:1) | stale-mention probe, E3 (`2026-06-27-*`) |
| minting fabricates on partial clauses (forced 4/7) | contracts forced Arm B (`2026-06-27-a-small-experiments.md`) |
| LLM mis-attributes partial provenance (0/2) | contracts provenance eval (same) |
| recency stale 33/33; daftari 0/33 | CO2 full 37-run (`2026-06-28-corpus-b-co2-pilot.md`) |
| derivation recall 1/33, mints 0 | CB4 (`2026-06-28-corpus-b-cb4.md`) |
| minting foil F = 6–26/49 (model-dependent) | CB4 model-panel re-run (same note) |
| contradiction detector 2→4/33, FP 0/16 | CB5 + span (`2026-06-29-corpus-b-cb5.md`) |
| keystone: forced masquerade 17/18; daftari 0 | CB6 (`2026-06-29-corpus-b-cb6.md`) |
