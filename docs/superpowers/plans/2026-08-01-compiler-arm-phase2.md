# Compiler Arm — Phase 2 (`compile: "write+consolidate"`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** `finalizeIngestion` for `compile:"write+consolidate"` runs daftari's real consolidation (`--mode both`) after authoring, so the read-time edge graph + tension log are populated — the retrieval-time half of the thesis.

**Architecture:** Extends Phase 1. `write+consolidate` = the `write` authoring path per day, then in `finalizeIngestion`: reindex → enable real consolidation in the tmp vault → print projected LLM-call count → `runConsolidate(--mode both --max-llm-calls N)` via OpenRouter transport → reindex again. Guarded so it can only mutate an ephemeral tmpdir vault.

**Tech Stack:** TS/vitest; `runConsolidate` from `../../../dist/consolidate/index.js` (CLI-style argv, returns exit code); `.daftari/config.yaml` `shadow_mode` key.

**Spec:** `docs/superpowers/specs/2026-07-31-recall-bench-compiler-arm-timestamp-baseline-design.md` — Design decision 3 + Phase 2. **Key facts (verified):** non-scan modes REQUIRE `shadow_mode` explicitly set in `.daftari/config.yaml` or consolidate refuses (`index.ts:334`); `shadow_mode: false` = edges/tensions land for real; `--max-llm-calls` caps Stage-2 spend; birth ≈ 40 LLM calls/item.

---

## Task 1: `maxLlmCalls` config axis (TDD)
**Files:** `config.ts` (+ `config.test.ts`). Mirror the existing axes.
- [ ] Failing tests: `maxLlmCalls` defaults (choose a safe default, e.g. `40`); honors a positive-int override; rejects non-positive/non-int (reuse `asPositiveInt`). Update the two full-shape `toEqual`s.
- [ ] Run → RED. Implement (add field + default + validation + include in `ok`). Run → GREEN + full suite.
- [ ] Commit: `feat(recall-bench): maxLlmCalls config axis`.

## Task 2: tmpdir-guarded real-consolidation enabler (TDD, hermetic)
**Files:** Create `consolidate-config.ts` (+ test). Reuse `isUnderTmpdir` from `adapter.ts`.
- [ ] Failing tests: `enableRealConsolidation(vaultRoot)` (a) THROWS if `vaultRoot` is NOT under `os.tmpdir()` (safety — never flip a real vault's shadow default); (b) when under tmpdir, writes/merges `shadow_mode: false` into `<vault>/.daftari/config.yaml` PRESERVING any existing keys, and returns/logs a loud line naming the path. Test with a real mkdtemp vault (no network).
- [ ] Read how consolidate parses `.daftari/config.yaml` (`src/utils/config.ts` `shadowMode`/`shadowModeSet`) to match the exact key name + YAML shape.
- [ ] RED → implement (mkdir `.daftari`, read-merge-write YAML) → GREEN. Commit: `feat(recall-bench): tmpdir-guarded real-consolidation enabler`.

## Task 3: projected-call-count + wire finalizeIngestion (TDD)
**Files:** `adapter.ts` (+ `adapter.test.ts`). Read `runConsolidate` signature/flags in `../../../dist/consolidate/index.js` (`--mode`, `--max-llm-calls`, the vault flag, and the transport flag — it has an anthropic|openrouter switch; use openrouter).
- [ ] Failing tests (hermetic): a pure `projectedConsolidateCalls(noteCount)` (≈ birth 40/item; document the formula) returns the expected number; and the `write+consolidate` branch no longer throws the Phase-2 error (replace the stub). The REAL `runConsolidate` call is exercised only in the RB_INTEGRATION smoke (Task 4) — here, inject a seam so `finalizeIngestion` can be unit-tested without spending: e.g. accept an optional `runConsolidateFn` dep (default the real one) and assert in a hermetic test that write+consolidate calls it with `--mode both --max-llm-calls <cfg> --transport openrouter` and the right vault, AFTER `enableRealConsolidation`.
- [ ] Implement finalize for `write+consolidate`: reindex → `enableRealConsolidation(vaultRoot)` → `console.error`/log the projected call count → `runConsolidateFn([... --mode both --max-llm-calls cfg.maxLlmCalls --transport openrouter ...])` (throw if non-zero exit) → reindex again → assertCleanReindex (ignore scaffolding, as in Phase 1). Keep `raw` and `write` byte-identical.
- [ ] RED → GREEN (full suite) → `npx tsc -p integrations/recall-bench/tsconfig.json` exit 0. Commit: `feat(recall-bench): consolidate --mode both in finalize for write+consolidate`.

## Task 4: integration smoke (RB_INTEGRATION, real spend ~cents)
**Files:** `consolidate.integration.test.ts` (gated on `RB_INTEGRATION` + `OPENROUTER_API_KEY`).
- [ ] Ingest a small fixture (3 days, one with a contradiction to exercise tensions) with `compile:"write+consolidate"`, `answererTransport/authoring via openrouter`, `answererModel: anthropic/claude-haiku-4.5`, `agentMaxIterations: 24`, `maxLlmCalls: 40`.
- [ ] After `finalizeIngestion`: assert the consolidation produced structure — `vault_search`/`vault_tension_clusters` (or reading `.daftari/edges` + `tensions.md`) returns NON-EMPTY related/contested structure; assert teardown leaves nothing on disk; assert the projected-call line was printed and actual calls ≤ `maxLlmCalls`.
- [ ] Run: `export OPENROUTER_API_KEY=$(grep -o 'sk-or-v1-[a-f0-9]*' /Users/mihirwagle/.zshenv | head -1) && RB_INTEGRATION=1 npx vitest run integrations/recall-bench/src/consolidate.integration.test.ts` (check balance first; do not print the key). If consolidate produces no edges/tensions on the fixture, that's a real finding → DONE_WITH_CONCERNS with what landed.
- [ ] Commit: `test(recall-bench): consolidate smoke — edges/tensions populated end-to-end`.

---

## Guardrails
- **No Phase 3** (the A/B/C/D full run) — that's a separate plan.
- Every consolidate invocation carries `--max-llm-calls`; print the projection before running.
- `enableRealConsolidation` MUST refuse any non-tmpdir vault.
- Open a PR at the end; do not merge without CI green + Mihir's ok.

## Notes
- Worktree `.worktrees/timestamp-baseline`, branch `feat/recall-bench-consolidate-arm` (off main, Phase 1 present). deps/dist symlinked; `.env` has `OPENROUTER_API_KEY`. Rebuild adapter after TS edits.
