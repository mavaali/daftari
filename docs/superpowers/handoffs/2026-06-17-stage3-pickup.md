# Handoff — Cortex loop Stage 3 pickup (2026-06-17)

**Read first:** the auto-memory `project_cortex_consolidation_loop` (loaded each session) has the full arc. This doc is the focused Stage-3 starting point.

## Where things stand

- **Stages 1–2 SHIPPED.** Stage 1 (C scheduler, `daftari consolidate`) on main via PR #135. Stage 2 (Component A — birth + revision + shadow + decorrelation + the reliable `derives_from` direction rework) shipped as **v1.22.0** (PR #136, tag `v1.22.0`, GitHub Release published). npm publish is Mihir's MFA step (may or may not be done yet — check `npm view daftari version`).
- **main is clean** at the v1.22.0 release commit (`a011ad6`). Build + lint + 1125 tests green.
- **Design 6/6, substrate 6/6, build 2/6.**

## Stage 3 scope (spec §5 envelope + §8 closure; spec line 476)

The full spec is `docs/superpowers/specs/2026-06-13-cortex-consolidation-loop.md`. Stage 3 = **envelope enforcement + the §5.4 / §8 audit-trail closures**, three pieces:

1. **Two-gate enforcement wired live, still shadowed (§5).** Today shadow mode only *computes* the gates — `recordShadowAction` (`src/curation/shadow.ts`) records `impact` (I), `budget` (B₀), and `would_gate` but enforces nothing. Stage 3 wires the actual **two-gate envelope** so an action is admitted only when BOTH gates pass: (a) the **invariants** gate (the structural rules the loop must never violate), and (b) the **trust-budget** gate (deduct I per `do()`, checkpoint→surface on exhaustion). Enforcement runs live while writes stay in the shadow posture — i.e. the gate decides, the write is still logged-not-applied. The `would_gate` field becomes a real gate.

2. **`decided_by_principal` (§5.4 first bullet, §8).** A *reject* dispatches no write and a *contest* writes no provenance entry, so today both record only the free-text `ratifiedBy`/`contested_by`, not the authenticated `principal` (the §11.6 principal work landed in v1.21.0 but didn't cover pure-verdict outcomes). Add `decided_by_principal` to the **staged-action decision record** and the **contest tension**. Anchors: `src/curation/staged-actions.ts` (decision record), `src/access/rbac.ts` (the principal/`canRatify` plumbing), the contest path in `src/tools/edges.ts` / `src/curation/edges.ts`.

3. **Gate `vault_tension_resolve` on `canRatify` for loop-created tensions (§5.4 second bullet, §8).** `vault_edge_contest` is `ratify`-gated, but resolving the tension it creates is any-read — a loud contest can be resolved away a trust tier down. Gate `vault_tension_resolve` on `canRatify` **for loop-authored tensions** (those `loggedBy: agent:curation-loop`), closing the asymmetry. Anchor: `src/tools/curation.ts` (`vault_tension_resolve` handler), `src/access/rbac.ts` (`canRatify`).

## Ritual (per spec §12 / every stage)

brief (`docs/superpowers/drafts/`) → spec/plan if non-trivial → **TDD** → **two general-purpose adversarial reviewers** (NOT squad agents — broken tool bindings, see `reference_squad_agents_broken_tools`) → fix → PR to main → release. Run with **ask-permissions** for commit-bearing work (the uatu hook blocks/misfires otherwise — `reference_uatu_commit_hook`). CI Node-20 has a known onnxruntime/MiniLM flake (`reference_ci_embedding_model_flake`) — re-run, don't assume regression.

## Carried items (not Stage 3, but track)

- **Shadow stuck-pending-rate metric** (option-c over-production on the ambiguous tail) — a runtime measurement against a real vault; feeds Stage 5 graduation, gates shadow-OFF. Recorded in `docs/superpowers/drafts/2026-06-16-stage2-decorrelation-verdict.md` ("Ongoing (shadow)").
- All loop constants remain **provisional** pending Stage 5 calibration from shadow data.
- Stage 6 (recall set + §6.1 ablation) is gated on a **second qualified rater** (§13).
