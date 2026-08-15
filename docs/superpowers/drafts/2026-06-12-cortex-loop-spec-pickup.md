# Pickup — Cortex consolidation loop (A+C), next session

**Status as of 2026-06-12.** The §11 substrate build-list is **complete (6/6)**.
The next cortex work is the thing all the substrate was for: **writing the A+C
consolidation-loop spec**, then implementing it. The loop spec file does **not**
exist yet. This document is the cold-start brief for that session.

---

## Where we are

**Design (locked, not yet a spec):**
`docs/superpowers/specs/2026-06-06-cortex-consolidation-loop-design-direction.md`
is the pre-spec synthesis — read it first, in full. The design decisions are
locked (§10, §5.2, §5.3); what's missing is the *spec* that turns them into a
build, and the build itself.

**Substrate shipped (the §11 build-list, all done):**

| Item | What | Released |
|---|---|---|
| §11.1 | `vault_backfill` — git-driven frontmatter migration | 1.17.0 |
| §11.2 | staged-action queue + `vault_ratify` | 1.17.0 |
| §11.3 | `derives_from` edge store with earned strength | 1.20.0 |
| §11.4 | `vault_supersede` / `vault_merge` / `vault_set_confidence` | 1.20.0 |
| §11.5 | shadow-mode execution path (calibration) | 1.21.0 |
| §11.6 | agent principal in RBAC (`ratify` grant + principal attribution) | 1.21.0 |

**Component B (the "exam") shipped earlier:** `daftari eval` — the cortex
quality metric / subgraph sampler — landed in 1.16.0. B is the held-out
retrieval-practice measure. It is a **monitor, never a target** (§3 poison
constraint).

**Per-item mechanics + rationale:** in the memory file
`project_cortex_consolidation_loop.md`. The substrate briefs are in
`docs/superpowers/drafts/2026-06-07-*` (§11.4), `2026-06-11-*` (§11.3, §11.5),
`2026-06-12-*` (§11.6).

---

## What the loop is (one paragraph)

A spaced-repetition system for a knowledge vault. **Component C** is the
scheduler: a `do()` on a doc (event clock) or elapsed time (decay clock /
forgetting curve) marks dependent docs "due for review." **Component A** is the
revision session: re-DERIVE the prior pass's claims independently (generation
effect, not re-reading), under an envelope that lets the agent auto-write inside
policy and surface/stop outside it. **Component B** is the exam: held-out
retrieval practice; failures are the curriculum. Trust on an edge = how many
independent re-derivations it survived (earned, not declared) — the §11.3 store
already implements this. The loop never auto-deletes; git + provenance are the
reversibility substrate.

---

## The agenda — §12 open decisions (what the spec must resolve)

These are the items the design doc explicitly deferred to the loop spec. This is
the next session's work-list:

1. **Multi-pass mechanic** (the "sleep loops"; arXiv 2605.26099 / 2605.08538):
   pass input/output schema, stop condition (fixpoint? N passes? budget
   exhaustion? K reached?).
2. **Effect estimation:** the held-out question-set protocol; attribute
   **variance/tail reduction, not mean** (the cleanest signal per §3.7's ATP
   import); the §6.1 comprehension-load ablation.
3. **Periphery-starvation full fix** beyond §5.3.1's backstop-as-guarantee
   (fairness floor? round-robin reserve?).
4. **Compute-budget calibration:** per-session re-derivation cap; reserved
   backstop slice; aging rate; interval function `f(strength)`. The §11.3 and
   §11.5 constants (`EDGE_*`, `SHADOW_*`) are provisional placeholders for this.
5. **B coverage/equity instrumentation:** strength-distribution drift,
   backstop-overdue count, action-mix drift (so the §5.3.2 ratchets are
   visible — B must measure coverage, not just quality).
