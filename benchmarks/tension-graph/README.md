# Tension-graph benchmark augmentation

Feud-corpus augmentation layered on top of data-olympus's governance benchmark.
Design: `notes/tension-graph-benchmark-spec.md`.

**These files run *inside* a vendored data-olympus checkout**, not standalone —
they import `benchmarks.corpus_model` / `benchmarks.governance_corpus` from that
package. This directory is the canonical source of truth; copy the files into the
clone's `benchmarks/` to run them.

## Pinned upstream

- Repo: `github.com/knaisoma/data-olympus` (Apache-2.0)
- SHA: `ccaffdb41506fd29da2f80fc4f7667db541a134a` (v0.2.0)
- Reproducibility gate (2026-07-03): `uv run python -m benchmarks.generate_artifacts`
  regenerates `benchmarks/results/report.md` and `results.json` **bit-for-bit
  identical** to the committed artifacts. The head-to-head baseline is reproducible.

## Files

- `feud_corpus.py` — generates co-active contradicting doc pairs (the feud
  augmentation). Two `status: active` docs per topic, opposing claims, shared
  retrieval triggers, **no** `supersedes`/`superseded_by` link, no recency
  ordering. Recency is not a valid resolution function on this corpus — the exact
  property that breaks data-olympus's total-order supersession model.
- `feud_queries.py` — the fifth query stratum (`feud`). Gold = both doc ids
  (surfacing the contradiction requires retrieving both).
- `test_feud_disjoint.py` — honesty guardrails as executable asserts (topic-set
  disjointness from governance + distractor topics; per-topic position-vocab
  disjointness so the query cannot lexically favor one side).

## What is NOT here yet (blocked on §9 decisions)

- Agent adapter (model decided: neutral third-party via OpenRouter; answer
  contract still open).
- daftari-side corpus loader + `vault_tension_log` prep step.
- Metrics module (`feud_*`, `recovery_rate`) and report writer.

## Run (inside the clone)

```bash
cp benchmarks/tension-graph/*.py <clone>/benchmarks/
cd <clone>
uv run python -m benchmarks.feud_corpus   # writes feud docs, prints manifest summary
uv run pytest benchmarks/test_feud_disjoint.py -q
```
