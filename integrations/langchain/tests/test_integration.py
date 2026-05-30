"""Integration test that boots a real daftari subprocess.

Skipped (loudly) if ``npx`` isn't on PATH. When present, this test guarantees
that the package agrees with the live MCP server on the tool surface — which is
how ``create_daftari_tools`` is supposed to stay in sync as daftari evolves.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from langchain_daftari import (
    DaftariClient,
    VAULT_SEARCH_DESCRIPTION_OVERRIDE,
    create_daftari_tools,
)

pytestmark = pytest.mark.integration


# The 14 tools we expect to find on a live v1.12.x daftari server. If daftari
# adds or removes a tool, this set is the canonical place to update — and the
# wrapper layer will adapt automatically thanks to tools/list-driven schemas.
EXPECTED_TOOL_NAMES: set[str] = {
    "vault_read",
    "vault_index",
    "vault_status",
    "vault_search",
    "vault_search_related",
    "vault_reindex",
    "vault_themes",
    "vault_write",
    "vault_append",
    "vault_promote",
    "vault_deprecate",
    "vault_tension_log",
    "vault_lint",
    "vault_provenance",
}


_skip_if_no_npx = pytest.mark.skipif(
    shutil.which("npx") is None,
    reason="npx not on PATH; install Node.js to exercise the integration test",
)


@pytest.fixture(scope="module")
def vault_path():
    """Create a temp vault via ``npx daftari --init`` and tear it down after."""
    if shutil.which("npx") is None:
        pytest.skip("npx not on PATH")

    with tempfile.TemporaryDirectory(prefix="lc-daftari-itest-") as tmp:
        vault = Path(tmp) / "vault"
        proc = subprocess.run(
            ["npx", "daftari", "--init", str(vault)],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if proc.returncode != 0:
            pytest.fail(
                f"daftari --init failed (rc={proc.returncode})\n"
                f"stdout: {proc.stdout}\n"
                f"stderr: {proc.stderr}"
            )
        yield str(vault)


@_skip_if_no_npx
def test_live_server_exposes_expected_tool_set(vault_path):
    with DaftariClient(vault_path=vault_path, user="me", role="admin") as client:
        tools = client.list_tools()
    names = {t.name for t in tools}
    assert names == EXPECTED_TOOL_NAMES, (
        f"daftari tool surface drifted; missing={EXPECTED_TOOL_NAMES - names}, "
        f"extra={names - EXPECTED_TOOL_NAMES}"
    )
    assert len(tools) == 14


@_skip_if_no_npx
def test_factory_produces_one_langchain_tool_per_mcp_tool(vault_path):
    with DaftariClient(vault_path=vault_path, user="me", role="admin") as client:
        tools = create_daftari_tools(client)
    assert len(tools) == 14
    assert {t.name for t in tools} == EXPECTED_TOOL_NAMES


@_skip_if_no_npx
def test_factory_vault_search_carries_description_override(vault_path):
    with DaftariClient(vault_path=vault_path, user="me", role="admin") as client:
        tools = create_daftari_tools(client)
    vs = next(t for t in tools if t.name == "vault_search")
    assert vs.description.startswith(VAULT_SEARCH_DESCRIPTION_OVERRIDE)


@_skip_if_no_npx
def test_factory_args_schema_for_vault_read_is_sensible(vault_path):
    with DaftariClient(vault_path=vault_path, user="me", role="admin") as client:
        tools = create_daftari_tools(client)
    vault_read = next(t for t in tools if t.name == "vault_read")
    args = vault_read.args
    assert "path" in args, f"vault_read should accept a path arg; got {args!r}"


@_skip_if_no_npx
def test_round_trip_status_call(vault_path):
    with DaftariClient(vault_path=vault_path, user="me", role="admin") as client:
        response = client.call_tool("vault_status", {})
    assert response.is_error is False
    assert response.text  # non-empty body


@_skip_if_no_npx
def test_round_trip_write_then_read(vault_path):
    with DaftariClient(vault_path=vault_path, user="me", role="admin") as client:
        write_response = client.call_tool(
            "vault_write",
            {
                "path": "_drafts/integration-test.md",
                "frontmatter": {
                    "title": "Integration test note",
                    "status": "draft",
                    "domain": "accumulation",
                    "collection": "_drafts",
                    "confidence": "medium",
                    "created": "2026-05-29",
                    "provenance": "direct",
                },
                "body": "Hello from langchain-daftari integration test.",
                "agent": "langchain-daftari-integration-test",
            },
        )
        assert write_response.is_error is False, write_response.text

        read_response = client.call_tool(
            "vault_read",
            {"path": "_drafts/integration-test.md"},
        )
    assert read_response.is_error is False
    assert "Hello from langchain-daftari integration test." in read_response.text
