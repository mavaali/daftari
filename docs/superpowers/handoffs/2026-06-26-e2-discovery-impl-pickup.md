# Handoff — E2 chain-discovery tooling: ready to implement

**Date:** 2026-06-26
**Branch:** `feat/contract-bench-arms` (NOT pushed; continues the contract-bench arc — CB1 + synthetic falsifier + E1 all live here)
**One-line:** E1 (EDGAR acquisition + `htmlToText`) is **shipped and verified**; E2 (chain-discovery tooling) is **fully designed + planned + reviewer-approved** and ready to implement task-by-task. This is a clean checkpoint — start the next session by executing the E2 plan.

## First action

Execute the E2 plan with **subagent-driven-development** (fresh subagent per task, two-stage review — spec compliance then code quality — between tasks; that's how E1 was built this arc):

- **Plan:** `docs/superpowers/plans/2026-06-26-e2-edgar-discovery.md` (9 tasks, complete code, TDD). Invoke `superpowers:subagent-driven-development` and work the tasks in order.
- **Spec:** `docs/superpowers/specs/2026-06-26-e2-edgar-discovery-design.md`.
- Work from `integrations/contract-bench`. Build `npx tsc`; test `npx vitest run`.

Group the 9 plan tasks at the natural granularity (one file = one implementer unit, as in E1): T1 fixture · T2 `efts-search` · T3 `cik-tally` · T4 `preamble` · T5 `reconstruct` · T6 `score` · T7 `select` · T8 runner+live-run · T9 spot-check+suite gate.

## What E2 builds (the shape)

A deterministic, **zero-LLM** EDGAR chain-discovery pipeline that **reuses E1 wholesale** (`fetchFiling`/`htmlToText`/`buildChainDocs`/`parseCitations`):

```
broad EFTS query → tallyCiks → top-N CIKs
   → per CIK: parsePreamble → reconstructChains (group by (agreementType,baseDate) → order → base) → Seed[]
   → scoreChain (reuse E1) → {unrecoverableRate, unitType, length}
   → rankCandidates → manifest + seeds + pairs.md + unrecoverable-rate distribution → human spot-check
```

Decisions already settled with the user (do NOT relitigate): discovery-tooling-first; per-CIK + preamble-reference linkage (not global/LLM clustering); auto-tally CIKs from a broad query; looser base-id (filed-base else earliest-in-set); `maxUnrecoverable=0.20` default but **tunable + full distribution always reported** (user noted 20% is generous); credit-agreement-focused initial query, mechanism general.

## Where things stand — E1 (DONE, the foundation E2 reuses)

E1 shipped on this branch (10 commits, **83 tests green, tsc clean**). Built `src/{html-to-text,edgar-fetch,chain-docs}.ts` + `pull-edgar.mjs` + `seeds/ngs.json` + committed fixtures `src/__fixtures__/ngs/{amd1,amd2}.htm`. **Both `parseCitations` paths proven on real EDGAR HTML** via oracle tests: defined-term (amd-1 → `{clause:"Commitment", op:"restate", recoverable:true}`) and Section-op (amd-2 → `{clause:"8.1", op:"restate", recoverable:true}`). Live `pull-edgar.mjs seeds/ngs.json` pulls the full NGS TCB A&R chain (base 595k chars + amds 1–4). Memory `project_contract_supersession_benchmark` has the full E1 banner. (E1 spec/plan: `docs/superpowers/{specs,plans}/2026-06-26-e1-edgar-acquisition*.md`.)

## Gotchas the plan already encodes (don't rediscover the hard way)

- **The preamble date trap (Task 4, dominant risk).** Real NGS amd-1 preamble: the amendment's OWN date is `dated effective as of November 14, 2023`; the BASE date is `dated as of February 28, 2023` (in the recitals, later in the doc). `parsePreamble` must match `/dated as of …/` (which skips "dated effective as of") on a ~2500-char head. Agreement type is "Amended and Restated Credit Agreement", not bare "Credit Agreement". The plan's Task 4 has a discover-then-pin step that prints the real head first — follow it, and STOP/report (don't force) if reality differs.
- **`unitType` has ONE authoritative producer:** `reconstruct` sets `"unknown"` placeholder; `score` produces the real Section/defined-term/mixed value; the runner writes the score-derived value into the emitted seed + manifest.
- **`reconstruct` grouping key = `(agreementType-lowercased, baseDate)`.** Keeping `agreementType` in the key prevents over-merging a CIK's same-date loan-package agreements (closings date many docs the same day); the residual fragmentation risk (one agreement named inconsistently → split) is the live-run debugging hint in Task 8.
- **EFTS endpoint (verified live):** `https://efts.sec.gov/LATEST/search-index?q="<phrase>"&forms=<f>&ciks=<10-digit>&from=<n>`. ~100 hits/page, result window caps at 10000. Hit `_id` = `<accession>:<filename>`, `_source.{ciks,root_forms,file_date}`. Paginate by `from += page.length`; throttle (~300ms) — SEC fair-access. `curl` + compliant UA works; `WebFetch` 403s.
- **Gitignore:** `.edgar-cache/` already ignored (E1). Task 8 adds `.discover-out/`. NEVER commit pulled filings or discovery outputs; only the recorded EFTS JSON fixture is committed.
- **Tests never hit the network** — recorded EFTS JSON fixture + committed NGS HTML fixtures + injected fake transports. Live EFTS/curl only in the runner.
- **Benign:** every commit prints `lint-staged could not find any staged files matching configured tasks` — the repo-root lint-staged glob doesn't cover `integrations/**`; commits land fine (verify via `git show --stat`).

## Done-criterion for E2

`node discover-edgar.mjs "Amendment to Credit Agreement" 15 0.2` produces `.discover-out/{manifest.json, distribution.md, seeds/, pairs/}`; the full suite (83 E1 + new E2 unit tests) is green + tsc clean; and a **human spot-check** of one selected chain's `pairs/<chainId>.md` against the cached filings is written to `docs/superpowers/results/2026-06-26-e2-discovery-spotcheck.md` (the "labels are the canary" gate before E3 consumes any chain).

## After E2

E3 = run the arms (Arm A recency vs Arm C daftari `resolveCurrentSource`) over E2's selected chains via E1's `assemble()`, **plus the headline regime metric: the natural frequency of scoped-current-with-stale-mention**. E4 = Arm B (LLM-synth fabrication foil) + CB4 (acquired clause-supersession edges via the cortex loop — the publishable contribution). Parent handoff: `docs/superpowers/handoffs/2026-06-26-contract-bench-edgar-realism-pickup.md`.
