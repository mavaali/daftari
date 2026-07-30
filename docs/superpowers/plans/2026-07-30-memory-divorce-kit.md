# Memory divorce kit — the model-swap stunt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship "same memory, three brains, scored." Two thin parts on existing machinery: (1) a provider-memory importer that adopts a ChatGPT/Claude memory export into a vault as staged drafts; (2) a model-swap continuity report that runs one question set over one frozen vault across model families and reports the answer-quality spread.

**Architecture:**
- **Part 1 — importer.** New import types `chatgpt`/`claude` in `runImport` (`src/import/index.ts`), routed exactly like the existing `langgraph-store` type to a new `src/import/provider-memory.ts` (mirrors `src/import/langgraph-store.ts`). It parses a provider export via a small per-provider adapter into normalized records, then delegates to the backfill apply flow — everything lands `draft`, `confidence: low`, `source: <provider>-memory-export`. The existing day-0 "unscanned for contradictions" hint applies unchanged.
- **Part 2 — continuity.** `daftari eval run` ALREADY accepts `--transport anthropic|openrouter` + `--model` and keys each `EvalRun` by `answerer_model` ([DATA] `src/eval/index.ts`). So the swap is pure orchestration: a `daftari eval swap` command runs the same `--questions` over the same `--vault` across a model/transport panel, scores each with a FIXED grader, and writes a continuity artifact (per-model `score`/`score_std` + spread). No transport or scoring math is added.

**Tech Stack:** TypeScript (ESM/NodeNext), vitest. Reuses `src/eval/` (run/score/generate/storage), `src/eval/llm-openrouter.ts` (openrouter transport), `src/backfill/`. Env: `ANTHROPIC_API_KEY` + `OPENROUTER_API_KEY` for a multi-family panel.

**Spec:** [docs/superpowers/specs/2026-07-30-memory-divorce-kit-design.md](docs/superpowers/specs/2026-07-30-memory-divorce-kit-design.md)

---

## Conventions (every task)
- ESM/NodeNext: local imports use `.js`. No classes; pure functions; `Result<T,E>` (never throw from tool/CLI handlers).
- vitest. Adapter/orchestration logic is unit-tested with fixture exports and a mock `LlmClient`; no live API calls in tests.
- Git hygiene: `git add` ONLY the files each task changes. Never `git add .`.
- Branch is `docs/specs-ledger-voice-and-divorce-kit` (already checked out — do NOT switch/create branches).
- **Discipline invariant:** imported provider memory is unaudited. It enters as `draft`, never `canonical`; the vault never mints a value it wasn't given.

## File structure
- **New** `src/import/provider-memory.ts` — `runProviderMemoryImport(vaultRoot, provider, passthrough)`; per-provider export adapters → normalized `{title, body, created, tags}` records; delegates to the backfill apply flow.
- **Modify** `src/import/index.ts` — `SUPPORTED += "chatgpt", "claude"` (~line 16); dispatch branch (~line 168) routing both to `runProviderMemoryImport`; extend `HELP`.
- **New** `src/eval/swap.ts` — `runSwap(argv)`: panel over `{transport, model}` pairs → per-model `eval run` + `eval score` → continuity artifact.
- **Modify** `src/eval/index.ts` — add a `swap` subcommand to the dispatcher (~line 245-ish caller in `src/cli.ts` already routes `eval`); extend `HELP`.
- **New** `src/eval/continuity.ts` — pure: `computeContinuity(perModel: {model, score, score_std}[]) → {spread, min, max, mean}`.
- **Tests**: new `test/import/provider-memory.test.ts`, `test/eval/continuity.test.ts`, `test/eval/swap.test.ts` (mock clients); `test/import/index.test.ts` (dispatch).
- **Modify** `CHANGELOG.md`.

---

# Part 1 — provider-memory importer

## Task 1: Provider export adapter + import module

**Files:** New `src/import/provider-memory.ts`; Test `test/import/provider-memory.test.ts`

- [ ] **Step 1: Read context**
Read `src/import/langgraph-store.ts` end-to-end — it is the template: a non-obsidian import type that has its own flag surface and derivation path but shares the adoption plumbing (vault check, gitignore scaffolding, git announcements) via `runImport`. Read `src/backfill/index.ts` `runBackfill` (~line 189) and `generatePlan`/`applyPlan` to see how normalized content becomes staged drafts, and confirm the frontmatter defaults path (status, confidence, source). Read one real provider export shape (ChatGPT `conversations.json` / Claude memory export) or, if unavailable, define the minimal record the adapter targets and fixture it.

- [ ] **Step 2: Write failing tests** (`test/import/provider-memory.test.ts`)
  - Adapter: a fixture ChatGPT export → N normalized records with title/body/created; malformed/empty export → loud error, not silent empty.
  - End-to-end (temp vault): `runProviderMemoryImport(vault, "chatgpt", ["--apply"])` writes files that are all `status: draft`, `confidence: low`, `source: chatgpt-memory-export`; NONE are `canonical`.
  - Idempotence: same export applied twice yields the same plan (no dupes).
Run → FAIL (module absent).

- [ ] **Step 3: Implement** `src/import/provider-memory.ts`
  - `parseExport(provider, raw): Result<NormalizedRecord[], Error>` with one adapter per provider behind a `provider → adapter` map (adding a provider = one adapter).
  - `runProviderMemoryImport(vaultRoot, provider, passthrough)`: parse → hand records to the backfill apply flow with provider-memory derivation (draft, low confidence, stamped `source` + export timestamp). No fabricated `derives_from` edges. Mirror `langgraph-store.ts`'s structure and return-code contract.

