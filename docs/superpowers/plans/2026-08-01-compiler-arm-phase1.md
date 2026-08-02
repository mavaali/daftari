# Compiler Arm — Phase 1 (`compile: "write"`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make recall-bench's `ingestDay` optionally run the real wiki-maintainer authoring procedure (arm C's write-time half), so a compiled vault can be built and later evaluated against the raw baseline — without a strawman compiler.

**Architecture:** Add a `compile` axis to the existing adapter. `raw` keeps today's behavior (`mapDay` → write markdown → reindex). `write` runs an **authoring agent loop**: for each ingested day, an LLM driven by the *canonical* wiki-maintainer authoring prompt (snapshotted from `plugins/knowledge/skills/wiki-maintainer/SKILL.md` on `feat/knowledge-plugin`, the procedure Mihir designated as production) calls a write-capable daftari tool surface (`vault_write` / `vault_supersede` / `vault_search` / `vault_read`) to compile the day into notes, superseding only against prior days. Two anti-strawman checks (build-time module sameness, runtime call-argument fidelity) guard that the bench runs the designated procedure, not a bench-local imitation. `write+consolidate` is reserved for the Phase 2 plan.

**Tech Stack:** TypeScript (ESM, dist-relative imports of daftari), vitest, the daftari `LlmClient` (`completeWithTools`, OpenRouter transport), `vaultWrite`/`vaultSupersede` from `dist/tools/`.

**Spec:** `docs/superpowers/specs/2026-07-31-recall-bench-compiler-arm-timestamp-baseline-design.md` (Design decisions 1–2, Phase 1). Rationale lives there; this plan does not duplicate it.

**Canonical authoring source:** `plugins/knowledge/skills/wiki-maintainer/SKILL.md` @ `feat/knowledge-plugin` (claude-home-base). This is the strawman boundary; it is documented in the results note per the spec.

---

## File structure

- **Create** `integrations/recall-bench/src/authoring-prompt.ts` — the canonical authoring system prompt (snapshot of the SKILL.md Ingest procedure + Critical Rules + Page Types + Page Template + supersede/tension rules) as an exported const, with a provenance header (source path + git SHA). Single source of truth for the procedure; both the bench and the anti-strawman fidelity test read it.
- **Create** `integrations/recall-bench/src/wiki-schema.ts` — a compact EA-corpus `WIKI.md`-equivalent schema (page types the authoring agent compiles into: `topics/`, `decisions/`, `entities/`, `tasks/`, `tensions/`), embedded so the ingest agent has a schema without a filesystem `WIKI.md`.
- **Create** `integrations/recall-bench/src/write-tools.ts` — a write-capable tool surface (defs + handler) exposing `vault_write`, `vault_supersede`, plus `vault_search`/`vault_read` for prior-day context; handler dispatches to the programmatic `vaultWrite`/`vaultSupersede` and the existing read surface.
- **Create** `integrations/recall-bench/src/compiler.ts` — `makeCompiler(vaultRoot, cfg, llm)`: the authoring agent loop. Given `(day, content, meta, priorDayPaths)` runs `llm.completeWithTools` with the authoring prompt + write-tools; enforces supersede-against-prior-days-only; returns a record of tool calls (for the runtime anti-strawman diff).
- **Modify** `integrations/recall-bench/src/config.ts` — add `compile: "raw" | "write" | "write+consolidate"` (default `raw`; `write+consolidate` parses but Phase 1 errors "not yet wired — Phase 2").
- **Modify** `integrations/recall-bench/src/adapter.ts` — `ingestDay` branches on `cfg.compile`; `raw` unchanged, `write` calls the compiler. Track `priorDayPaths` across `ingestDay` calls.
- **Tests** alongside each (`*.test.ts`), plus `compiler.integration.test.ts` (RB_INTEGRATION-gated, real OpenRouter LLM).

---

## Task 1: `compile` config axis (TDD)

**Files:** Modify `integrations/recall-bench/src/config.ts`; Test `integrations/recall-bench/src/config.test.ts`

