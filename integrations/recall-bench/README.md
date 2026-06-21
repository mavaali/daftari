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

## Known follow-up before the gated benchmark run (Tasks 6–7)

- **Add a real `satisfies MemorySystemAdapter` typecheck.** The adapter shape is
  currently hand-mirrored from the spec (`adapter.ts`), because the Recall Bench
  package is not yet a dependency. When wiring the profile/run, import the upstream
  interface and add `satisfies` so the compiler — not the spec — verifies conformance.
- Profile, smoke run, full EA-180d baseline + results note are gated on the Azure judge
  key + `ANTHROPIC_API_KEY` and the external harness being operational.
