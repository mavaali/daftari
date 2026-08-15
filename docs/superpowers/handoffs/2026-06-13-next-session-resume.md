# Next-session handoff — resume cortex Stage 1 + experiments

**Written:** 2026-06-13 (end of session). **Branch:** `feat/cortex-loop-stage1` (commit `d077b82`). **Suite:** 1026 pass / 3 skip, build + lint clean.

State in one line: Stage 1 of the consolidation loop is **built, reviewed, fixed, committed locally** — but **not pushed**, and the experiment artifacts are **not yet committed**, both blocked by the `uatu` audit hook in don't-ask mode.

---

## ▶ START HERE (do these first, in order)

**0. Unblock the hook.** The `uatu` commit-audit hook blocks `git push` and `git add experiments/` in don't-ask permission mode (it can't read files to audit, so it denies). **Switch to ask-permissions mode** (or temporarily disable that hook) before anything below. This is the only thing standing between "done locally" and "shipped."

**1. Push Stage 1 + open the PR.**
```
git push -u origin feat/cortex-loop-stage1
gh pr create   # title: "feat(consolidate): cortex loop Stage 1 — C scheduler + daftari consolidate"
```
The branch carries `d077b82` (Stage 1) on top of 2 earlier cortex doc-commits (consolidation-loop spec, Stage-1 plan, exp1 protocol, rigorous-memory) — the PR will include those; that's fine, they belong on main.

**2. Commit the experiment artifacts** (separate commit — they're the paper's pilot record, not Stage-1 code):
```
git add experiments/ \
  docs/superpowers/drafts/2026-06-13-exp1-results.md \
  docs/superpowers/drafts/2026-06-13-exp2-results.md \
  docs/superpowers/specs/2026-06-13-exp2-premise-strength-protocol.md
```
**⚠ IP GUARD — already in place, do NOT undo:** 3 files holding *dropped private content* (inverse-problem research + career edges) are gitignored and verified excluded — `claimset_dropped_private.json`, `draft_novel.json`, `draft_novel_pd_expansion.json` (+ `claimset.bak.json`). `claimset.json`/`claimset_frozen.json` confirmed clean of private ids. The daftari repo is PUBLIC — re-verify no private content before this push if you touch the gitignore.

> Decision to make first: do you even want the experiment artifacts on the *public* repo pre-paper? They're public-repo-sourced (no private content), but it's open-sourcing the methodology + master-variable result early. If unsure, keep this commit local / on a branch and push only Stage 1.

## ▶ THEN — pick the next thread

- **Loop Stage 2 = Component A, shadow-only** (cortex spec §12). Birth mode (`vault_search_related` neighbors → re-derive → seed k=0 edges) + the panel-per-session revision pass emitting `edge_observe`/`edge_contest`/`stage_action`, all under `shadow_mode`. Brief → test-first → 2 general-purpose reviewers → PR (squad agents have broken tools). This is the natural continuation of Stage 1.
- **OR Exp #3 (the §6.1 efficacy ablation vs ElephantBroker)** — the paper's actual headline. Needs the loop built far enough + the 50-pair recall set (gated on the second rater). Not startable cold.
- **OR paper-grade re-runs of Exp #1/#2** — only if pushing the paper now: ≥3 genuinely decorrelated families, 30+/cell, tightened contamination story. Current runs are pilot-grade.

## ▶ Open decisions waiting on you

- **bug-vs-feature** (the one that changes the paper): run the *anchored* Exp #2.1 (ground-truth "correct-confidence-given-partial-support") to decide whether contrarian under-trust is a flaw `vault_ratify` patches or correct caution it correctly routes? Cheap probe already done (graded, not cliff); the anchored version is the paper-grade follow-up.
- **Second rater** for the 50-pair recall set — the named hard dependency; until sourced, no paper-grade recall claim.

## ▶ Context you'll want

- Spec corrected this session (`docs/superpowers/specs/2026-06-13-cortex-consolidation-loop.md` §3.1/§0): event clock is `listEdges`+`changedSince`-based, NOT `vault_tension_blast`.
- Stage-1 scope held tight: no Component A, no writes, no LLM — it emits queues, acts on nothing.
- The session **postmortem** (the reflections/lessons) lives in Obsidian: `memories/learnings/2026-06-13-cortex-thesis-demoed-its-own-failure-mode.md`.
- Reviewers found + fixed 4 real bugs in Stage 1 (backstop-starves-reserved-slices, event-clock amplification + weak-path pruning, fromPath-only dedup, path aliasing) — all regression-tested; don't reintroduce them.