- [ ] **Step 1: Failing tests** — `compile` defaults to `"raw"`; honors `"write"` and `"write+consolidate"`; errors on an invalid value. Mirror the `answererTransport` axis tests exactly (default/honor/invalid). Also update the two full-shape `toEqual` assertions to include `compile: "raw"`.
- [ ] **Step 2: Run** `npx vitest run integrations/recall-bench/src/config.test.ts` — expect FAIL (field missing).
- [ ] **Step 3: Implement** — add `CompileMode` type, `compile` to `AdapterConfig`, `DEFAULT_COMPILE = "raw"`, enum validation (mirror the `timestamps`/`answererTransport` branch), include in `ok(...)`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(recall-bench): compile axis (raw|write|write+consolidate)`

## Task 2: canonical authoring prompt snapshot + fidelity test (TDD)

**Files:** Create `authoring-prompt.ts`, `wiki-schema.ts`; Test `authoring-prompt.test.ts`

- [ ] **Step 1: Failing test** — assert `AUTHORING_SYSTEM_PROMPT` (a) is non-empty, (b) contains the load-bearing procedure markers from the SKILL.md: the Ingest steps, the supersede-against-prior rule, the page-type list, and the tension rule ("never auto-resolved"); and that `PROVENANCE` names the SKILL.md path + a SHA. This is a snapshot-fidelity guard, not a prose match.
- [ ] **Step 2: Run** — expect FAIL (module missing).
- [ ] **Step 3: Implement** — snapshot the authoring procedure from `feat/knowledge-plugin:plugins/knowledge/skills/wiki-maintainer/SKILL.md` into `AUTHORING_SYSTEM_PROMPT` (Ingest + Critical Rules + Page Types + Page Template + Supersede + Tension), adapted to write daftari docs via the tool surface. Add a `PROVENANCE` const (source path + the SKILL.md blob SHA: `git rev-parse feat/knowledge-plugin:plugins/knowledge/skills/wiki-maintainer/SKILL.md`). Put the EA page-type schema in `wiki-schema.ts` and reference it in the prompt.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(recall-bench): snapshot canonical wiki-maintainer authoring prompt + EA schema`

## Task 3: write-capable tool surface (TDD)

**Files:** Create `write-tools.ts`; Test `write-tools.test.ts`. Recon first: read `dist/eval/tool-surface.js` to see whether `buildToolSurface` has a write mode; if read-only, compose write defs alongside it. `vaultWrite` = `src/tools/write.ts:777`, `vaultSupersede` = `:1543` — read both signatures.

- [ ] **Step 1: Failing test** — `buildWriteToolSurface(vaultRoot)` returns `defs` including `vault_write`, `vault_supersede`, `vault_search`, `vault_read`; and its `handler("vault_write", {...})` writes a doc that then appears in a `reindex`+`vault_read`. Use a real tmp vault (hermetic-ish; no LLM).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** — compose the read surface (`buildToolSurface`) with write defs; handler dispatches `vault_write`→`vaultWrite`, `vault_supersede`→`vaultSupersede`, else the read handler. Map tool inputs to the programmatic signatures (Result convention: throw on `err` so the agent loop surfaces failures).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(recall-bench): write-capable tool surface for the authoring loop`

## Task 4: the authoring compiler loop (TDD, stubbed LLM)

**Files:** Create `compiler.ts`; Test `compiler.test.ts`

- [ ] **Step 1: Failing test** — with a stub `LlmClient` whose `completeWithTools` emits a `vault_write` tool call, `makeCompiler(vault,cfg,stub)(day,content,meta,priorPaths)` results in the doc on disk and returns a tool-call record. Second test: a stub that emits `vault_supersede` targeting a **future/same-day** path is rejected (throws / records an error), while superseding a **prior-day** path is allowed. This encodes the stream-ordering contract.
- [ ] **Step 2: Run** — expect FAIL (module missing).
- [ ] **Step 3: Implement** — `makeCompiler` runs `llm.completeWithTools({ model: cfg.answererModel, system: AUTHORING_SYSTEM_PROMPT, user: <day content + schema + prior-day index>, tools: writeSurface.defs, toolHandler: guardedHandler, maxRounds: cfg.agentMaxIterations })`. The guarded handler wraps `vault_supersede` to reject targets not in `priorDayPaths`. Return `{ toolCalls, notesWritten }`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(recall-bench): authoring compiler loop (supersede prior-days-only)`

