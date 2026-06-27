# Paper framing (A) — Sovereignty without accuracy: what a memory system owes you when recency already works

**Date:** 2026-06-27
**Status:** framing locked, draft-ready. The spine is the stale-mention probe (2026-06-27); the supporting evidence is already produced on `feat/contract-bench-arms`.
**Companion:** framing (B) — the accuracy regime on poor-hygiene human decision records — scoped at the end as the next bet.

## The one-line reframe

We set out to show contracts are the regime where value-minting memory fabricates because recency fails on accuracy. **They aren't** — recency is accuracy-sufficient on contracts, structurally. That negative result is not a dead end; it is the setup. *When accuracy no longer separates memory architectures, two guarantees still do: non-fabrication and provenance.* That is what daftari is built on, and what a consolidation/minting architecture sacrifices.

## What changed (and why it's load-bearing, not embarrassing)

The original premise: real contract chains contain *scoped-current-with-stale-mention* — a later doc states an earlier-governed clause at a stale value — so a "most-recent-mentioning" baseline returns the wrong current value, and a value-minter fabricates. The stale-mention probe refuted this at corpus scale:

- 0 stale mentions across both real chains (10 amendment docs);
- the structural reason is incorporation-by-reference ("terms have the meaning set forth in the Credit Agreement, *as amended*") — real recitals never quote a stale value;
- corpus-wide, operative-amendment idioms (~13,000+ EFTS hits) outnumber the only stale-value-quoting idiom (~108) by **>100:1**, and those ~108 sit *inside* the operative doc, not a later one.

**The formality that makes contract supersession explicit and labelable is the same formality that makes it recency-resolvable.** So on contracts, accuracy is solved by a trivial baseline — which means accuracy cannot be the contribution. Good. It forces the honest question: *what does a memory system owe you that recency does not provide, even when recency is right?*

## The contribution (precise, honest)

**Claim 1 (empirical negative result, strong):** On formal amendment chains, most-recent-mentioning recency is accuracy-sufficient — a structural property of legal drafting, quantified (>100:1) and mechanistically explained (incorporation-by-reference, wholesale restatement, change-description recitals). This is a useful corrective to "memory needs synthesis to stay current": on well-drafted corpora it does not.

**Claim 2 (non-fabrication / sovereignty):** Where a clause's current value is *not recoverable* from what was retrieved (partial amendments — "the last paragraph of Section X is amended…"), daftari never mints a consolidated value; it points to the governing source and flags the clause unrecoverable. A value-minting baseline fabricates. Measured (Arm B) on real NGS partials: daftari 0/2 by design; LLM foils 0/2 (gpt-4o, abstain offered) and 1/2 (gemini-flash). **Honest edge: the guarantee is design-level (any model, any prompt); the *empirical* gap over a careful, abstain-prompted LLM is small.**

**Claim 3 (provenance / preserve-not-resolve):** daftari surfaces, per clause, the governing source and the supersession history — and (the keystone) never lets a tension masquerade as a supersession. A consolidation collapses the chain into a single current value and discards which source governs and what it superseded. *This is the claim that most distinguishes daftari where accuracy is solved — and it is the one not yet measured against a baseline (see Honest Assessment).*

## Evidence map (all already produced)

| Element | Artifact | What it shows |
|---|---|---|
| Mechanism | synthetic falsifier (2026-06-25) | daftari resolves clause chains, never mints; recency is a faithful foil |
| Accuracy on real chain | E3 runner (2026-06-27) | INCONCLUSIVE tie — recency suffices on a clean real chain |
| Accuracy regime absent | stale-mention probe (2026-06-27) | **the spine** — recency accuracy-sufficient on contracts, structurally, >100:1 |
| Non-fabrication | Arm B (2026-06-27) | daftari 0 by design; minting fabricates model-dependently |
| The synthetic→real cost | four extraction gaps (E2/E3) | honest engineering: the apparatus, not the thesis, kept breaking on real prose |

## Proposed structure

1. **Memory systems are evaluated on accuracy** — and on formal corpora a trivial recency baseline already wins it. (Claim 1.)
2. **So accuracy doesn't separate architectures here. What does?** Introduce the two orthogonal guarantees: non-fabrication, provenance.
3. **The corpus.** Real EDGAR amendment chains; explicit, labelable supersession; the deterministic zero-LLM discovery + resolution pipeline; the four synthetic→real gaps as an honest methods note.
4. **Recency is accuracy-sufficient (the negative result).** The probe: chain scan + recitals + EFTS frequency.
5. **Non-fabrication (Arm B).** Minting fabricates where the value is unrecoverable; daftari's 0 is a design guarantee; the careful-LLM caveat.
6. **Provenance (the keystone).** Per-clause governing source + supersession history; never collapse a tension. *Needs a baseline comparison — the one new experiment (A) requires.*
7. **The corpus tension → why accuracy lives elsewhere.** Set up (B).

## Honest Assessment (adversarial)

