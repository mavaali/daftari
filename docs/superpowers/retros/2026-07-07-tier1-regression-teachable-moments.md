# Tier 1 Regression Suite — Concepts & Tradeoffs Retro

**Date:** 2026-07-07
**Build:** PR #204 (`feat/regression-suite-tier1`), from `docs/superpowers/specs/2026-07-07-regression-suite-design.md`
**Purpose:** the six judgment calls in the build, each reduced to its generalizable principle — plus the design-review questions that would have generated them up front. Written so the next gate design starts from the questions, not the answers.

## 1. Goldens vs. thresholds

**The decision:** CI diffs per-query outcomes against a committed `baseline.json`; any difference fails. The rejected alternative was a floor like "hit@1 ≥ 0.9".

**The tradeoff:** Thresholds tolerate silent drift — you can decay 1.0 → 0.91 across ten PRs and never see a red. Goldens make every behavior change visible in review, at the cost of update friction (every intentional change must re-commit the baseline).

**The principle that decides it: determinism.** BM25 is deterministic, so *any* variation is signal — a noisy hermetic metric is a bug, not a band. Thresholds/tolerances are only correct where the metric is genuinely nondeterministic (Tier 2's vector scores, float-unstable across platforms). The question to ask of any metric gate: *"is variation in this number noise or signal?"* That single question sorts every metric into golden vs. band.

## 2. Invariants vs. goldens — two kinds of red

**The decision:** "Never stale" and "dead-ends abstain" assert unconditionally; per-instance classifications diff against the baseline.

**The tradeoff:** If everything is a golden, everything is updateable — someone under deadline pressure can `update-baseline` their way past a real regression. If everything is an invariant, any intended behavior change breaks CI with no sanctioned path forward.

**The principle:** Separate *promises* (must always hold, no history can excuse a violation) from *snapshots* (current behavior, changeable with proof of intent). They fail differently, so they need different mechanics: an invariant red means "fix your code," a golden red means "prove you meant it."

## 3. The 5-vs-6 dead-end discrepancy — quantify over data, don't snapshot it

**What happened:** The CO2 results doc said "abstain on dead-ends: 5/5." Re-running the pilot against the committed fixtures before writing the test found **six** dead-end items, not five.

**Two lessons.** First, *verify claims against code before pinning them* — a regression suite built on an unverified writeup pins the writeup's errors forever. Second, the fix wasn't "change 5 to 6": the invariant quantifies over the corpus ("every dead-end abstains") instead of hardcoding a count. Property tests should range over the data; hardcoded counts turn fixture edits into false failures. The catch: pure properties can go *vacuous* (zero dead-ends → test passes trivially), hence the `deadEnds.length > 0` guard. Every "for all X" test needs an "and X is non-empty" companion.

## 4. The stub embedding provider — hermeticity through seams, flake relocation

**The decision:** The retrieval suite injects a fake `EmbeddingProvider` (zero vectors, dim 8) via `setProviderForTests()` instead of loading MiniLM. The whole gate runs in ~400ms.

**The tradeoff:** The gate exercises *zero* vector-ranking behavior. That's not a hole — it's deliberate relocation: the MiniLM load flake lives in Tier 2, where a retry-once policy is acceptable. A merge gate must never contain a known flake, because a flaky gate trains people to re-run reds until green, which destroys the gate's meaning.

**The principle:** Hermetic tests come from *dependency seams*, not mocking everything. And know exactly what the stub must be faithful to: zero vectors are safe *only because* vector weight is 0 and `hybridSearch` skips query embedding — that code path was verified before trusting the stub. A stub is a claim about what doesn't matter; verify the claim.

## 5. Pinned fixture copies — where DRY loses

**The decision:** Copied 130KB of consensus fixtures into `test/regression/fixtures/` instead of referencing `integrations/consensus-bench/src/__fixtures__/`, then excluded them from biome so even a formatter can't touch the bytes.

**The tradeoff:** Duplication is real — two copies can drift, and drift is normally the argument that ends the discussion. But a shared fixture means bench work (which *should* evolve its fixtures freely) silently changes what the merge gate tests.

**The principle:** A gate's inputs must change only deliberately. For regression fixtures, independence beats DRY. This generalizes: DRY is about *one source of truth for one fact* — the bench fixture and the gate fixture are the same bytes but different facts ("current bench corpus" vs. "the corpus behavior was pinned against").

## 6. The dirty-tree guard — mechanically enforced provenance

**The decision:** `regression:update-baseline` refuses to run unless `git status` is clean.

**The principle:** The baseline delta must be *attributable* — reviewable as "this commit caused exactly this behavioral change." On a dirty tree, the delta mixes committed and uncommitted causes and the audit trail is gone. The general move: when a workflow rule matters ("baseline changes travel with the PR that caused them"), enforce it in the tool, not in documentation. Conventions decay; `process.exit(1)` doesn't.

## The questions that generate these decisions

At spec/plan review, four questions would have surfaced all six calls before any code existed:

1. **"For each assertion: is it a promise or a snapshot?"** → produces the invariant/golden split (#2) and catches anything mis-filed.
2. **"Where does nondeterminism live, and which tier absorbs it?"** → produces goldens-not-thresholds for Tier 1 (#1) and the stub provider / flake relocation (#4).
3. **"What are this gate's inputs, and what can change them without a human deciding to?"** → produces fixture pinning (#5) and the biome exclusion.
4. **"Which numbers in this spec have been re-verified against the code, and which are quoted from a writeup?"** → catches the 5-vs-6 (#3) at design time instead of implementation time.

These are *gate-design* questions, not testing questions. The underlying fundamental: **a CI gate is a trust mechanism** — every decision above is really about who can change what, and whether that change is visible.
