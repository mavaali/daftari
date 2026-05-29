"""Unit tests for DaftariClient that don't require a real daftari subprocess."""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest

from langchain_daftari.client import (
    DaftariClient,
    DaftariConnectionError,
    DaftariNotFoundError,
)
from langchain_daftari.response import DaftariResponse


def test_init_defaults():
    c = DaftariClient(vault_path="/tmp/vault")
    assert c.vault_path == "/tmp/vault"
    assert c.user == "guest"
    assert c.role == "guest"
    assert c.command == ["npx", "daftari"]
    assert c.timeout == 30.0


def test_init_custom_command_is_copied():
    cmd = ["node", "/path/cli.js"]
    c = DaftariClient(vault_path="/tmp/v", command=cmd)
    assert c.command == cmd
    cmd.append("mutated")
    assert c.command == ["node", "/path/cli.js"], "constructor should copy the list"


def test_missing_binary_raises_fail_fast():
    """Resolving a bogus binary on PATH must raise DaftariNotFoundError before any subprocess work."""
    with patch("langchain_daftari.client.shutil.which", return_value=None):
        c = DaftariClient(vault_path="/tmp/v", command=["this-binary-does-not-exist"])
        with pytest.raises(DaftariNotFoundError) as ei:
            c.__enter__()
        msg = str(ei.value)
        assert "this-binary-does-not-exist" in msg
        assert "npm install -g daftari" in msg


def test_call_tool_before_open_raises():
    c = DaftariClient(vault_path="/tmp/v")
    with pytest.raises(DaftariConnectionError):
        c.call_tool("vault_read", {"path": "x.md"})


def test_acall_tool_before_open_raises():
    c = DaftariClient(vault_path="/tmp/v")
    with pytest.raises(DaftariConnectionError):
        asyncio.run(c.acall_tool("vault_read"))


def test_close_is_idempotent_when_never_opened():
    c = DaftariClient(vault_path="/tmp/v")
    c.close()
    c.close()


def test_response_from_mcp_result_used_by_call_tool_path():
    """End-to-end of the parse layer: a fake CallToolResult flows through DaftariResponse."""

    class _Block:
        def __init__(self, text):
            self.text = text

    class _Result:
        content = [_Block('{"ok": true}')]
        isError = False

    r = DaftariResponse.from_mcp_result(_Result())
    assert r.is_error is False
    assert r.data == {"ok": True}
