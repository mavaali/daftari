# langchain-daftari

**The store that knows when it's wrong.**

`langchain-daftari` wraps a [Daftari](https://github.com/mavaali/daftari) MCP
vault as LangChain tools so a LangGraph agent can read, search, write, and
curate a long-lived, file-backed knowledge base — instead of re-deriving the
same answer every session.

## Why

Vector RAG retrieves *passages*. Daftari stores *compiled answers* —
markdown notes with frontmatter (status, confidence, provenance, decay), git
history, and an advisory linter. The vault is the agent's memory across runs.

Plug it into any LangChain/LangGraph workflow and you get four properties for
free:

- **Search before derive.** The wrapper marks `vault_search` as
  `CRITICAL: Call this BEFORE synthesizing an answer from scratch.`
- **Long-lived state.** Notes persist between sessions. Git history is the audit log.
- **Curation.** `vault_lint` flags stale, low-confidence, or unsourced notes.
- **Provenance.** Every write is auto-committed; `vault_provenance` traces who
  added what when.

## Install

```bash
pip install langchain-daftari
# also install daftari itself (Node.js MCP server)
npm install -g daftari
```

Requirements:

- Python ≥ 3.10
- Node.js ≥ 18 (Daftari is shipped on npm)

## Quick start

```python
from langchain_daftari import DaftariClient, create_daftari_tools
from langgraph.prebuilt import create_react_agent
from langchain_anthropic import ChatAnthropic

with DaftariClient(vault_path="./my-vault", user="me", role="admin") as client:
    tools = create_daftari_tools(client)
    agent = create_react_agent(
        ChatAnthropic(model="claude-sonnet-4-6"),
        tools=tools,
    )
    result = agent.invoke({"messages": [
        ("system", "Search the vault before answering."),
        ("user", "What's our current take on Daftari vs vanilla RAG?"),
    ]})
    print(result["messages"][-1].content)
```

Don't have a vault yet? Scaffold one with `npx daftari --init ./my-vault`.

## What you get: 14 tools

| Category    | Tools                                                        |
|-------------|--------------------------------------------------------------|
| **Read**    | `vault_read`, `vault_index`, `vault_status`                  |
| **Search**  | `vault_search`, `vault_search_related`, `vault_themes`, `vault_reindex` |
| **Write**   | `vault_write`, `vault_append`, `vault_promote`, `vault_deprecate`       |
| **Curate**  | `vault_tension_log`, `vault_lint`, `vault_provenance`        |

Tool names, descriptions, and argument schemas come from the live MCP server's
`tools/list` response — never from baked-in copies — so the wrapper layer
tracks server changes automatically when you upgrade daftari.

### `vault_search` description override

The wrapper layer prepends one line to `vault_search`'s server-side description:

> CRITICAL: Call this BEFORE synthesizing an answer from scratch. The vault may already contain a compiled, reviewed answer.

The override is wrapper-side only — daftari's own description stays neutral so
other MCP clients (Claude Code, raw MCP) aren't strong-armed into a
LangGraph-specific workflow.

## The search-before-derive pattern

Pair the description override with a system prompt that reinforces the
discipline:

```python
SEARCH_BEFORE_DERIVE = """\
Core discipline: SEARCH BEFORE YOU DERIVE.

1. Before answering any non-trivial question, call vault_search.
2. If the vault has a compiled note, answer from it and cite the path.
3. If not, do the work, then vault_write a draft so future-you can find it.
4. If a note is stale or incomplete, vault_append or vault_promote.
"""
```

See `examples/demo_research_agent.py` for a runnable three-day simulation that
asserts the agent actually searches before answering on day 2 and day 3.

## Filtering the tool surface

```python
# only read-side tools for a "research-only" agent
tools = create_daftari_tools(client, include={
    "vault_search", "vault_search_related", "vault_read", "vault_status",
})

# everything except destructive curation
tools = create_daftari_tools(client, exclude={"vault_deprecate", "vault_tension_log"})
```

## Architecture

```
┌─────────────────────────┐
│  LangGraph ReAct agent  │
└────────────┬────────────┘
             │  StructuredTool.invoke / ainvoke
             ▼
┌─────────────────────────┐
│  create_daftari_tools   │   builds one StructuredTool per MCP tool
└────────────┬────────────┘
             │  DaftariClient.call_tool / acall_tool
             ▼
┌─────────────────────────┐
│      DaftariClient      │   subprocess + ClientSession on a
│   (transport primitive) │   dedicated background event loop
└────────────┬────────────┘
             │  JSON-RPC over stdio (MCP)
             ▼
┌─────────────────────────┐
│  daftari MCP server     │   Node.js, manages vault + SQLite index + git
└─────────────────────────┘
```

`DaftariClient` runs the MCP session on its own background event loop so a
single client can be shared safely by multi-threaded sync callers and async
event-loop callers without each call having to spawn a fresh subprocess.

## Reference: `DaftariClient`

```python
DaftariClient(
    *,
    vault_path: str,                          # required
    user: str = "guest",
    role: str = "guest",
    command: list[str] | None = None,         # default: ["npx", "daftari"]
    env: dict[str, str] | None = None,
    timeout: float = 30.0,
)
```

- Pass `command=["daftari"]` for a global npm install.
- Pass `command=["node", "/path/to/daftari/dist/cli.js"]` to run a local clone.
- Pass `command=["npx", "-y", "daftari@1.12.6"]` to pin a version.

Sync surface: `client.call_tool(name, args)` returns `DaftariResponse`.
Async surface: `await client.acall_tool(name, args)` does the same, safe from
any event loop.

`DaftariResponse` has:

- `.text` — concatenated text content blocks
- `.data` — parsed JSON if the text looks like JSON, otherwise the raw string
- `.is_error` — whether the MCP server flagged the call as an error
- `.raw` — the underlying `mcp.types.CallToolResult` for advanced inspection

## Compatibility

`langchain-daftari` is compatible with **daftari ≥ 1.12.0, < 2.0.0** on npm.

The compatibility line is documented here rather than pinned as a Python
dependency because daftari ships as an npm package, not a Python package. The
package will get a major version bump on the Python side if any of the
following happens server-side:

- A tool is removed.
- A tool's input schema changes in a breaking way.
- The MCP protocol version changes.

Tool *additions* and non-breaking schema changes do not require a major bump
because the wrapper layer reads schemas live from `tools/list`.

## Development

```bash
cd integrations/langchain
uv venv && source .venv/bin/activate
uv pip install -e ".[dev]"

pytest                            # all 34 tests (28 mock + 6 integration)
pytest -m "not integration"       # mock-only, no Node.js required
```

The integration tests boot a real daftari subprocess via `npx`. They skip
themselves cleanly if `npx` isn't on PATH.

## Status & roadmap

This is **phase 1** — a thin LangChain tool wrapper over the daftari MCP
surface. `DaftariClient` is deliberately LangChain-free so the same transport
primitive can carry phase 2:

- **Phase 2** — `DaftariStore(BaseStore)` for LangGraph long-term memory, so
  daftari can sit behind the `store=` arg on `create_react_agent` and behind
  `MemorySaver` for thread-scoped state.

Out of scope for this release: an async-first user surface, LangServe deployers,
and any opinionated retriever / chain abstractions on top of the raw tools.

## License

MIT. See [LICENSE](LICENSE).
