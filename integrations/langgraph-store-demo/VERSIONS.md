# Pinned versions — LangGraph store demo

Recorded after the first clean `uv pip install` on 2026-07-13. Reproduce with
Python 3.12 (`uv venv --python 3.12`). Python 3.13/3.14 are **not** supported by
this stack today — the system Python 3.14 could not resolve LangMem, which is
why the demo pins 3.12.

| Package                          | Version | Notes |
|----------------------------------|---------|-------|
| python                           | 3.12.10 | uv-managed venv |
| langmem                          | 0.0.30  | **pre-1.0** — the only unstable pin; API may drift from docs |
| langgraph                        | 1.2.9   | post-1.0, stable |
| langgraph-checkpoint             | 4.1.1   | post-1.0 |
| langgraph-checkpoint-postgres    | 3.1.0   | post-1.0 — provides `PostgresStore`, the BaseStore we read |
| langchain-core                   | 1.4.9   | post-1.0 |
| langchain-openai                 | 1.3.5   | LLM + embeddings for LangMem's manager |
| openai                           | 2.45.0  | |
| psycopg (+ psycopg-binary)       | 3.3.4   | direct Postgres read path |
| pydantic                         | 2.13.4  | |

## Maturity note (ammo for the writeup)

The churn risk is **scoped to LangMem**, not the LangGraph stack. `langgraph`
and `langgraph-checkpoint-postgres` are both past 1.0 and stable; only
`langmem==0.0.30` is pre-1.0. When Phase 1 hits an API that does not match the
docs, record the exact breakage here — that is the honest maturity argument, and
overclaiming "the whole stack is unstable" is false.

## Store schema the adapter reads (from langgraph/store/postgres/base.py)

`PostgresStore.setup()` creates:

- **`store`** — `prefix text` (namespace), `key text` (memory id), `value jsonb`
  (memory payload), `created_at`, `updated_at`, `expires_at`, `ttl_minutes`.
  Primary key `(prefix, key)`.
- **`store_vectors`** — `prefix`, `key`, `field_name`, `embedding vector(dims)`,
  timestamps. FK to `store(prefix, key)`. Requires the `vector` extension.

The Phase 2 adapter reads `store` directly over psycopg/SQL — no LangGraph
runtime, no Python bridge. Reading the plain Postgres schema *is* the proof of
store-agnosticism.

**Prefix encoding (verified in Phase 0 smoke test):** the namespace tuple is
stored dot-joined in `prefix`. `('memories', 'u1')` → `prefix = 'memories.u1'`.
So the Phase 2 `--namespace <prefix>` filter matches on
`prefix = '<ns>' OR prefix LIKE '<ns>.%'`. LangMem namespaces by user_id under a
top-level label (e.g. `('memories', <user_id>)`), so a per-session import filters
on `memories.<session>`.

## DSNs

- Fixture writer (superuser): `postgresql://postgres:postgres@localhost:5433/memories`
- Daftari adapter (read-only):  `postgresql://daftari_ro:daftari_ro@localhost:5433/memories`
