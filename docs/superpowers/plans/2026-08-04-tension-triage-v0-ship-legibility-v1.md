# Tension Triage — v0 Ship + Legibility v1 Plan

**Status:** CORRECTED 2026-08-04 — **v0 is already SHIPPED** (PR #334, `054542c`, merged 2026-08-03 to `origin/main`). Part A below is DONE; the "unmerged/disclosure-held" premise was stale (carried from the 2026-08-02 design note). Real remaining work = **Part B (legibility v1)** only. The local `feat/tension-triage-card` branch is now a stale duplicate (11-ahead/1-behind, also carries the tabled compiler-arm) — leave it; Mihir's.
**Disclosure:** MOOT for v0 — already public on main. (Applies only to the parked learned-ranker artifacts.)
**Replaces:** the parked learned-ranker spec (`docs/superpowers/specs/2026-08-04-learned-tension-ranker-design.md`).
**Origin:** stress-test (2026-08-04) killed the learned ranker; Mihir's own design doc already prescribed the path — *legibility card → let the human rank → maybe learn later*. This plan executes that: ship v0, then make v1 a richer **legibility** layer, not a model.

---

## Why this shape (the verdict in one line)

A learned ranker trained on resolution latency compiles a confounded signal (latency ≈ ease/recency, not priority), can't activate without data v0 must first generate, and re-centralizes ranking — contradicting the design doc's own conclusion. **Legibility (surface each tension's cost; the human orders) has none of those failure modes.** Ship the thin, correct layer; defer the clever, fragile one.

---

## Part A — Ship v0 (the legibility card) — ✅ DONE (already shipped)

**SHIPPED as PR #334 (`054542c`, merged 2026-08-03 to `origin/main`).** `court --triage` (unranked enriched card) + `vault_tension_triage` MCP tool, engine `src/curation/tension-triage.ts`, read-heat `src/curation/read-heat.ts` are all live on main. The A0 decisions below (branch hygiene, disclosure) are therefore MOOT — kept for the record only. The card is already accruing triage/resolution behavior (Part B's data prerequisite is met).

<details><summary>Original Part A (now moot — kept for record)</summary>

### A0 — Two decisions for Mihir (blockers, his call — do NOT auto-execute)

- **A0.1 — Branch hygiene.** `feat/tension-triage-card` is 2 ahead / 1 behind `origin/main`. Its two unique commits are `545b48f` (the triage feature — what we want) **and** `c70908c` (recall-bench compiler-arm Phase 1 — the eval work you just TABLED). Shipping the branch as-is lands the tabled compiler-arm too. Options:
  - **(rec) Cherry-pick just `545b48f`** onto a fresh branch off `origin/main` → ships v0 alone, leaves the compiler-arm on its own branch for later.
  - Rebase the branch to drop `c70908c` (riskier; rewrites the pushed branch).
  - Ship both (only if you're fine landing the compiler-arm scaffolding now).
- **A0.2 — Disclosure.** The branch is already pushed to `origin` (`mavaali/daftari`). Merging to `main` + any README mention is the visible disclosure the design doc guarded. Confirm: land v0 to main now (feature is generic legibility — arguably fine to disclose; the *learned ranker* was the moat, and it's parked), or keep it on a branch until you decide. My read: **v0 is safe to disclose** — it's a legibility card, not the priority-learning moat. Your call.

### A1 — Land sequence (only after A0, executed WITH you, step by step)

1. Rebase/cherry-pick per A0.1; bring the branch up to `origin/main` (resolve the 1-behind).
2. Verify green on the landed state: `npm run build` (tsc clean) + `npm test` (full vitest suite) + live smoke of `daftari court` (ranked default), `daftari court --triage` (unranked card), and the `vault_tension_triage` MCP tool (empty + non-empty vaults).
3. Confirm the architecture doc tool count (34 → 35) and `test/server.test.ts` guard match.
4. Open the PR (CI-gated main per your ruleset; the 4 required checks). Merge on green — no human approver required per your release-autonomy note, but this is a FEATURE not a release, so I'll surface the PR for your eyeball before merge.
5. Handoff note `docs/plans/2026-08-01-tension-triage-card-RESUME.md` (currently untracked) — fold its live content into the PR description, then drop the file.

### A2 — Instrument the data source (small, do at ship)

v1 legibility needs signal to be worth it, and any *future* reconsideration of a learned ranker needs behavior data. At v0 ship, confirm the read-log (`.daftari/read-log.jsonl`) and resolution log (`.daftari/tensions.md`) are capturing: (a) every `vault_tension_triage` / `court --triage` invocation, (b) resolution acts with timestamps. This is the "plant the sensor before you need the reading" step. No new schema — verify existing logs suffice; add a triage-view log line only if absent.

</details>

---

## Part B — Legibility v1 (richer card, NO model)

v1 adds the signals the design doc deferred from v0, keeping the card unranked and the human in the ranking seat. Each is a *legibility* addition — makes a tension's cost visible — not an automation.

### B1 — Requirements (from `daftari-tension-resolution-design.md`, deferred list)

- **R1 — Domain criticality.** The one signal the graph can't infer: cost-of-being-wrong (pricing/legal/security = load-bearing vs scratch note). Needs an explicit source — a `criticality` tag/folder/field convention. Surface it on the card. (Design decision needed: tag vs folder vs frontmatter field — see B3.Q1.)
- **R2 — Provenance per side.** Trusted-human-last-week vs old agent-scrape. Already carried by `provenance` / `witness`; join it onto each `TriageSide` next to tier/confidence.
- **R3 — Recommended-resolution-kind (advisory, never auto-applied).** The unencoded mapping the design doc named: temporal→superseded, factual→corrected|invalid, interpretive→accepted. Show it as a *hint* on the card ("likely: deprecate the older doc"), explicitly advisory. This is legibility, not a decision.
- **R4 — Composite-cost legibility (NOT a score/rank).** Present blast + tier + read-heat + kind + criticality together as one glanceable cost picture per tension. The human ranks; the card does not pre-order. (This is the design doc's "legibility card" endpoint.)

### B2 — Thesis-safety invariants (carried, non-negotiable)

- Unranked. The card surfaces cost; it never orders the queue for the human. (`court` keeps its transparent hand-tuned default; `--triage` stays unranked.)
- Every added signal is advisory and sourced — no minted values, no auto-apply, no "resolve all."
- `accepted` remains a terminal success; the metric is un-triaged, not un-closed.

### B3 — Open questions (resolve before B is planned)

- **Q1 — Where does criticality live?** tag (cheap, fuzzy) vs folder (coarse) vs explicit frontmatter field (precise, schema change). Recommend a `criticality: low|medium|high` frontmatter field — inspectable, lintable, one source of truth. Decide with you.
- **Q2 — Is R3's mapping stable enough to show as a hint** without nudging humans toward premature closure (the design doc's own worry)? Frame as "common resolution for this kind," not "do this."
- **Q3 — Read-heat single-node caveat** stands (git-ignored local log); fine for solo operator, note it.

### B4 — What v1 explicitly is NOT

- Not a learned ranker (parked, see the spec header for why).
- Not a composite severity *score* or auto-ordering.
- Not resolution automation.

---

## Sequencing (the whole point)

1. ~~A0 decisions~~ / ~~Ship v0~~ — **DONE**: v0 shipped as #334 (2026-08-03); it's already running and accruing triage/resolution behavior.
2. **Decide legibility-v1 card shape** — esp. B3.Q1 (where criticality lives: recommend a `criticality` frontmatter field). Your call.
3. **Plan + build legibility v1** (Part B) — take B through the writing-plans skill into TDD units once B3.Q1 is locked.
4. **Only then**, if ever, reconsider a learned ranker — with a real priority label (not latency) and a non-circular eval.

Displacement named: this displaces the learned-ranker build (parked) and defers the compiler-arm (already tabled). It commits to the thin-correct layer over the clever-fragile one — deliberately.
