"""Shared test fixtures."""

from __future__ import annotations

import shutil
from typing import Any

import pytest


def daftari_on_path() -> bool:
    return shutil.which("daftari") is not None or shutil.which("npx") is not None


@pytest.fixture
def fake_mcp_tool():
    """Factory for an mcp.types.Tool-shaped duck object."""

    def _make(
        name: str,
        description: str = "",
        input_schema: dict[str, Any] | None = None,
        annotations: Any = None,
    ):
        class _Tool:
            pass

        t = _Tool()
        t.name = name
        t.description = description
        t.inputSchema = input_schema or {"type": "object", "properties": {}}
        t.annotations = annotations
        return t

    return _make