## Task 5: wire `ingestDay` to the compile axis (TDD, stubbed LLM)

**Files:** Modify `adapter.ts`; Test `adapter.test.ts`

- [ ] **Step 1: Failing test** — `createDaftariAdapter({compile:"write", ...}, {llm: stub})`: after `setup` + `ingestDay(1,...)` + `ingestDay(2,...)`, the stub compiler was invoked per day and `priorDayPaths` grew (day 2 sees day 1's notes). `compile:"raw"` path unchanged (existing tests stay green). `compile:"write+consolidate"` throws "Phase 2".
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** — in `setup`, when `cfg.compile !== "raw"`, build the compiler (`makeCompiler(vaultRoot, cfg, resolveAnswererClient(cfg, deps))`). `ingestDay`: `raw` → today's `mapDay`+write; `write` → `compiler(day, content, meta, priorDayPaths)`; track `priorDayPaths`. Guard `write+consolidate` with a clear "Phase 2" error.
- [ ] **Step 4: Run** — expect PASS (full `integrations/recall-bench/src` suite).
- [ ] **Step 5: Commit** `feat(recall-bench): ingestDay runs the authoring compiler for compile:write`

## Task 6: build-time anti-strawman check (TDD)

**Files:** Test `anti-strawman.test.ts`

- [ ] **Step 1: Failing test** — assert the compiler's authoring prompt is imported from the single `authoring-prompt.ts` module (module identity), and that `PROVENANCE.sha` equals the current `feat/knowledge-plugin` SKILL.md blob SHA (read via `git rev-parse` in the test, skipped if the branch is absent with a loud `console.warn`, never a silent pass). This enforces "bench and production resolve to the same procedure."
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** — the assertion + the git SHA read helper.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `test(recall-bench): build-time anti-strawman (authoring prompt provenance)`

## Task 7: runtime anti-strawman — call-argument capture (TDD)

**Files:** Modify `compiler.ts` (expose captured call args); Test `anti-strawman.test.ts`

- [ ] **Step 1: Failing test** — on a fixed 3-day fixture with a recording stub LLM, the compiler's captured per-day call args (model ID, system prompt, whether prior-day context was supplied, supersede candidates offered) match the expected canonical shape: `system === AUTHORING_SYSTEM_PROMPT`, `model === cfg.answererModel`, prior-day paths present for days ≥2, supersede candidates == priorDayPaths. (This is the runtime half of the spec's two-layer check; the "production session log" reference is the canonical prompt itself, since production = an agent running that exact SKILL procedure.)
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** — have `makeCompiler` record the resolved call args per day; assert on them.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `test(recall-bench): runtime anti-strawman (call-argument fidelity)`

## Task 8: integration smoke — real authoring via OpenRouter (RB_INTEGRATION-gated)

**Files:** Test `compiler.integration.test.ts`

- [ ] **Step 1: Write the gated test** — `RB_INTEGRATION=1` only. Ingest a 3-day fixture (designed so day 3 revises a day-1 fact) with `compile:"write"`, `answererTransport:"openrouter"`, `answererModel: "anthropic/claude-haiku-4.5"`. Assert: ≥1 note written per day with compiled frontmatter + at least one `[[wikilink]]`, and ≥1 supersede recorded against a prior day. Bound cost with a small `agentMaxIterations`.
- [ ] **Step 2: Run** `RB_INTEGRATION=1 npx vitest run integrations/recall-bench/src/compiler.integration.test.ts` — expect PASS (spends a few cents on OpenRouter; check key balance first).
- [ ] **Step 3: Commit** `test(recall-bench): integration smoke — real authoring compiles a 3-day fixture`

---

## Out of scope (follow-on plans)
- **Phase 2** (`write+consolidate`: `consolidate --mode both` in `finalizeIngestion`, `shadow_mode:false` tmpdir guard, `--max-llm-calls` cap) — separate plan.
- **Phase 3** (A/B/C/D full run, cluster bootstrap, style-blind judge, kill-condition verdict) — separate plan; depends on Phase 0's style-prior + power-analysis pieces still outstanding from the spec's Phase 0.