- [ ] **Step 4: Verify** — `npx vitest run test/import/provider-memory.test.ts` green; `npm run build` clean.

## Task 2: Wire `chatgpt`/`claude` import types into dispatch

**Files:** Modify `src/import/index.ts`; Test `test/import/index.test.ts`

- [ ] **Step 1: Read context**
Read `runImport` (`src/import/index.ts` ~line 73): `SUPPORTED` (~line 16), the shared adoption plumbing, the `langgraph-store` dispatch branch (~line 168), and the day-0 tension-scan hint (~line 178) — provider-memory imports should emit the same hint (unaudited corpus).

- [ ] **Step 2: Write failing tests** (`test/import/index.test.ts`)
  - `daftari import chatgpt <vault> --apply` and `daftari import claude <vault> --apply` route to `runProviderMemoryImport` (spy/mock) and return its code.
  - An unsupported type still errors with the supported-list message (now including the new types).
  - On successful apply, the day-0 tension-scan hint is written to stderr.
Run → FAIL.

- [ ] **Step 3: Implement**
  - `SUPPORTED = ["obsidian", "langgraph-store", "chatgpt", "claude"] as const;`
  - In the dispatch, add `if (type === "chatgpt" || type === "claude") code = await runProviderMemoryImport(resolvedVault, type, passthrough);` alongside the langgraph branch.
  - Extend `HELP`.

- [ ] **Step 4: Verify** — `npx vitest run test/import/` green; `npm run build` clean.

---

# Part 2 — model-swap continuity

## Task 3: Continuity math + swap orchestrator

**Files:** New `src/eval/continuity.ts`, `src/eval/swap.ts`; Tests `test/eval/continuity.test.ts`, `test/eval/swap.test.ts`

- [ ] **Step 1: Read context**
Read `src/eval/index.ts`: the `run`/`score` subcommand handlers, the `--transport` gate (`resolveTransport`, `createAnthropicClient`/`createOpenRouterClient`, ~lines 10-11, 156-179), `--model`/`--grader-model`, and the artifact storage (`writeResults`/`writeScore`/`readResults`, `src/eval/storage.ts`). Confirm `EvalRun.answerer_model` keying and the `aggregateScore` output fields (`score`, `score_std`, `src/eval/score.ts`). The panel REUSES these — do not reimplement running or scoring.

- [ ] **Step 2: Write failing tests**
  - `continuity.test.ts`: `computeContinuity([{model:"a",score:0.9,...},{model:"b",score:0.5,...}])` → `spread = 0.4`, correct min/max/mean; single-model input → spread 0.
  - `swap.test.ts`: with mock `run`/`score` (or injected `LlmClient`s) over a 2-model panel and one fixed question set + vault, `runSwap` produces a continuity artifact listing both models' `score`/`score_std` and the spread; the SAME `--grader-model` is used for every model (assert the grader arg is constant across the panel).
Run → FAIL.

- [ ] **Step 3: Implement**
  - `src/eval/continuity.ts`: pure `computeContinuity`.
  - `src/eval/swap.ts` `runSwap(argv)`: parse `--questions`, `--vault`, `--k`, `--grader-model`, and a panel spec (`--panel transport:model,transport:model,…`). For each panel entry: resolve transport+client (reuse the existing gate), `runAnswerer` over the frozen questions/vault, `gradeAnswer`+`aggregateScore` with the FIXED grader, collect `{model, score, score_std}`. Write a continuity artifact via the eval storage layer. Honor `Result<_, CortexEvalError>` and the eval exit-code contract (2 config, 3 runtime).

- [ ] **Step 4: Verify** — `npx vitest run test/eval/` green; `npm run build` clean.

## Task 4: CLI subcommand + docs

**Files:** Modify `src/eval/index.ts`, `CHANGELOG.md`

- [ ] **Step 1:** Add a `swap` branch to the `daftari eval` dispatcher delegating to `runSwap`; extend `HELP` with usage (`daftari eval swap --questions <id> --vault <path> --panel anthropic:claude-sonnet-4-6,openrouter:openai/gpt-... --grader-model <id>`) and the env requirement (both API keys for a multi-family panel).
- [ ] **Step 2:** CHANGELOG: provider-memory import types (`chatgpt`, `claude`) + `daftari eval swap` continuity report.
- [ ] **Step 3: Verify** — full `npx vitest run` green; `npm run build` clean.

---

## Manual verification (gates the kill condition)
Import a real provider memory export; generate one question set over the imported vault; run `daftari eval swap` across ≥2 model families. Publish the continuity artifact. **Kill condition:** if per-model `score` spreads wide or drops sharply off the strongest family, do NOT ship the stunt as marketing — keep the importer (independently useful), record the negative result, and feed it back into the moat argument. The artifact is the deliverable either way (experiment isn't done until it's written).

## Notes on scope honesty
- Part 2 assumes NO new transport work: `daftari eval run --transport` already routes anthropic/openrouter ([DATA] `src/eval/index.ts`). If a target family isn't reachable through those two transports, it's simply out of the v1 panel — do not add transports in this plan.
- Provider export formats drift; the adapter map isolates that. v1 targets the export shapes actually in hand — fixture them from a real export before implementing the adapter, don't guess the schema.
