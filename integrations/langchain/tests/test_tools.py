"""Unit tests for the create_daftari_tools factory.

These don't spin up a real daftari subprocess — they feed a fake
``DaftariClient`` to the factory and assert the wrapper layer behaves.
"""

from __future__ import annotations

import asyncio
from typing import Any

from langchain_daftari.response import DaftariResponse
from langchain_daftari.tools import (
    VAULT_SEARCH_DESCRIPTION_OVERRIDE,
    create_daftari_tools,
)


# ---------- fakes ----------------------------------------------------------


class _FakeTool:
    def __init__(self, name, description, input_schema=None, annotations=None):
        self.name = name
        self.description = description
        self.inputSchema = input_schema or {"type": "object", "properties": {}}
        self.annotations = annotations


class _FakeClient:
    """A DaftariClient stand-in. Records every call_tool/acall_tool dispatch."""

    def __init__(self, tools: list[_FakeTool], reply_text: str = "ok", is_error: bool = False):
        self._tools = tools
        self.reply_text = reply_text
        self.is_error = is_error
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.acalls: list[tuple[str, dict[str, Any]]] = []

    def list_tools(self):
        return list(self._tools)

    def _make_response(self):
        class _Block:
            def __init__(self, text):
                self.text = text

        class _Result:
            pass

        result = _Result()
        result.content = [_Block(self.reply_text)]
        result.isError = self.is_error
        return DaftariResponse.from_mcp_result(result)

    def call_tool(self, name, arguments=None):
        self.calls.append((name, dict(arguments or {})))
        return self._make_response()

    async def acall_tool(self, name, arguments=None):
        self.acalls.append((name, dict(arguments or {})))
        return self._make_response()


# the 14 tools we expect to see in the live server
EXPECTED_DAFTARI_TOOLS = {
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


def _all_fake_tools() -> list[_FakeTool]:
    return [_FakeTool(name=n, description=f"daftari {n} tool") for n in EXPECTED_DAFTARI_TOOLS]


# ---------- factory tests --------------------------------------------------


def test_factory_returns_one_tool_per_mcp_tool():
    client = _FakeClient(_all_fake_tools())
    tools = create_daftari_tools(client)
    assert len(tools) == 14
    assert {t.name for t in tools} == EXPECTED_DAFTARI_TOOLS


def test_factory_tool_names_are_unique():
    client = _FakeClient(_all_fake_tools())
    tools = create_daftari_tools(client)
    names = [t.name for t in tools]
    assert len(set(names)) == len(names)


def test_factory_tools_have_substantive_descriptions():
    client = _FakeClient(_all_fake_tools())
    tools = create_daftari_tools(client)
    for t in tools:
        assert isinstance(t.description, str)
        assert len(t.description) > 5, f"tool {t.name} has empty/trivial description"


def test_factory_include_filter_whitelists():
    client = _FakeClient(_all_fake_tools())
    tools = create_daftari_tools(client, include={"vault_read", "vault_search"})
    assert {t.name for t in tools} == {"vault_read", "vault_search"}


def test_factory_exclude_filter_drops():
    client = _FakeClient(_all_fake_tools())
    tools = create_daftari_tools(client, exclude={"vault_write", "vault_deprecate"})
    names = {t.name for t in tools}
    assert "vault_write" not in names
    assert "vault_deprecate" not in names
    assert "vault_read" in names


def test_factory_include_then_exclude_applies_both():
    client = _FakeClient(_all_fake_tools())
    tools = create_daftari_tools(
        client,
        include={"vault_read", "vault_write", "vault_search"},
        exclude={"vault_write"},
    )
    assert {t.name for t in tools} == {"vault_read", "vault_search"}


def test_vault_search_description_is_prepended():
    client = _FakeClient(_all_fake_tools())
    tools = create_daftari_tools(client)
    vs = next(t for t in tools if t.name == "vault_search")
    assert vs.description.startswith(VAULT_SEARCH_DESCRIPTION_OVERRIDE)
    # the original description is still appended afterwards
    assert "daftari vault_search tool" in vs.description


def test_other_tools_description_not_prefixed_with_override():
    client = _FakeClient(_all_fake_tools())
    tools = create_daftari_tools(client)
    for t in tools:
        if t.name == "vault_search":
            continue
        assert VAULT_SEARCH_DESCRIPTION_OVERRIDE not in t.description


# ---------- delegation tests -----------------------------------------------


def test_sync_invoke_delegates_to_client_call_tool():
    schema = {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    }
    client = _FakeClient(
        [_FakeTool("vault_read", "read a vault file", input_schema=schema)],
        reply_text="file body",
    )
    [tool] = create_daftari_tools(client)
    result = tool.invoke({"path": "notes/foo.md"})
    assert result == "file body"
    assert client.calls == [("vault_read", {"path": "notes/foo.md"})]


def test_async_invoke_delegates_to_client_acall_tool():
    schema = {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    }
    client = _FakeClient(
        [_FakeTool("vault_read", "read a vault file", input_schema=schema)],
        reply_text="async file body",
    )
    [tool] = create_daftari_tools(client)
    result = asyncio.run(tool.ainvoke({"path": "notes/foo.md"}))
    assert result == "async file body"
    assert client.acalls == [("vault_read", {"path": "notes/foo.md"})]
    assert client.calls == []  # ainvoke should not go through the sync path


def test_error_responses_are_prefixed():
    client = _FakeClient(
        [_FakeTool("vault_read", "x")],
        reply_text="something exploded",
        is_error=True,
    )
    [tool] = create_daftari_tools(client)
    out = tool.invoke({})
    assert out.startswith("[DAFTARI ERROR]")
    assert "something exploded" in out


def test_optional_arguments_passed_through_only_when_provided():
    schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "limit": {"type": "integer"},
        },
        "required": ["path"],
    }
    client = _FakeClient([_FakeTool("vault_index", "list", input_schema=schema)])
    [tool] = create_daftari_tools(client)
    tool.invoke({"path": "/notes"})
    tool.invoke({"path": "/notes", "limit": 5})
    assert client.calls == [
        ("vault_index", {"path": "/notes"}),
        ("vault_index", {"path": "/notes", "limit": 5}),
    ]


def test_args_schema_carries_over_from_mcp_inputschema():
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
    args = tool.args
    assert "path" in args
    assert "limit" in args
    assert args["path"]["type"] == "string"


def test_annotations_become_tool_metadata():
    class _Anno:
        def __init__(self, **kw):
            self._kw = kw

        def model_dump(self, exclude_none: bool = True):
            return {k: v for k, v in self._kw.items() if v is not None}

    annotations = _Anno(readOnlyHint=True, destructiveHint=False, openWorldHint=True)
    client = _FakeClient(
        [_FakeTool("vault_read", "read", annotations=annotations)]
    )
    [tool] = create_daftari_tools(client)
    md = tool.metadata or {}
    assert md.get("readOnlyHint") is True
    assert md.get("destructiveHint") is False
    assert md.get("openWorldHint") is True
