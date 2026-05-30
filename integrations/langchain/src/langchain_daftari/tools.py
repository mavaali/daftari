"""LangChain tool wrappers around the daftari MCP tool surface.

Why hand-rolled instead of using ``langchain_mcp_adapters.load_mcp_tools``
verbatim: ``load_mcp_tools`` binds each returned tool's coroutine directly to a
``ClientSession`` instance, and ``ClientSession`` is backed by anyio memory
streams that are bound to the event loop that created them. ``DaftariClient``
runs its session on a dedicated background loop (so sync ``.invoke()`` and
multi-threaded concurrent calls both work), which means a tool bound to that
session can't be safely awaited from any other loop.

This module uses the daftari client's ``list_tools()`` to read schemas + the
annotations metadata that ``load_mcp_tools`` would also surface, then builds
``StructuredTool`` instances whose ``func``/``coroutine`` go through
``DaftariClient.call_tool`` / ``acall_tool`` — both of which do the cross-loop
dispatch correctly.
"""

from __future__ import annotations

from typing import Any, Iterable, Optional

from langchain_core.tools import BaseTool, StructuredTool

from .client import DaftariClient

VAULT_SEARCH_DESCRIPTION_OVERRIDE: str = (
    "CRITICAL: Call this BEFORE synthesizing an answer from scratch. "
    "The vault may already contain a compiled, reviewed answer."
)
"""Prepended to ``vault_search``'s server-provided description at the wrapper layer.

Not pushed back to the server — daftari's tool description stays neutral so other
clients (Claude Code, raw MCP) aren't strong-armed into a LangGraph-specific
workflow. This wrapper-layer override is what ``create_daftari_tools`` does.
"""


def create_daftari_tools(
    client: DaftariClient,
    *,
    include: Optional[Iterable[str]] = None,
    exclude: Optional[Iterable[str]] = None,
) -> list[BaseTool]:
    """Build LangChain tools for the daftari tool surface exposed by ``client``.

    Schemas, descriptions, and annotations come from the live ``tools/list`` of
    the connected daftari server — never from baked-in copies — so the wrappers
    track server-side changes automatically when daftari is upgraded.

    Args:
        client: An already-open ``DaftariClient``.
        include: If given, only tools whose name is in this set are returned.
        exclude: If given, tools whose name is in this set are dropped.
            Applied after ``include``.

    Returns:
        A list of ``BaseTool`` instances ready to hand to ``create_react_agent``
        or any other LangChain/LangGraph tool consumer. Names match the daftari
        tool names verbatim (``vault_read``, ``vault_search``, ...).
    """
    include_set = set(include) if include is not None else None
    exclude_set = set(exclude) if exclude is not None else set()

    mcp_tools = client.list_tools()

    out: list[BaseTool] = []
    for mcp_tool in mcp_tools:
        name = mcp_tool.name
        if include_set is not None and name not in include_set:
            continue
        if name in exclude_set:
            continue
        out.append(_build_tool(client, mcp_tool))
    return out


def _build_tool(client: DaftariClient, mcp_tool: Any) -> BaseTool:
    name: str = mcp_tool.name
    description: str = mcp_tool.description or ""
    if name == "vault_search":
        description = f"{VAULT_SEARCH_DESCRIPTION_OVERRIDE}\n\n{description}".strip()

    schema = _normalize_schema(getattr(mcp_tool, "inputSchema", None))

    annotations = getattr(mcp_tool, "annotations", None)
    metadata: dict[str, Any] = {}
    if annotations is not None:
        try:
            metadata.update(annotations.model_dump(exclude_none=True))
        except AttributeError:
            pass

    def _sync_call(**kwargs: Any) -> str:
        response = client.call_tool(name, kwargs)
        if response.is_error:
            return f"[DAFTARI ERROR] {response.text}"
        return response.text

    async def _async_call(**kwargs: Any) -> str:
        response = await client.acall_tool(name, kwargs)
        if response.is_error:
            return f"[DAFTARI ERROR] {response.text}"
        return response.text

    return StructuredTool(
        name=name,
        description=description,
        args_schema=schema,
        func=_sync_call,
        coroutine=_async_call,
        metadata=metadata or None,
    )


def _normalize_schema(schema: Any) -> dict[str, Any]:
    """Coerce the inputSchema field into a JSON Schema dict.

    daftari returns plain ``dict`` schemas via MCP, but the SDK doesn't promise
    that across versions — coerce just in case.
    """
    if schema is None:
        return {"type": "object", "properties": {}}
    if isinstance(schema, dict):
        return schema
    if hasattr(schema, "model_dump"):
        return schema.model_dump(exclude_none=True)
    raise TypeError(f"unrecognized inputSchema type: {type(schema)!r}")
