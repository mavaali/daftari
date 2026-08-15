# langchain-daftari: publish under LangChain 1.0 + the real LangMem play

**Date:** 2026-07-30
**Status:** Design — approved in brainstorm, pending spec review
**Scope owner:** Mihir Wagle
**Affects:** `integrations/langchain/` (Python package `langchain-daftari`)

## Problem

`langchain-daftari` v0.1.0 (Alpha) is an unpublished LangChain tool wrapper over
the daftari MCP surface. Mihir wants to (a) stay current with LangChain 1.0 and
(b) "stay up with LangMem," and asked whether to build the roadmap's Phase 2
(`DaftariStore(BaseStore)` write-back).

## Key finding that reframes the work

The current integration is a **tool wrapper** (agent calls `vault_search` /
`vault_write` and gets compiled notes back). LangMem does **not** plug into that
seam — LangMem is a runnable that reads/writes memories through a LangGraph
`BaseStore`. So:

- "Updating" the tool wrapper does **not** move it closer to LangMem. The two
  live on different seams.
- The roadmap's Phase 2 (`DaftariStore(BaseStore)` write-back) is the seam
  LangMem uses, **but it is the wrong build for daftari**:
  - `BaseStore` is a flat KV + vector-search interface
    (`put`/`get`/`search`/`list`). LangMem would `put()` its own opaque memory
    JSON. Daftari becomes a dumb backend — **none of its differentiation fires
    at write time**: no compiled notes, no frontmatter, no provenance, no
    tension detection.
  - Proof from daftari's own `langgraph-store-demo`: tension detection runs as a
    **separate batch audit pass** over the imported store, not at `put()` time.
    Being a `BaseStore` buys the plumbing and none of the payload.
  - LangMem is pre-1.0 (0.0.30, Oct 2025; active into mid-2026). Deep-coupling a
    write adapter to a moving pre-1.0 target is high upkeep for a lossy result.

**Decision: do not build the write-back `BaseStore`.** Two pieces of work
replace it, sequenced.

The roadmap (`README.md:208-210`) also motivated Phase 2 on thread-scoped
`MemorySaver` state. That is a **different seam** — `BaseCheckpointSaver`, not
`BaseStore` (the README conflates the two). Thread-scoped checkpointer state is
explicitly out of scope here and is **not** a reason to revive the `BaseStore`
build. If thread persistence is ever wanted, it gets its own evaluation against
the checkpointer interface, independent of this decision.

### Facts of record (verified this session)

- `[DATA, web, 2026-07]` LangMem latest release 0.0.30 (Oct 2025), still pre-1.0;
  LangChain 1.0 docs still position it as the long-term memory option; LangMem
  operates over a LangGraph `BaseStore` (`create_memory_store_manager(store=...)`).
- `[DATA, code]` The wrapper's only LangChain import is
  `langchain_core.tools.{BaseTool, StructuredTool}` (`tools.py:22`).
- `[DATA, code]` `langchain-mcp-adapters` is a declared dependency but the module
  docstring states it is deliberately **not used** (hand-rolled instead) —
  `tools.py:1-16`.
- `[DATA, code]` Tools are built by passing a raw JSON-schema **dict** as
  `StructuredTool(args_schema=<dict>)` (`tools.py:105-112`, `_normalize_schema`
  `tools.py:115-127`).

## Work item #1 — Publish `langchain-daftari` 0.1.0 under LangChain 1.0 (ships now)

Goal: the existing tool wrapper, verified working on LangChain 1.0, published to
PyPI as 0.1.0.

### Compat verification (ordered by risk)

The failure surface is the **full `args_schema=<dict>` path**, not just
`StructuredTool.__init__`. Construction accepting the dict is necessary but not
sufficient — what matters is the schema that survives round-trip to the model.
Ordered by likelihood:

1. **`tool.args` / `get_input_schema()` serialization** — the MOST likely break.
   `tests/test_tools.py:236-239` asserts `tool.args["path"]["type"] == "string"`,
   which depends on the raw JSON-schema `properties` dict surviving intact
   through langchain-core's args-schema → JSON-schema path. langchain-core has
   reworked the `ArgsSchema` union (dict vs. pydantic vs. `TypeBaseModel`) across
   the 0.3→1.0 line; the shape `.args` returns for a dict-provided schema can
   shift even when construction still works. **This — not construction — is the
   thing most likely to change under 1.0.**
2. **The model-facing tool schema** — what `bind_tools` actually sends the LLM as
   the tool's parameter spec. This is downstream of `.args` and is the real
   "works under LangChain 1.0" contract. The existing suite never exercises it
   (see Issue-driven acceptance test below).
3. **`StructuredTool(args_schema=<raw dict>)` construction** (`tools.py:108`) —
   dict-as-`args_schema` landed ~langchain-core 0.3. Confirm 1.0 still accepts a
   dict. If 1.0 tightened it, fallback is to coerce dict → pydantic model inside
   `_normalize_schema` (localized, one function). **Note:** this fallback IS a
   behavior change to `_normalize_schema` → triggers a 0.2.0 bump (see version
   rule below).
4. **`metadata=` kwarg** (`tools.py:111`) — stable API, low risk; covered by the
   suite.

