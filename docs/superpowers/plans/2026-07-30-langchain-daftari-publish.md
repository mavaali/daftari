# langchain-daftari Publish (LangChain 1.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the existing `langchain-daftari` tool-wrapper to PyPI, verified working under LangChain 1.0.

**Architecture:** The wrapper's only LangChain coupling is `langchain_core.tools.{BaseTool, StructuredTool}`, built by passing a raw JSON-schema dict as `args_schema`. The whole risk is whether that dict survives round-trip to the model-facing schema under langchain-core 1.0. We make that contract an explicit test (`convert_to_openai_tool`), run it across a 0.3.x/1.x CI matrix, add a dict→pydantic fallback only if the matrix proves it's needed, drop the unused `langchain-mcp-adapters` dep, correct the README roadmap, then publish via the already-present OIDC workflow.

**Tech Stack:** Python ≥3.10, hatchling, pytest, langchain-core (0.3.x + 1.x), uv, GitHub Actions + PyPI Trusted Publishing.

**Spec:** `docs/superpowers/specs/2026-07-30-langchain-daftari-publish-design.md`

**Working directory for all paths below:** `integrations/langchain/`

**Empirical arbiter:** per the brainstorm decision, the CI matrix + the model-facing schema test ARE the reviewer for the compat question. Do not skip the 1.x run.

---

## File map

- `integrations/langchain/tests/test_tools.py` — add the model-facing schema test (Task 1).
- `integrations/langchain/src/langchain_daftari/tools.py` — `_normalize_schema` fallback, ONLY if Task 2 proves it's needed (Task 3).
- `integrations/langchain/pyproject.toml` — drop `langchain-mcp-adapters` (Task 4); version bump per rule.
- `integrations/langchain/src/langchain_daftari/__init__.py` — `__version__` bump if Task 3 fires.
- `.github/workflows/langchain-daftari-tests.yml` — NEW test-matrix CI (Task 5).
- `integrations/langchain/README.md` — roadmap correction (Task 6).
- `.github/workflows/workflow.yml` — EXISTING publish workflow; add `environment:` gate (Task 7).

---

## Version rule (from spec)

- Dropping `langchain-mcp-adapters` alone → stays **0.1.0** — UNLESS a 0.1.0 was
  ever uploaded to PyPI (Task 7 Step 1 checks); then use **0.1.1**. PyPI rejects
  re-uploading an existing version, and that failure lands at the very end with
  no rollback, so decide the number before tagging.
- If Task 3 fires (any behavior change to `_normalize_schema`) → **0.2.0**.
  Task 3 is the **sole owner** of the version number and runs its bump AFTER
  Task 4's dependency edit (see Task 3 Step 4).

## Local test environments (pins are load-bearing — do NOT use `uv run` for pinned runs)

`uv run` re-resolves the environment from `pyproject.toml` on every call, which
(a) ignores any `uv pip install` pin you added and (b) resolves the
`langchain-core>=0.3.0` floor to the LATEST release (1.x), not 0.3.x. So a bare
`uv run pytest` tests whatever it wants, not the cell you meant. Every pinned run
below builds an explicit venv and invokes ITS python directly.

Create both cells once, up front, and reuse them across Tasks 1/3/4:

```bash
# 0.3.x cell
uv venv --python 3.12 /tmp/lcd-03 && \
uv pip install --python /tmp/lcd-03/bin/python -e ".[dev]" "langchain-core>=0.3,<0.4"
# 1.x cell (also used as Task 2's arbiter)
uv venv --python 3.12 /tmp/lcd-1x && \
uv pip install --python /tmp/lcd-1x/bin/python -e ".[dev]" "langchain-core>=1,<2"
```

Since installs are editable (`-e`), working-tree edits are picked up without
reinstalling — but re-run the matching `uv pip install` if you change
`pyproject.toml` deps (Task 4).

---

### Task 1: Make the model-facing tool schema an explicit contract

The existing suite only checks `tool.args`. The version-sensitive path is what `bind_tools` sends the model. `langchain_core.utils.function_calling.convert_to_openai_tool` is exactly that conversion, offline — no API key, no fake chat model. This test is the 1.0 gate.

**Files:**
- Test: `tests/test_tools.py` (append)

- [ ] **Step 1: Write the failing test**

```python
def test_tool_converts_to_wellformed_model_facing_schema():
    """The model-facing function schema (what bind_tools emits) must preserve
    the raw MCP inputSchema. This is the langchain-core version-sensitive path."""
    from langchain_core.utils.function_calling import convert_to_openai_tool

    schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "vault-relative file path"},
            "limit": {"type": "integer", "default": 10},
        },
        "required": ["path"],
    }
    client = _FakeClient(
        [_FakeTool("vault_search", "search the vault", input_schema=schema)]
    )
    [tool] = create_daftari_tools(client)

    oai = convert_to_openai_tool(tool)

    assert oai["type"] == "function"
    fn = oai["function"]
    assert fn["name"] == "vault_search"
    params = fn["parameters"]
    assert params["properties"]["path"]["type"] == "string"
    assert params["properties"]["limit"]["type"] == "integer"
    assert "path" in params["required"]
```

