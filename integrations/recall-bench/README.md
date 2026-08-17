# @daftari/recall-bench-adapter (SP1)

Makes daftari implement [Recall Bench](https://github.com/Stevenic/recall)'s
`MemorySystemAdapter`, running daftari **in-process** (no MCP server): ingest writes
daily markdown to a temp vault, `finalizeIngestion` calls `reindexVault`, and `query`
runs an agent loop over `vault_search`/`vault_read` with a native Claude answerer and
native MiniLM embeddings.

See `docs/superpowers/specs/2026-06-20-daftari-recall-bench-adapter-design.md` and
`docs/superpowers/plans/2026-06-20-recall-bench-adapter-sp1.md`.

## Build order (important)

This package imports daftari's compiled output from `../../dist/**`, so **daftari must
be built first**:

```bash
npm run build                                   # from repo root — produces ../../dist
npx tsc -p integrations/recall-bench/tsconfig.json   # builds this package → dist/index.js
```

A cold checkout that skips the root build will fail to resolve `../../../dist/...`
imports. (daftari is not published as a typed library, hence the dist-relative imports.)

## Tests

```bash
npx vitest run integrations/recall-bench/src                 # hermetic (no model/network)
RB_INTEGRATION=1 npx vitest run integrations/recall-bench/src # + integration (loads MiniLM)
```

`corpus-map`/`config`/`extractRetrieval`/`wrapHandlerWithLimit`/`assertCleanReindex`/
`isUnderTmpdir` are hermetic. The `RB_INTEGRATION`-gated tests exercise real
`reindexVault` + retrieval; on a red, re-check the known MiniLM load flake before
treating it as a regression.

## Frozen baseline (MAV-160)

The multi-hop retrieval epic (MAV-155) scores every child against one pinned
surface instead of per-child snapshots:

- `baseline/manifest.json` — the freeze: corpus repo + commit + SHA-256 over the
  180 day-files and the QA label file, question filter, vault parameters, budget
  grid. `baseline-runner.mjs` refuses a corpus whose hashes drift.
- `baseline-runner.mjs` — builds the vault, sweeps rank-extension and coverage
  arms over the budget grid, and records **distractor load next to recall**
  (added-relevant / added-distractor / precision per arm per budget).
  `RB_CORPUS=<recall clone> node baseline-runner.mjs` (`--smoke` for 25 questions).
- `gen-edgehop-vault.mjs` — deterministic edge-bearing labeled corpus: the only
  surface with BOTH a labeled multi-hop relevant set and an edge graph (written
  through the real `observeEdge`/`addTension` stores, trigger-bearing split,
  deliberate lineage-noise edges). Synthetic — validates harness mechanics, not
  edge-alignment in the wild.
- `edge-ceiling.mjs` — MAV-154's $0 reachability-ceiling arm: can one hop over
  {all | trigger-bearing | tensions} edges even reach what the seeds missed,
  vs rank-extension at the same add budget.
- `gen-supersession-vault.mjs` + `suppression-bench.mjs` — MAV-161's
  deterministic bench: chains where stale versions lexically outrank their
  current heads (the shape RB cannot exercise — it has no `superseded_by`),
  measuring head-in-context, head-above-stale, and the span-recall guard with
  the `search.suppress_superseded` pass off vs on. The hallucination arm
  consumes these candidate sets, gated on `ANTHROPIC_API_KEY`.
- `knn-sweep.mjs` — MAV-159's recall-vs-K curve over the same frozen corpus:
  sweeps `search.vec_knn_k` (the vector-arm chunk fan-out, historically fixed
  at 64) across {16..512} at matched budgets. Refuses to run lexical-only —
  K only affects the vector arm, so it needs a machine that can load the
  embedding model.

Results note: `docs/superpowers/results/2026-08-17-mav160-frozen-baseline.md`.

## Known follow-up before the gated benchmark run (Tasks 6–7)

- **Add a real `satisfies MemorySystemAdapter` typecheck.** The adapter shape is
  currently hand-mirrored from the spec (`adapter.ts`), because the Recall Bench
  package is not yet a dependency. When wiring the profile/run, import the upstream
  interface and add `satisfies` so the compiler — not the spec — verifies conformance.
- Profile, smoke run, full EA-180d baseline + results note are gated on the Azure judge
  key + `ANTHROPIC_API_KEY` and the external harness being operational.