Verification is NOT "run the 34 tests and ship." The existing suite is
mock-heavy (`_FakeClient`) and the integration tests
(`test_integration.py:105-110`) also only assert `.args` shape — nothing binds a
tool to a real langchain-core 1.0 model. A green suite can coexist with a
malformed model-facing schema. So verification requires the new binding test in
the acceptance criteria, run across the CI matrix.

### Dependency changes (`pyproject.toml`)

- **Drop** `langchain-mcp-adapters>=0.1.0` — unused; removes a needless version
  coupling.
- **Keep** `langchain-core>=0.3.0` floor (maximizes compatibility). No upper pin
  unless a break surfaces during verification.
- **Keep** `mcp>=1.0.0`, `pydantic>=2.0`.
- Add a CI test matrix covering langchain-core **0.3.x** and **1.x** so the
  compatibility claim is enforced, not asserted.
- **Runtime dep scope:** `langchain-core` is the ONLY runtime import
  (`tools.py:22`). The wrapper does not import `langchain` itself, so LangChain
  1.0's `langchain-classic` split (legacy chains/agents moved out of `langchain`)
  does not affect the package. The `demo` extras (`langgraph`,
  `langchain-anthropic`) and the README quick-start (`create_react_agent`,
  `ChatAnthropic`) are a separate concern: either matrix-test the demo extras
  against 1.0-era `langgraph`/`langchain-anthropic`, or scope the 1.0 claim
  explicitly to "core only; demo extras untested." Decide and state which.

### Publish mechanism

- **PyPI Trusted Publishing (OIDC)** via a GitHub Actions workflow — mirrors
  daftari's tokenless npm OIDC release. No API token stored.
- Build with **hatchling** (already configured in `pyproject.toml`).
- **Confirm the `langchain-daftari` name is free on PyPI** before first publish.
- **Register a PyPI "pending" trusted publisher** for `langchain-daftari` before
  the first workflow run. A brand-new project name cannot bootstrap OIDC from the
  workflow alone — you either pre-register a pending publisher or do one manual
  first upload. This is the step that most often blocks a first OIDC publish.
- The publish job must set `permissions: id-token: write` and run under a gated
  deploy `environment:`. Omitting `id-token: write` produces a confusing auth
  failure.
- **Version rule (concrete):** dependency removal alone (dropping
  `langchain-mcp-adapters`) → stays **0.1.0** (or 0.1.1). Any behavior change to
  `_normalize_schema` (the dict→pydantic fallback, if 1.0 forces it) → **0.2.0**.
  Alpha classifier either way.

### Acceptance criteria (#1)

- [ ] `langchain-mcp-adapters` removed from `pyproject.toml` dependencies.
- [ ] Existing suite green against the CI matrix (langchain-core 0.3.x AND 1.x).
- [ ] **New binding test:** a `create_daftari_tools` tool is bound via
      `bind_tools` (real or faithfully faked langchain-core 1.0 model surface)
      and the emitted tool/parameter schema is asserted well-formed — i.e. the
      model-facing contract, not just `tool.args`. This is the actual
      "verified under LangChain 1.0" gate; a green legacy suite is not sufficient.
- [ ] README roadmap updated to reflect the read-side-audit decision (Phase 2 no
      longer advertised as `DaftariStore(BaseStore)`). Ships with the package, so
      it must be correct at publish time.
- [ ] `langchain-daftari` name confirmed available; pending trusted publisher
      registered on PyPI.
- [ ] OIDC publish workflow added (`id-token: write`, gated environment) and
      TestPyPI-validated.
- [ ] Published to PyPI; `pip install langchain-daftari` works in a clean env.

### Out of scope (#1)

LangChain integration-registry listing, async-first user surface, anything
`BaseStore`.

## Work item #2 — The real LangMem play: read-side audit (follow-up sketch)

Not a write-back store. Productize the existing `langgraph-store-demo` into a
shippable, read-only **audit** over whatever store LangMem already writes.

- A CLI / Python entry point (working name `daftari audit-store`) that:
  - Points at any LangGraph store LangMem populates (e.g. Postgres/pgvector),
  - Imports memories **read-only** (read-only role + `READ ONLY` session, as the
    demo already does),
  - Runs tension detection + compiles claim notes with provenance,
  - Emits the tension graph.
- Positioning: **"LangMem consolidates; Daftari audits."**
- Why this shape: it couples to the **store**, not the LangMem SDK, so it
  survives LangMem's pre-1.0 churn — the coupling the write-back adapter would
  have forced. It also plays to daftari's genuine edge (catching contradictions
  LangMem's in-place dedup silently drops), which is a batch audit, not a live
  KV write.
- **Python ceiling:** #2 inherits LangMem's hard `<3.13` constraint
  (`DEMO.md:30-31`: "Python 3.13+ will not resolve LangMem — pin 3.12"). So #2
  must be a **separate distributable / extra**, not folded into
  `langchain-daftari`'s dependency set. #1 is free of this ceiling (no LangMem
  import; `requires-python >=3.10` stands) — keep them decoupled.
- Depth: sketch only in this doc. #2 gets its own spec → plan cycle after #1
  ships.

## Sequencing

1. #1 first — small, unblocks users, keeps the wrapper current.
2. #2 as the headline LangMem follow-up, specced separately.
