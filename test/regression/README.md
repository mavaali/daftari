# Tier 1 regression suite (PR gate)

Hermetic vitest suites that gate every PR: committed fixtures, no network, no
model loads, no `/tmp` paths. Design:
`docs/superpowers/specs/2026-07-07-regression-suite-design.md`.

## Two kinds of red

**Invariant failure** — a property assertion broke (`never stale`,
`dead-end abstention`, `lexical purity`, `document-arm validity`). This is
never expected. Do not update baselines; fix the regression.

**Golden failure** — behavior differs from `baselines/*.json`. If your PR
intended the change: commit your code, then
`npm run regression:update-baseline` (requires a clean tree) and commit the
baseline delta in the same PR — the reviewer sees exactly which
instances/queries flipped. If you didn't intend it, it's a regression.

## Suites

- `staleness/` — CO2 stale-trap corpus (14 pinned Wikipedia revert diffs +
  consensus box). Invariants: Arm C never answers with the stale passage;
  every dead-end abstains. Goldens: per-instance classification
  (`baselines/staleness.json`).
- `retrieval/` — 100-doc native-shape vault, 300 field-isolated token
  queries, lexical BM25 under document and chunk granularity. Goldens:
  per-query hit@1/hit@5 (`baselines/retrieval.json`).

Fixtures are pinned copies — they do not track
`integrations/consensus-bench/src/__fixtures__/`, and they are excluded from
biome so they stay byte-frozen. Regenerate the native vault with
`node scripts/gen-regression-vault.mjs` (deterministic).

Tiers 2–3 (nightly vector/hybrid bench, pre-release LLM-judge) are follow-ups
per the design spec; this directory is Tier 1 only.