## Plan review — adjudication (v2, amends the tasks above)

An independent plan review raised 9 issues; resolutions (each amends the referenced task):

1. **[BLOCKER] Runtime anti-strawman was a tautology (no production trace).** Root cause is deeper than the plan admitted: the wiki-maintainer SKILL is **human-interactive** (discuss/approve/usage-log steps), so there is no autonomous "production session" to diff against, and running it verbatim in the bench is impossible. **Resolution:** the eval's canonical procedure is explicitly *the autonomous adaptation* of the SKILL, and **that adaptation is the documented strawman boundary** (named in the results note, per spec "canonical-implementation selection"). Task 7 becomes: (a) run the authoring loop once over the fixed 3-day fixture to produce a **reference call-arg trace**, freeze it as a checked-in golden file; (b) the runtime check diffs future bench runs against that golden (drift detection). This is honest drift-protection, not a claim of parity with a human session — the plan must say so. **This is the design point flagged to Mihir** (it defines what the eval tests).
2. **[BLOCKER] `git rev-parse feat/knowledge-plugin:...` targets the wrong repo.** The SKILL.md is in **claude-home-base**, not daftari. **Resolution (Task 2/6):** `PROVENANCE` records `{repo:"claude-home-base", path, sha}`; the SHA is read from `/Users/mihirwagle/projects/claude-home-base` via an `RB_SKILL_REPO` env override (default that path). CI-absent → loud `console.warn` skip, never silent pass.
3. **[MAJOR] Snapshot is an undisclosed adaptation → strawman risk.** Correct. **Resolution (Task 2):** the `authoring-prompt.ts` header enumerates exactly which SKILL steps are adapted out (user-discussion, approval gate, Python usage-log) and why (autonomous bench). The fidelity test asserts BOTH the kept decision procedure (page types, supersede-prior rule, link rule, tension "never auto-resolved") IS present AND the human-only steps are NOT — so a silent reintroduction fails the test.
4. **[MAJOR] `vaultWrite` needs an initialized index.** **Resolution (Task 3/4/5):** call `reindexVault(tmpVaultRoot)` in test setup (and in `setup()` before the first `write` ingest) to init the index, mirroring `finalizeIngestion`.
5. **[MAJOR] `wiki-schema.ts` is a bench-local invented surface.** **Resolution:** adopt reviewer option (a) — write a real `WIKI.md` into the tmp vault at `setup()` and have the authoring agent read it via `vault_read`, exactly as production does. `wiki-schema.ts` becomes the *content* of that WIKI.md (the EA schema), still named in the results note as a chosen surface.
6. **[MAJOR] `priorDayPaths` accumulation unspecified.** **Resolution (Task 4/5):** compiler returns `{ toolCalls, notesWritten: string[] }` where `notesWritten` = paths from successful `vault_write` calls this day; `adapter.ingestDay` does `priorDayPaths = priorDayPaths.concat(result.notesWritten)`. The supersede guard checks targets ∈ `priorDayPaths`.
7. **[MAJOR] Task 8 no numeric cost ceiling.** **Resolution:** add `expect(totalToolCalls).toBeLessThanOrEqual(N)` (N = 3 days × agentMaxIterations × maxToolsPerRound), pin `agentMaxIterations` small, document expected max spend in the test comment, and check key balance before running.
8. **[MINOR] `buildToolSurface` is read-only — confirmed.** Drop the hedge in Task 3; state it as fact and compose write defs alongside it.
9. **[MINOR] `resolveAnswererClient` conflates roles.** Add an `authoringModel` config field (defaults to `answererModel`) and a `resolveAuthoringClient` alias, so authoring can diverge from answering later without a rewire.

## Notes for the implementer
- Work in worktree `.worktrees/timestamp-baseline` on branch `feat/recall-bench-compiler-arm` (node_modules + dist symlinked from primary; adapter dist built; `.env` has `OPENROUTER_API_KEY`).
- Rebuild the adapter after TS changes: `npx tsc -p integrations/recall-bench/tsconfig.json`.
- Keep the existing `compile:"raw"` behavior byte-identical — every current test must stay green.
