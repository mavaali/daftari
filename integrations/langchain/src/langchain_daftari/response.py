"""DaftariResponse — the typed wrapper around an MCP CallToolResult."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class DaftariResponse:
    """Result of a single Daftari tool call.

    Attributes:
        text: Concatenated text from all text-content blocks. Empty string if none.
        data: Parsed JSON when ``text`` looks like JSON, otherwise ``text`` verbatim.
            ``None`` if ``text`` is empty.
        is_error: True if the MCP server flagged this call as an error.
        raw: The underlying ``mcp.types.CallToolResult`` for callers that need the
            full content list, annotations, structured content, etc.
    """

    text: str
    data: Any
    is_error: bool
    raw: Any = field(default=None, repr=False)

    @classmethod
    def from_mcp_result(cls, result: Any) -> "DaftariResponse":
        """Build a DaftariResponse from an ``mcp.types.CallToolResult``."""
        text_parts: list[str] = []
        for block in getattr(result, "content", []) or []:
            block_text = getattr(block, "text", None)
            if block_text is not None:
                text_parts.append(block_text)
        text = "\n".join(text_parts)

        data: Any = None
        if text:
            try:
                data = json.loads(text)
            except (json.JSONDecodeError, ValueError):
                data = text

        return cls(
            text=text,
            data=data,
            is_error=bool(getattr(result, "isError", False)),
            raw=result,
        )