- **Is (A) a standalone paper, or a strong section?** Honestly, closer to the latter as it stands. Claim 1 is a clean negative result; Claim 2 is real but model-dependent; Claim 3 is the strongest *conceptual* differentiator but is **asserted, not measured**. The completable-from-work-already-done version is "negative result + sovereignty demonstration + provenance capability." To be a venue paper rather than a workshop note, (A) needs one new experiment: a **provenance evaluation** — can a recency/LLM-consolidation baseline reliably produce the per-clause governing source and the superseded history, or does it collapse them? If a baseline can, Claim 3 weakens; if it can't (likely — consolidation discards provenance by construction), Claim 3 becomes the paper's spine.
- **Sovereignty is softer than hoped.** gpt-4o abstained when allowed. The forced-answer condition (consolidation that must emit a current state, no abstain) is the on-thesis foil and is unrun. Without it, Claim 2 reads "daftari guarantees what a careful LLM usually does anyway."
- **Negative-result placement risk.** "Recency suffices on contracts" is interesting but a reviewer may read the whole thing as "you picked a corpus where your system isn't needed." The reframe (accuracy isn't the axis; sovereignty/provenance is) must carry that weight — and it only fully lands paired with (B), where recency *does* fail.
- **The keystone is untested at scale.** "A tension may never masquerade as a supersession" is the thesis spine, but contracts have *clean* supersession — they barely exercise the tension/contested case. So the corpus that best demonstrates the keystone is, again, (B).

## Kill condition

(A)'s sovereignty/provenance claim dies if a value-minting baseline, given the same chain, **both** (i) abstains as reliably as daftari on unrecoverable clauses **and** (ii) reproduces the per-clause governing source + supersession history. Arm B already shows (i) is partially true for careful LLMs; the provenance experiment tests (ii). If both hold, daftari has no contract niche even on sovereignty/provenance, and (A) collapses to the negative result alone.

## Two minimal experiments — DONE (2026-06-27, `docs/superpowers/results/2026-06-27-a-small-experiments.md`)

1. **Provenance eval** — RUN. LLMs reproduce provenance for *clean* clauses (history 5–6/6, governing 4/4 clean) but fail governing on the *partial* clauses **0/2** (both default to last-touched amd-2/amd-3 where daftari says master — even with the rule stated). daftari 6/6 deterministic. → Claim 3 holds **specifically on the partial/tainted subset** (the keystone), not on clean provenance.
2. **Forced-answer Arm B** — RUN (N=7 partials, cross-judge). Forced (no abstain) fabrication **4/7** both foils vs **1/7** abstain-offered; daftari **0/7**. → Claim 2 is now a measured gap: the realistic consolidation baseline fabricates ~57% on partials.

**Unified result (the spine of A):** daftari's edge is concentrated entirely on the **unrecoverable/partial clauses** — minting fabricates there, naive provenance mis-attributes governance there — while clean clauses are recency-resolvable and LLM-provenance-recoverable (the negative result localizes the win). (A) tightens to one claim: *where the chain is clean a trivial baseline suffices; where an edit is partial/tainted, daftari refuses to fabricate and refuses to let the partial masquerade as a clean supersession — a minting/LLM baseline does both.* Claims 2 & 3 are now measured, not asserted.

---

## Framing (B) — the accuracy regime, scoped as the next bet

**Thesis:** the accuracy regime daftari was built for lives where supersession is real but drafting hygiene is poor — **human decision/stakeholder records** (the WorkIQ / decision-substrate pain: a flip-flopping decision restated across threads and meetings, where people *don't* write "as amended" and routinely repeat superseded positions as if current). There, most-recent-mentioning recency genuinely returns stale values, and a minter fabricates a confident wrong current state. Contracts become the **explicit-supersession control**; decision records become the **recency-fails treatment**. That is the two-corpus contrast the paper needs.

**Why it's the harder bet (name the cost):** in decision records supersession is *implicit and unlabeled* — the thing contracts gave for free. Building ground truth means labeling "which statement supersedes which," likely with an LLM, which partly reintroduces the labeling problem contracts solved cleanly. The methodological crux of (B) is: **can supersession be labeled reliably enough in messy human text to measure an accuracy regime, without the labeler contaminating the result?** That is (B)'s gate — and worth its own brainstorm before any build.

**Sequencing:** (A) is written from work in hand (plus the two minimal experiments). (B) starts with a feasibility probe — *does a real corpus of human decision records with recoverable supersession structure exist / can it be assembled* — mirroring how the contract arc started with acquisition feasibility (E1) before building.

## Tenet check
- *Experiment and Publish:* (A) converts five runs into one framing; the two minimal experiments are named so it's not "done by assertion."
- *Surface what's hidden:* the provenance gap and the sovereignty-softness are stated up front, not buried.
- *Name the displacement:* committing to (A)+(B) displaces the broad-sweep scaling work (now lower priority — scaling a corpus where recency wins buys little) and the citation-parse generalization (only needed if we chase contract accuracy, which we're not).
- *Write to validate:* the one place this draft still hedges is Claim 3 — that hedge is the signal it needs the provenance experiment before it's a finished claim.