- [ ] **Step 2: Run it on the 0.3.x cell to establish the contract passes today**

Run: `/tmp/lcd-03/bin/python -m pytest tests/test_tools.py::test_tool_converts_to_wellformed_model_facing_schema -v`
Expected: PASS. (If it fails on 0.3.x, stop — the wrapper is already broken and the spec's premise is wrong; surface to human.)

- [ ] **Step 3: Commit**

```bash
git add tests/test_tools.py
git commit -m "test(langchain-daftari): assert model-facing tool schema, the langchain-core 1.0 gate"
```

---

### Task 2: Run the full suite under langchain-core 1.x — the empirical arbiter

No code change. This observes whether 1.0 breaks the dict-schema path. Its result decides whether Task 3 runs.

**Files:** none (investigation)

- [ ] **Step 1: Ensure the 1.x cell exists** (created in "Local test environments" above). If not, create it now. If `langchain-core>=1,<2` does not resolve, record the actual latest 1.x and pin that.

- [ ] **Step 2a: Sanity-check collection so a plugin problem isn't misread as a schema break**

Run: `/tmp/lcd-1x/bin/python -m pytest --collect-only -q`
Expected: all tests collect (confirms `pytest-asyncio` landed; the async tests need `asyncio_mode=auto`). If collection errors on the async plugin, fix the install BEFORE Step 2b — a missing plugin would produce async-test errors that look like a langchain-core 1.0 failure and falsely trigger Task 3.

- [ ] **Step 2b: Run the full mock suite (skip integration; no npx needed) under 1.x**

Run: `/tmp/lcd-1x/bin/python -m pytest -m "not integration" -v`
Expected: one of two outcomes — record which:
- **All green** (incl. Task 1's test + `test_args_schema_carries_over_from_mcp_inputschema`) → 1.0 is compatible. **Skip Task 3.** Version stays 0.1.0.
- **`test_args_schema_...` or Task 1's test FAILS** → dict-schema serialization changed under 1.0. **Do Task 3.**

- [ ] **Step 3: Record the observed langchain-core 1.x version and outcome in the plan PR description / commit trailer.** (`/tmp/lcd-1x/bin/python -c "import langchain_core; print(langchain_core.__version__)"`)

---

### Task 3 (CONDITIONAL — only if Task 2 failed): dict→pydantic coercion in `_normalize_schema`

Only implement if Task 2 showed a break. If Task 2 was all-green, delete this task's checkboxes and move on.

**Files:**
- Modify: `src/langchain_daftari/tools.py` (`_normalize_schema`, lines 115-127; and `_build_tool` where `args_schema=` is passed, line 108)
- Modify: `src/langchain_daftari/__init__.py` (`__version__` → `0.2.0`)
- Test: `tests/test_tools.py` (Task 1's test + the existing `test_args_schema_...` are the regression gate)

- [ ] **Step 1: Confirm the two failing tests reproduce under 1.x** (from Task 2). These are your red bar.

- [ ] **Step 2: Implement coercion.** Convert the JSON-schema dict into a pydantic model via `langchain_core`'s supported path so both `tool.args` and `convert_to_openai_tool` round-trip. Prefer the minimal change: build a pydantic model from the JSON schema (e.g. with `pydantic`'s `create_model` over `properties`, honoring `required`), and pass that as `args_schema`. Keep the raw-dict path for 0.3.x if the two diverge — branch on whether the installed langchain-core accepts a dict. Follow @superpowers:test-driven-development: minimal code to green, no more.

- [ ] **Step 3: Run BOTH cells green** (reinstall first if you edited deps in Task 4)

Run: `/tmp/lcd-03/bin/python -m pytest -m "not integration" -v` (0.3.x) AND `/tmp/lcd-1x/bin/python -m pytest -m "not integration" -v` (1.x)
Expected: PASS on both. If the fix greens 1.x but reds 0.3.x, the branch is wrong — the code must serve both matrix cells.

- [ ] **Step 4: Bump version to 0.2.0** in `__init__.py` and `pyproject.toml`. This SUPERSEDES Task 4's 0.1.0 — if Task 4 already ran, confirm `pyproject.toml` shows `0.2.0`, not a stale `0.1.0`. Task 3 owns the final number.

- [ ] **Step 5: Commit**

```bash
git add src/langchain_daftari/tools.py src/langchain_daftari/__init__.py pyproject.toml
git commit -m "fix(langchain-daftari): coerce dict inputSchema for langchain-core 1.0; bump 0.2.0"
```

---

### Task 4: Drop the unused `langchain-mcp-adapters` dependency

The module docstring (`tools.py:1-16`) states it is deliberately not used. It only couples versions.

**Files:**
- Modify: `pyproject.toml` (dependencies, lines 26-31)

- [ ] **Step 1: Remove the line** `"langchain-mcp-adapters>=0.1.0",` from `[project].dependencies`.

- [ ] **Step 2: Verify nothing imports it**

Run: `grep -rn "langchain_mcp_adapters\|langchain-mcp-adapters" src/ tests/`
Expected: no hits in `src/` or `tests/` (docstring mention in prose is fine).

- [ ] **Step 3: Re-install both cells (deps changed) and run the mock suite in each**

Run:
```bash
uv pip install --python /tmp/lcd-03/bin/python -e ".[dev]" "langchain-core>=0.3,<0.4" && \
uv pip install --python /tmp/lcd-1x/bin/python -e ".[dev]" "langchain-core>=1,<2" && \
/tmp/lcd-03/bin/python -m pytest -m "not integration" -q && \
/tmp/lcd-1x/bin/python -m pytest -m "not integration" -q
```
Expected: PASS in both cells — confirms the removed dep wasn't load-bearing.

- [ ] **Step 4: Commit**

```bash
git add pyproject.toml
git commit -m "chore(langchain-daftari): drop unused langchain-mcp-adapters dependency"
```

---

### Task 5: Add the langchain-core 0.3.x / 1.x test-matrix CI

Enforce the compatibility claim instead of asserting it. No integration tests in CI (they need `npx daftari`); mock suite only.

**Files:**
- Create: `.github/workflows/langchain-daftari-tests.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: langchain-daftari tests

on:
  push:
    paths:
      - 'integrations/langchain/**'
      - '.github/workflows/langchain-daftari-tests.yml'
  pull_request:
    paths:
      - 'integrations/langchain/**'

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        langchain-core: ['>=0.3,<0.4', '>=1,<2']
    defaults:
      run:
        working-directory: integrations/langchain
    steps:
      - uses: actions/checkout@v7
      - uses: astral-sh/setup-uv@v7
      - name: Install with pinned langchain-core
        run: |
          uv venv --python 3.12
          uv pip install -e ".[dev]" "langchain-core${{ matrix.langchain-core }}"
      - name: Run mock suite
        # Invoke the venv python directly. Do NOT use `uv run` here — it
        # re-resolves from pyproject.toml and silently drops the matrix pin
        # installed above, collapsing both cells to the same langchain-core.
        run: .venv/bin/python -m pytest -m "not integration" -v
```

Sanity-check the matrix actually differs: after the first green run, open both
cells' logs and confirm the langchain-core version printed by pip differs
(0.3.x vs 1.x). If they match, the pin didn't take and the matrix is proving
nothing — this is the failure mode the direct-python invocation prevents.

- [ ] **Step 2: Validate YAML locally**

Run: `uv run python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/langchain-daftari-tests.yml'))"` (from repo root; adjust path)
Expected: no error.

- [ ] **Step 3: Commit and push; confirm both matrix cells go green in Actions**

```bash
git add .github/workflows/langchain-daftari-tests.yml
git commit -m "ci(langchain-daftari): test matrix across langchain-core 0.3.x and 1.x"
```
Expected: `gh run list --workflow "langchain-daftari tests"` shows both cells passing. Follow @superpowers:verification-before-completion — do not proceed until the run is actually green.

---

### Task 6: Correct the README roadmap (ships with the package)

`README.md:202-213` still advertises Phase 2 as `DaftariStore(BaseStore)`. The brainstorm decided NOT to build that. A published package must not promise the abandoned direction.

**Files:**
- Modify: `README.md` (Status & roadmap section, ~lines 202-213)

- [ ] **Step 1: Rewrite the roadmap** to state: Phase 1 (this package) is the tool wrapper; the LangMem direction is a read-side audit (productizing `langgraph-store-demo`), NOT a write-back `BaseStore` — with a one-line reason (BaseStore's `put()` seam can't carry daftari's compiled-note/provenance/tension value). Keep it to a short paragraph; do not paste the spec.

- [ ] **Step 2: Confirm no other doc still promises `DaftariStore(BaseStore)`**

Run: `grep -rn "DaftariStore\|BaseStore" README.md`
Expected: only the corrected, accurate mentions remain.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(langchain-daftari): roadmap reflects read-side LangMem audit, not BaseStore write-back"
```

---

### Task 7: Harden the existing publish workflow + register the PyPI trusted publisher

The publish workflow already exists (`.github/workflows/workflow.yml`: tag `langchain-daftari/v*`, `id-token: write`, `pypa/gh-action-pypi-publish`). Two gaps from the spec: no gated `environment:`, and a brand-new PyPI name needs a pending trusted publisher registered before the first run.

**Files:**
- Modify: `.github/workflows/workflow.yml`

- [ ] **Step 1: Confirm the PyPI name is free AND that 0.1.0 was never uploaded**

Run: `curl -s -o /dev/null -w "%{http_code}" https://pypi.org/pypi/langchain-daftari/json`
Expected: `404` (name available → publish 0.1.0). If `200`, the name exists: run `curl -s https://pypi.org/pypi/langchain-daftari/json | jq '.releases | keys'` — if `0.1.0` is present, bump to **0.1.1** before tagging (PyPI rejects re-uploads). If the project is owned by someone else entirely, stop and surface to human.

- [ ] **Step 2: [HUMAN, Mihir] Register pending trusted publishers on BOTH indexes.** PyPI trusted-publisher registration keys on the workflow **filename** (`workflow.yml`), not its display name.
  - **PyPI:** project `langchain-daftari`, repo `mavaali/daftari`, workflow `workflow.yml`, environment `pypi`.
  - **TestPyPI (for the Step 5 dry run):** same project/repo/workflow, environment `pypi` (the dry run temporarily overrides only the `repository-url`, not the environment). The workflow alone cannot bootstrap a name that doesn't exist yet — do this in each index's UI before Task 8.

- [ ] **Step 3: Add the gated environment to the publish job**

```yaml
  build-and-publish:
    runs-on: ubuntu-latest
    environment: pypi
    permissions:
      id-token: write
      contents: read
```

- [ ] **Step 4: [HUMAN, Mihir] Create the `pypi` GitHub Actions environment** (Settings → Environments) with required-reviewer protection so a publish can't fire unreviewed.

- [ ] **Step 5: TestPyPI dry run.** Temporarily point `pypa/gh-action-pypi-publish` at TestPyPI (`with: repository-url: https://test.pypi.org/legacy/`) on a scratch tag, confirm upload succeeds, then revert to production PyPI. Do NOT leave the TestPyPI URL in the committed workflow.

- [ ] **Step 6: Commit the environment hardening** (production-PyPI version)

```bash
git add .github/workflows/workflow.yml
git commit -m "ci(langchain-daftari): gate PyPI publish behind reviewed environment"
```

---

### Task 8: Publish and verify

**Files:** none (release action)

- [ ] **Step 1: Final pre-flight** — the EXACT commit you will tag has a green matrix run (not merely "main is green"), version in `pyproject.toml` and `__init__.py` agree and match the tag, README roadmap corrected.

Run:
```bash
grep -n version pyproject.toml && grep -n __version__ src/langchain_daftari/__init__.py
gh run list --workflow "langchain-daftari tests" --commit "$(git rev-parse HEAD)"
```
Expected: identical version (0.1.0 / 0.1.1, or 0.2.0 if Task 3 fired) AND both matrix cells green for the current SHA. The publish workflow triggers on the TAG and does NOT re-run tests, so an untested commit tagged directly would publish unverified — verify the SHA specifically.

- [ ] **Step 2: [HUMAN-CONFIRM, Mihir] Tag and push to trigger the publish** (irreversible public action — confirm before running)

```bash
git tag langchain-daftari/v0.1.0   # or v0.1.1 / v0.2.0 per the version rule
git push origin langchain-daftari/v0.1.0
```
Expected: the "Publish langchain-daftari" workflow runs, reviewer approves the `pypi` environment, upload succeeds.

- [ ] **Step 3: Verify a clean-env install**

```bash
uv venv --python 3.12 /tmp/lcd-verify && \
uv pip install --python /tmp/lcd-verify/bin/python langchain-daftari && \
/tmp/lcd-verify/bin/python -c "from langchain_daftari import create_daftari_tools, DaftariClient; print('ok')"
```
Expected: installs from PyPI and imports cleanly. Follow @superpowers:verification-before-completion — "published" means this command printed `ok`, not "the workflow was green."

---

## Done criteria

- [ ] Model-facing schema test present and green on both matrix cells.
- [ ] langchain-core 1.x compatibility proven by CI (matrix), not asserted.
- [ ] `langchain-mcp-adapters` gone from deps.
- [ ] README roadmap corrected (no `DaftariStore(BaseStore)` promise).
- [ ] Publish workflow gated behind a reviewed `pypi` environment; pending trusted publisher registered.
- [ ] `pip install langchain-daftari` works in a clean env and imports.
