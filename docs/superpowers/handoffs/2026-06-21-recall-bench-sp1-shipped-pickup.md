# Handoff — Recall Bench SP1 shipped; next: npm publish + gated benchmark run

**Date:** 2026-06-21
**Prev session:** ContextForge/Recall-Bench competitive dig → SP1 adapter built & merged → v1.26.0 released.

---

## TL;DR

- **v1.26.0 is tagged + GitHub-Released** (security #142 + reindex report-don't-coerce #143). **`npm publish` is the only thing left to ship it — that's your MFA/OTP step.**
- **SP1 Recall Bench adapter is merged** (#144) and lives on `main` at `integrations/recall-bench/`. It is benchmark tooling (`private`, not in the npm package).
- **The benchmark has not been run yet.** That's the one real open work item (gated on API keys). Everything else is done.
- Repo state: `main` @ `4ae7071`, clean. Session worktrees/branches/tmp-clones cleaned up.

## What shipped (all on `main`)

| PR | What | Notes |
|---|---|---|
| #142 | Security N/O/W — symlink confinement, staged-action write-gate, provenance RBAC | released in v1.26.0 |
| #143 | `reindex` reports invalid frontmatter instead of silently coercing; `ReindexResult.invalidFrontmatter` + `skipped: FlaggedDocument[]` | released in v1.26.0 |
| #144 | SP1 Recall Bench adapter (`integrations/recall-bench/`) | internal; NOT in npm package |
| #145 | release: v1.26.0 (version bumps + CHANGELOG) | merged; tag `v1.26.0` pushed; GitHub Release live |

Links: PRs `github.com/mavaali/daftari/pull/{142,143,144,145}`; Release `…/releases/tag/v1.26.0`.

## IMMEDIATE next action (yours)

```
# on main, at 1.26.0 across all four version sites — verified consistent
npm publish        # MFA/OTP; publishes daftari@1.26.0
```
Optional: attach a `.mcpb` to the GitHub Release via `npm run pack:mcpb` then upload — not done this session.

## The one open work item: SP1 Task 10 — run the benchmark (GATED)

SP1 = adapter + **baseline arm**. The adapter is built & tested; the *runs* (smoke + full EA-180d) are not done. They need keys + the external harness.

**Prereqs / setup from a cold start:**
1. Worktree + build (the adapter imports daftari's compiled `dist/**`):
   ```
   git worktree add -b feat/recall-bench-run <path> main
   cd <path> && npm install && npm run build
   npx tsc -p integrations/recall-bench/tsconfig.json   # builds the adapter → dist/index.js
   ```
2. Clone the external harness: `git clone https://github.com/Stevenic/recall.git /tmp/recall-review`
   (Steven Ickman / Microsoft; MIT. See `[[reference_recall_bench]]`.)
3. **Keys:** `ANTHROPIC_API_KEY` (the answerer is native Claude) + Azure judge creds (`AZURE_OPENAI_*`; profile uses `judge: azure:gpt-5.4-mini`, `appellateJudge: azure:gpt-5.4`). Same billed-key gap as the Stage-5 consolidate work.
4. **Before the run — close the one tracked code follow-up:** add a real `satisfies MemorySystemAdapter` typecheck in `integrations/recall-bench/src/adapter.ts` once the Recall Bench package is a dependency (conformance is currently hand-mirrored from the spec). See `integrations/recall-bench/README.md`.
5. Write the profile `ea-180d-daftari.yaml` (model after `/tmp/recall-review/packages/recall-bench/profiles/ea-180d-openclaw.yaml`; `harness.adapter` → built `integrations/recall-bench/dist/index.js`, `harness.factory: createDaftariAdapter`, `config.answererModel: <claude id>`).
6. **Smoke** first (3 ckpts, sample 10, no appellate) → then **full EA-180d** (30 ckpts, sample 50, appellate on; ~1–3 hrs; always `--json-out` for resume).
7. **DoD-critical:** confirm `contradiction-resolution` QAs are evaluated at ≥1 checkpoint *after* their revision day (e.g. Condor day-13–14) — else the headline analysis (does daftari return stale revisions?) has no data.
8. Write the results note: baseline composite + degradation curve + `contradiction-resolution` failure analysis, **stating the cross-system comparability caveat** (daftari runs native Claude + MiniLM vs the published gpt-5.4 + OpenAI-emb runs — clean claims are the within-daftari ablation + failure modes; cross-system numbers are directional only) AND that **SP1 is daftari's first retrieval-only eval** (`daftari eval` is answer-quality, no recall@k).

Spec & plan are on `main`: `docs/superpowers/specs/2026-06-20-daftari-recall-bench-adapter-design.md`, `docs/superpowers/plans/2026-06-20-recall-bench-adapter-sp1.md`.

## After SP1: SP2 → SP3 → SP4 (deferred; the real programme)

Three-arm ablation = the contribution. Each is its own spec → plan → impl. Carry-forward:

- **SP2 — supersession-aware ranking + Oracle arm.** Edit `src/search/hybrid.ts` (currently pure BM25+vector, supersession-blind). **LOAD-BEARING:** daftari has ZERO supersession edges in a raw corpus (`superseded_by` set only by explicit `vault_supersede`); acquisition is the real work, ranking is the easy half. Oracle arm injects edges from the benchmark's arcs / `irrelevantAfter` ground truth.
- **SP2 design nudge (from the spike):** the retrieval-grounding contract (extend `HybridHit` with chunk-id + char spans + a sufficiency flag) and supersession ranking are the SAME edit — do them in one pass; the contract outlives the benchmark. Keep `decay`/`superseded_by` as STRUCTURED sibling fields (don't flatten into `snippet`).
- **SP3 — auto-detect supersession during consolidation + Realistic arm** (the novel half). Detected edges enter as k=0 candidates and earn confidence via observe/contest ("surface, don't silently decrement").
- **SP4 — cross-arm synthesis + §6.1 writeup** for `[[project_daftari_paper]]`.
- **Five FIDELITY CONSTRAINTS bind SP2/SP3** (in the spec): (1) never hide history — soft downweight not hard exclude; (2) edge-based not recency-based; (3) earned confidence; (4) determinism preserved; (5) query-conditioned downweight (current-state preference only when the question asks for present state). SP2 must be feature-flagged, default-off, with production regression tests.

## Why this matters (framing)

Recall Bench's headline — sophisticated synthesis layers lose to plain source retrieval — cuts FOR daftari, which does NOT synthesize content (cortex loop emits edges, not prose). The failures are RANKING failures; ranking is daftari's job; daftari computes the decisive signals (`superseded_by`) but doesn't rank on them yet. SP2 is the first retrieval payoff of the edge graph.

## Memory pointers

- `[[project_recall_bench_experiment]]` — the programme (decomposition, decisions, status).
- `[[reference_recall_bench]]` — the external MSFT benchmark (what it measures, the finding, how to use it).
- `[[project_contextforge]]` — convergent competitor (deterministic-consolidation pole).
- `[[project_daftari_paper]]`, `[[project_exp1_info_vs_priors]]`, `[[project_cortex_consolidation_loop]]`.

## Cleanup done this session

Removed worktrees `daftari-recall-bench`, `daftari-release`; deleted merged branches `feat/recall-bench-adapter`, `chore/release-v1.26.0`, `spec/recall-bench-adapter`; removed `/tmp/{recall-review,contextforge-review,daftari-stale-untracked}`. Left `fix/reindex-validate-on-ingest` (merged — delete at will: `git branch -d fix/reindex-validate-on-ingest`).
