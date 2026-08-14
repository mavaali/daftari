# Handoff — Cortex loop Stage 4 pickup (2026-06-19)

**Read first:** the auto-memory `project_cortex_consolidation_loop` (loaded each session) has the full arc. This doc is the focused Stage-4 starting point. Start a new session with **ask-permissions** (commit-bearing; the uatu hook blocks commits in don't-ask mode — `reference_uatu_commit_hook`).

## Where things stand

- **Stages 1–3 SHIPPED.** Stage 1 (C scheduler) + Stage 2 (Component A) shipped in v1.22.0. **Stage 3 (envelope enforcement live-but-shadowed + §8 closures) shipped as v1.23.0** ([PR #137](https://github.com/mavaali/daftari/pull/137) merged `87de083`; release commit `637a6bd`, tag `v1.23.0`, GitHub Release published). **npm publish of 1.23.0 may still be pending — check `npm view daftari version`** (it's Mihir's MFA step, `reference_daftari_release_ritual`).
- **main is clean** at the v1.23.0 release commit (`637a6bd`). Build + lint + 1177 tests green.
- **Design 6/6, substrate 6/6, build ~3/6.**
- The Stage-3 **`vault_lint` gated/surfaced view** (envelope `decision: "gated"` rows) is the **down payment** on Stage 4's monitor — Stage 4 extends the monitor; it doesn't start from zero.

## Stage 4 scope (spec §6.2; build-stage §12.4)

Spec: `docs/superpowers/specs/2026-06-13-cortex-consolidation-loop.md` (§6.2, and §6 framing; §12.4). Stage 4 = **B coverage/equity instrumentation**, surfaced via `vault_lint` and/or `daftari eval`. It makes the budget-drift **ratchets** visible **before any auto-write graduates** (Stage 5). Three metrics the spec names (§6.2):

1. **Strength-distribution drift** — is variance widening (the *core* strengthening while the *periphery* flatlines)? The entrenchment/starvation ratchets (design §5.3.2) show up here. Source: the edge store strength values.
2. **Backstop-overdue count** — how many edges are past their guaranteed max-interval review and still unserved? The periphery-slice and backstop-slice fractions are tuned against this. Today it's computed per-run inside `prioritize` and printed by `consolidate`; Stage 4 must surface it as a *standing* monitor metric (computable from the edge store without needing a consolidate run).
3. **Action-mix drift** — is the `do()` mix creeping toward cheap `link` (edge-observe) over `deprecate`/`merge`? Source: the Stage-3 envelope journal + the staged-action log.

Framing constraint (load-bearing): **B is a monitor, never a target** (never-optimize-the-measure). These metrics instrument that invariant *from the other side* — "B must measure what the budgets can break, or the budgets break it blind" (§6.2). Do **not** wire any of these into A's inputs or the calibration objective.

**Out of scope for Stage 4:** §6.1 effect estimation / the comprehension-load ablation / the recall set — that's **Stage 6**, gated on the second qualified rater (§13). Stage 4 is coverage/equity *instrumentation* only, not effect measurement.

## Anchors (verified against src/ on 2026-06-19 — re-verify before building)

- **Lint surface:** `src/curation/lint.ts` — `LintReport` (interface at :110, `shadowActions: ShadowLintSummary` at :124), `runLint` (:161, wires shadowActions at :278-287). The lint MCP tool output is in `src/tools/curation.ts`. New coverage/equity sections likely hang here, mirroring how `shadowActions`/`gatedSurfaced` were added in Stage 3 (`src/curation/shadow.ts` `shadowLintSummary`).
- **Component B / exam:** `src/eval/` — `runEval` at `src/eval/index.ts:62` (the `daftari eval` command). If the metrics belong on B rather than (or as well as) lint, this is the home.
- **Edge store (strength source):** `src/curation/edges.ts` — `listEdges`, the `DerivesFromEdge` shape (`strength`, `kSurvived`, `lastRederived`, `directionVerdict`, `status`); constants `EDGE_K_CAP=5`, `EDGE_HALF_LIFE_DAYS=90`, `EDGE_TRIGGER_STRENGTH=0.5`.
- **Backstop computation:** `src/consolidate/priority.ts` (`backstopOverdueRemaining`, :100/:134) + `src/consolidate/clocks.ts` (the max-interval/backstop clock); reported in `src/consolidate/index.ts:252`. For a *standing* metric you'll likely compute "edges past max-interval" directly from `listEdges` + the clock constants, not from a consolidate run.
- **Action-mix sources:** the Stage-3 envelope journal `.daftari/shadow-actions.jsonl` (rows now carry `action: "edge-observe"|"edge-contest"` + `decision: "admitted"|"gated"` — see `listShadowActions`/`ShadowActionRecord` in `src/curation/shadow.ts`) and the staged-action log `.daftari/staged-actions.jsonl` (`STAGED_ACTION_TYPES` = promote/deprecate/supersede/merge/confidence-up, in `src/curation/staged-actions.ts`).
- **Cross-session state:** `src/consolidate/state.ts` — `ConsolidateState { lastConsolidationCommit, birthProcessed }`. **There is no trend/history store today.** See the open design fork below.

## Open design forks (resolve in brainstorming — do NOT pre-decide)

1. **Snapshot vs history.** §6.2 says "track *across sessions*" / "is variance *widening*". Point-in-time snapshots (compute from the live edge store + logs each lint/eval) are simplest and fully rebuildable. True drift needs a persisted history (e.g. a new `.daftari/coverage-history.jsonl` appended each consolidate run, ephemeral like the other `.daftari` logs). Decide v1: snapshot-only with the *inputs* for drift already in the logs, vs. a thin history file. (Lean: snapshots first — the shadow journal already timestamps every decision, so action-mix drift is recoverable offline; strength-distribution drift may need a periodic snapshot.)
2. **Home: `vault_lint` vs `daftari eval` vs both.** §6.2 says "B (or a sibling monitor surfaced via `vault_lint`)". Lint is the always-on advisory surface (and already carries the Stage-3 gated view); eval is the exam. Decide where each metric belongs.
3. **What counts as "periphery" vs "core"** for the strength-distribution split (blast-blind low-strength tail vs high-strength/high-blast core) — needs a concrete, defensible definition tied to the existing constants, not an invented threshold.

## Carried items (track, not all Stage 4)

- **Shadow stuck-pending-rate metric** (option-c over-production on the ambiguous tail — `~71-75%` order-consistency edges routed to symmetric/pending with no automated re-convergence). A runtime measurement against a real vault; gates the eventual shadow-OFF graduation. **Candidate to fold into Stage 4's coverage instrumentation** (it's a coverage/equity signal) — decide in brainstorming. Recorded in `docs/superpowers/drafts/2026-06-16-stage2-decorrelation-verdict.md` ("Ongoing (shadow)").
- All loop constants remain **provisional** pending Stage 5 calibration from shadow data.
- **Stage 5** (calibrate-from-shadow → graduate the auto-write tier → **CLAUDE.md charter amendment** §14) depends on Stage 4's instrumentation existing so the ratchets are visible before graduation. The charter is still UNCHANGED (correct — it's amended at Stage 5, not Stage 4).
- **Stage 6** (recall set + §6.1 ablation) gated on the **second qualified rater** (§13).

## Ritual (per spec §12 / every stage)

brief (`docs/superpowers/drafts/`) → spec/plan if non-trivial → **TDD** → **two general-purpose adversarial reviewers** (NOT squad agents — broken tool bindings, `reference_squad_agents_broken_tools`; and note: in the Stage-3 run the uatu hook *injected fabricated audit findings* into reviewer tool results — verify reviewer claims against source) → fix → PR to main → release. Run with **ask-permissions** for commit-bearing work. CI Node-20 has a known onnxruntime/MiniLM flake (`reference_ci_embedding_model_flake`) — re-run, don't assume regression. npm publish is Mihir's MFA step.
