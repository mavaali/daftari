# Handoff — Cortex loop Stage 5 pickup (2026-06-19)

**Read first:** the auto-memory `project_cortex_consolidation_loop` (loaded each session) has the full arc. Start the Stage-5 session with **ask-permissions** (commit-bearing; the uatu hook blocks commits in don't-ask mode — `reference_uatu_commit_hook`).

## Where things stand

- **Stages 1–4 SHIPPED.** Stage 1 (C scheduler) + Stage 2 (Component A) in v1.22.0; Stage 3 (envelope live-but-shadowed) in v1.23.0; **Stage 4 (B coverage/equity instrumentation) shipped as v1.25.0** ([PR #140](https://github.com/mavaali/daftari/pull/140) merged `db5ad04`; release commit `164eca1`, tag `v1.25.0`, GitHub Release published). **npm publish of 1.25.0 may still be pending — check `npm view daftari version`** (Mihir's MFA step, `reference_daftari_release_ritual`).
- **main is clean** at the v1.25.0 release commit. Build + lint + ~1247 tests green.
- Stage 4 shipped a read-only `coverageEquity` monitor on `vault_lint` (`src/curation/coverage.ts`). **This is the instrument Stage 5 reads while shadow runs** — it makes the budget-drift ratchets legible before any auto-write graduates.

## ⚠️ The prerequisite — DON'T start by writing code

Stage 5 = **calibrate-from-shadow → graduate the auto-write tier → CLAUDE.md charter amendment** (spec §12.5, §10, §14). The first word is *calibrate-from-shadow*: the shipped constants are placeholders, and §10 sets *how* they're tuned, not *what* they are. **Calibration needs accumulated shadow data — real `daftari consolidate` runs against a real vault, accruing `.daftari/shadow-actions.jsonl` rows over a working window.**

**So the FIRST action of the Stage-5 session is to check whether that data exists yet**, not to brainstorm code:

1. Find the vault(s) Mihir actually runs the loop against (NOT this repo — the loop runs against his markdown vault). Check `.daftari/shadow-actions.jsonl` there for volume + variety of envelope/edge-op rows.
2. **If shadow data is thin** (likely): the real next move is to *run the loop in `shadow_mode` for a window* — now that the Stage-4 coverage monitor exists to watch it — THEN calibrate. Stage 5 is **blocked on accumulating shadow data**, not on coding. Say so plainly rather than coding against an empty journal.
3. Only once there's a real shadow corpus does the §10 tune→graduate work begin. Treat this as a brainstorm-worthy, high-stakes stage (it's the charter amendment), not a mechanical pickup.

## The §10 calibration protocol (verified against spec 2026-06-19)

1. Run the loop in `shadow_mode` over a real working window (every would-be `do()` logs `{i_base, blast, impact, budget, spent_before, would_gate, diff}`).
2. **Re-segment sessions offline** — the §11.5 v1 limit is "session = process lifetime"; every record stores `spent_before`+`budget`, so true session boundaries (idle-gap / reset) are recoverable post-hoc.
3. **Tune against B's quality/variance + coverage metrics (§6)** — the Stage-4 `coverageEquity` summary is exactly this surface.
4. **Graduate** the auto-write tier out of shadow only after the table stabilizes.
5. **Re-calibrate quarterly** (§9), refreshing the recall set (§7) alongside.

**POISON CONSTRAINT (load-bearing):** calibration is **NEVER** tuned to raise B (design §3). It's tuned so the *envelope's variance/coverage behavior* matches design intent. B is a monitor, never a target.

## The constants being calibrated (all provisional; single-sourced, verify before editing)

- **Envelope** (`src/curation/shadow.ts`): `SHADOW_I_BASE` table (:54), `SHADOW_K_BLAST`=0.05 (:68), `SHADOW_BLAST_ALPHA`=1.5 (:69), `SHADOW_B0_BASE`=0.5 (:72), `SHADOW_B0_PER_PENDING`=0.25 (:73).
- **Scheduler** (`src/consolidate/constants.ts`): `CONSOLIDATE_SLICE_FRACTIONS` (backstop .25 / main .45 / periphery .15 / birth .15, :23), `CONSOLIDATE_PANEL_SIZE`=2 (:38, the panel M), `CONSOLIDATE_MIN_INTERVAL_DAYS`=1 (:8), `CONSOLIDATE_MAX_INTERVAL_DAYS`=90 (:9), `CONSOLIDATE_DEFAULT_BUDGET`=50 (:32), `CONSOLIDATE_PATH_STRENGTH_FLOOR`=0.1 (:18).
- **Edge model** (`src/curation/edges.ts`): `EDGE_K_CAP`=5 (:63), `EDGE_HALF_LIFE_DAYS`=90 (:68) = the aging rate, `EDGE_TRIGGER_STRENGTH`=0.5 (:73).
- Shadow journal: `.daftari/shadow-actions.jsonl` (`shadowActionsPath`, shadow.ts:75) — append-only, one JSON record per would-be write.

## The CLAUDE.md charter amendment (§14 — REQUIRED, lands with Stage 5, not before)

`CLAUDE.md` currently asserts: *"The curation engine is advisory. `vault_lint` reports problems. It does not auto-fix."* Stage 5's auto-write tier amends this. The amendment must be **explicit**: the engine is advisory **until an action clears both envelope gates inside a calibrated budget**, at which point the loop may auto-write the **low-`I` tier**; all higher-`I` actions stay staged for human ratification. The **never-delete, B-is-monitor, and never-optimize-the-measure invariants are unchanged.** (Charter is still UNCHANGED today — correct.)

## Carried items

- **Shadow stuck-pending-rate** (option-c over-production on the ambiguous tail, ~71–75% order-consistency edges routed to symmetric with no automated re-convergence) gates the shadow-OFF graduation. **Stage 4's `directionResolution` metric (symmetric / unresolved fraction) is now a standing proxy for this** — read it off `coverageEquity` during the shadow window.
- **Stage 6** (recall set + §6.1 comprehension-load ablation) is **gated on the second qualified rater** (§13) — NOT part of Stage 5.

## Ritual (per spec §12 / every stage)

brief (`docs/superpowers/drafts/`) → spec/plan if non-trivial → **TDD** → **two general-purpose adversarial reviewers** (NOT squad agents — broken tool bindings, `reference_squad_agents_broken_tools`; and verify reviewer claims against source — the uatu hook has injected fabricated audit findings into reviewer tool results in past stages) → fix → PR to main → release. Run with **ask-permissions**. CI Node-20 has a known onnxruntime/MiniLM flake (`reference_ci_embedding_model_flake`) — re-run, don't assume regression. npm publish is Mihir's MFA step.
