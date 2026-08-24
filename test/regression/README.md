# Tier 1 regression suite (PR gate)

Hermetic vitest suites that gate every PR: committed fixtures, no network, no
model loads, no `/tmp` paths. The sample-vault retrieval gate additionally
requires a Git checkout: it uses `git ls-files` to prove its explicit corpus
manifest covers every committed input while excluding ignored local vault
state. Design:
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
  per-query hit@1/hit@5 (`baselines/retrieval.json`) plus aggregate
  recall@5/MRR/nDCG@5 (`baselines/retrieval-metrics.json`). The real-semantic
  sibling runs 25 frozen questions over `test/fixtures/sample-vault`, including
  multi-document answers, through `vault_search` under pure lexical and shipped
  0.8/0.2 MiniLM-fusion weights. The fusion arm replays 35 committed MiniLM
  vectors, so it exercises sqlite-vec and fusion without loading a model or
  touching the network. The gate exact-diffs per-query relevant ranks plus
  aggregate recall@5, recall@10, MRR, and nDCG@10
  (`baselines/sample-vault-retrieval.json`) at zero tolerance. The credentialed
  OpenAI provider matrix remains Tier 2.

Fixtures are pinned copies — they do not track
`integrations/consensus-bench/src/__fixtures__/`, and they are excluded from
biome so they stay byte-frozen. Regenerate the native vault with
`node scripts/gen-regression-vault.mjs` (deterministic).

The sample-vault question set lives at
`fixtures/sample-vault-queries.jsonl`. Each row includes its answer paths and a
review rationale; edit it only with a reviewed baseline delta. Design:
`docs/superpowers/specs/2026-08-23-sample-vault-retrieval-gate-design.md`.
If the corpus or questions change, regenerate the checked-in local-MiniLM
vectors with `npm run regression:update-sample-embeddings`, commit that fixture,
then use the normal clean-tree baseline command.

Tiers 2–3 (nightly vector/hybrid bench, pre-release LLM-judge) are follow-ups
per the design spec; this directory is Tier 1 only.