6. **Quarterly re-calibration cadence driver** — human, cron, or
   loop-self-triggered? (C-Q4 defers self-triggers; cadence needs an external
   driver. **The OpenClaw idea re-enters here** — OpenClaw's scheduler as the
   loop's session cadence; see the OpenClaw plugin discussion.)
7. **50-pair labeled recall-set construction protocol** — who labels, on what
   protocol, refresh cadence. Cannot be mined from existing vault structure.
   **This is the dataset gate for any measured result.**
8. **A's RBAC role specifics** — the §11.6 `ratify` grant exists; the spec
   pins exactly what the `agent:curation-loop` role gets.

Plus older opens still live: declared-vs-inferred v1 cut, edge typing
mechanics, I-table calibration against shadow-mode data.

---

## How to start the spec session

1. Read the design-direction doc end to end (§0–§12), then the four substrate
   briefs for what actually got built (the briefs note where implementation
   deviated from / tightened the design — e.g. §11.3's replay-gap rule, §11.5's
   session = process lifetime).
2. The spec target path is
   `docs/superpowers/specs/YYYY-MM-DD-cortex-consolidation-loop.md`.
3. **Build order once specced (proposed):** wire §11.3 strength into a C
   scheduler that consumes `vault_tension_blast` (already shipped) → run A as a
   read-path re-derivation that emits `vault_edge_observe` / `vault_edge_contest`
   / staged actions → keep everything in shadow mode (§11.5) until the I-table
   is calibrated from real shadow data → only then graduate auto-write inside
   the envelope.
4. **Non-negotiables (charter, §7):** stays cortex (not compile / write-
   surface); never auto-delete; B is monitor never target; "Component A is the
   danger zone" — poison (Goodhart) and fluff first appear there; re-derivations
   must be independent (blind + varied axis — the store enforces a replay gap,
   but genuine independence is the loop's job).

---

## Process notes (carried from this batch)

- **Release ritual:** four version sites (package.json + lock, `DAFTARI_VERSION`
  in src/index.ts, manifest.json), tag, GitHub Release, then **`npm publish` is
  Mihir's step (MFA/OTP)**. See memory `daftari-release-ritual`.
- **uatu commit-audit hook** fires on every Bash; in don't-ask mode its "ask"
  hard-blocks. Switch to ask-permissions before commit-bearing work. See memory.
- **Canonicalize path keys** before any identity check or keyed store — the
  alias bug bit three times this batch (merge, edge store, shadow blast). See
  memory `canonicalize-path-keys`.
- **CI embedding-model flake:** search/embedding tests intermittently red on one
  Node matrix job when MiniLM fails to load; re-run `--failed` before assuming a
  regression. See memory `ci-embedding-model-flake`.
- **Loop:** brief → test-first → two adversarial general-purpose reviewers
  (NOT the squad agents — their tool bindings are broken) → fix → PR.

---

## The grounding frameworks (the "why", so the spec keeps its spine)

1. **The Envelope** (Mihir's "Hallucinated Intent" essay) — human sets policy
   once; agent acts within it, surfaces outside it; monitor the pattern.
2. **Causal ladder** (Pearl) — A & C operate on Rung 2 (`do()`); B is Rung 3
   (counterfactual). Invariant: A may only `do()` on *causes* of quality, never
   the measure.
3. **Revision / spaced repetition** — trust = survived independent
   re-derivations. The graph is earned into existence.
4. **Trust budget / path irreversibility** (Mihir's *Agentic Trust Protocol*) —
   two non-substitutable gates: strength catches premise-wrong-as-fact; budget
   catches accumulation+iteration. In Daftari the budget bounds
   **comprehension/coherence load**, not irreversibility (git zeroes that) — the
   loop is the ablation the email paper couldn't run (§6.1).
5. **Growth mindset** (Nadella/Dweck) — the disposition above the three: a
   revised doc is provisional ("learn-it-all"); a frozen doc asserts it's done
   knowing. Aging = growth mindset as a scheduling law.
