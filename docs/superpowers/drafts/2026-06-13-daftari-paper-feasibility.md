# Daftari — arXiv paper feasibility (hedge-free)

**Date:** 2026-06-13. **Author stance:** builder-experimenter; this is the
honest assessment, written so the decision needs no further qualification.

## The bar

Posting to arXiv is trivial (light moderation + an endorser for a first-time
author). The real bar is **a paper that survives an adversarial read** — your
own "Honest Assessment" pass and a skeptical reviewer. Everything here targets
that, not arXiv acceptance.

## The gap, stated plainly

We have a **design** and a **complete substrate** (§11.1–§11.6, shipped across
1.17.0 / 1.20.0 / 1.21.0). Neither is a result. A paper needs a **measured
claim that survives a baseline**, and today:

- The **A+C loop is not built** (0%). The substrate is the table, not the meal.
- There is **no dataset** — the labeled recall set (§12 #7) does not exist and
  cannot be mined from vault structure.
- There is **no baseline and no measured effect**. Component B (`daftari eval`,
  1.16.0) is a metric, not an experiment.
- There is **one corpus** (FabricSpecs, one domain). A generalization claim off
  a single wiki is thin.

## Two papers, two costs — pick deliberately

### (A) Systems / position paper — reachable sooner
*"A cortex substrate for agent memory consolidation: earned-not-declared trust,
shadow-mode calibration, the envelope."*
- **Contribution:** the architecture + framing (two-gate keystone; trust earned
  via independent re-derivation; comprehension-load as the budget; growth-mindset
  aging as a scheduling law).
- **Bar:** a working loop + a *demonstration*, not a powered study.
- **Cost:** ~1 month after the loop spec. Workshop-tier.
- **Weakness:** venues increasingly want a result, not a design.

### (B) Empirical paper — the one worth writing
*"Consolidation reduces variance/tail in retrieval quality"*, anchored on the
**§6.1 ablation: Daftari isolates comprehension-load from irreversibility
because git makes mechanical reversal free — the ablation the email/ATP paper
could not run.** This is the genuinely novel empirical contribution: no one else
can run it because no one else zeroed irreversibility.
- **Bar:** full loop + dataset + baselines + a signal that holds (or a clean,
  framed null).
- **Cost:** ~2–4 months part-time after the spec. Gated on the experiment, not
  the writing.

## Critical path for (B), dependency order

1. Loop spec + A/C implementation (the §12 agenda — see the loop-spec pickup doc).
2. **Recall-set construction + labeling** — start in parallel; it is the long pole.
3. Experiment harness: baselines (no-loop / single-pass / naive-re-read), held-out
   sets, **varied seeds + models** (independence, not re-runs), variance/tail with
   bootstrap CIs. Measure **variance/tail, not mean** (the cleanest signal).
4. Run; accept a null as a real outcome.
5. Related-work positioning (memory consolidation / sleep in LLM agents, RAG
   maintenance, KB curation, spaced repetition, self-improvement loops) — a task,
   not a paragraph. [TRAINING — needs a deep-research pass to ground.]
6. Write + adversarial internal red-team.

## Corpus strategy

A second corpus answers the "holds off your one wiki?" objection. A public wiki
is the obvious source — but corpus choice IS the experiment.

**The dominating trap — contamination.** [TRAINING] Popular public wikis
(Wikipedia, large Fandom wikis) are almost certainly in the model's training
data. A model "re-deriving" a memorized edge confounds the independence claim
(Q3) at the root — a reviewer hits this immediately.

**The move that flips it into the backbone:** use the wiki's **revision
history**, and make the test events the **edits made after the model's training
cutoff**. Then (a) you get *real* dependency-change events (§12 effect-estimation
needs these and they're brutal to synthesize), and (b) the model cannot have
memorized the post-cutoff state, so re-derivation is genuinely from context.
Without this, you are measuring memorization.

**Criteria for a good corpus, ranked:**
1. **Real derivation structure**, not just association. A lore/fandom wiki is
   dense in cross-reference but thin in *derivation*; Daftari's `derives_from`
   model assumes derivation. Prefer a **structured/technical wiki** (software
   docs, a standards wiki, game-*mechanics* over lore). *Kill condition:* if
   `vault_backfill` + the matcher recover a near-empty `derives_from` store, it's
   the wrong corpus — and you'll see it directly.
2. **Revision history** (the change-event stream). The strongest single reason
   to use a wiki at all. Note: backfill derives frontmatter from *git* metadata
   today; a MediaWiki dump's history needs its own parser.
3. **Low contamination** — niche, or sliced post-cutoff.
4. **Clean license.** [TRAINING] Fandom / Wikipedia are CC-BY-SA — fine for
   research, but a redistributed derived dataset (the recall set) inherits
   share-alike + attribution. Confirm before tooling.

**Cost / displacement:** each corpus is its own ingestion + recall set +
baselines — roughly doubles the long pole. **Two well-chosen corpora is the
sweet spot:** keep FabricSpecs (technical, controlled, uncontaminated) + add one
niche/recent structured wiki with usable history. Two that differ on the axis a
skeptic cares about beats ten.

## Risks that would kill (B) — name them now

- **Null / small effect.** Consolidation may not move the needle measurably on a
  small corpus. Design *for* this: a clean null on the ablation is publishable if
  framed as such.
- **Confound.** If gains come from re-reading rather than independent
  re-derivation, the central claim collapses — hence varied models/prompts, not
  re-runs. This is why Q3 independence is load-bearing.
- **Borrowed-foundation risk.** (B) leans on the *Agentic Trust Protocol* paper,
  which has an **unreconciled integrity flag** (STATUS.md vs draft.md disagree on
  replicate counts). Fix that before citing, or the spine wobbles.

## Recommendation

Do not aim at (B) yet — the loop isn't built. **Build the loop for its own
sake**, instrument it for (B) from day one (held-out sets, varied-axis
re-derivation, variance capture — the design already wants all of this), and
**decide (A)-now vs (B)-later only after the first real run shows whether there
is a signal.** If a paper is wanted soon, (A) is honest and ~1 month out. The
paper worth writing is (B): a quarter of focused work, and its value is the
ablation.

## Related artifacts

- Loop-spec pickup: `docs/superpowers/drafts/2026-06-12-cortex-loop-spec-pickup.md`
- Design direction: `docs/superpowers/specs/2026-06-06-cortex-consolidation-loop-design-direction.md` (§6.1 ablation, §12 opens)
- ATP paper integrity flag: noted in memory `project-cortex-consolidation-loop`
