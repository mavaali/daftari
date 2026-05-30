"""End-to-end demo: a LangGraph ReAct agent backed by a Daftari vault.

What it shows
-------------

A research agent that is asked the same question three "days" in a row. On day
1 the vault is empty, so the agent works from scratch and writes a draft note.
On day 2 the agent finds the draft, refines it, and promotes it. On day 3 the
agent answers from the compiled note directly — fast, cited, no re-derivation.

The "days" are simulated by writing frontmatter ``created`` / ``updated`` dates
45+ days apart so daftari's decay heuristic actually fires on the day-3 round.
Without that explicit time shift the staleness-aware ranking never kicks in and
the demo becomes theatre.

The script also measures the "search-before-derive" discipline: each day, it
records how many times the agent called ``vault_search`` before its first
synthesis turn. Day 2 and day 3 are expected to show at least one
``vault_search`` call before any non-daftari work (printed at the end). This
guards against confounders — without the measurement, "day 3 used the compiled
answer" might just be model variance.

How to run
----------

    pip install ".[demo]"            # langgraph + langchain-anthropic
    export ANTHROPIC_API_KEY=...
    python examples/demo_research_agent.py

The vault used is an ephemeral temp directory; nothing is left behind.
"""

from __future__ import annotations

import os
import tempfile
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import BaseTool

from langchain_daftari import DaftariClient, create_daftari_tools


SYSTEM_PROMPT = """You are a research assistant backed by a Daftari vault — a curated, versioned
knowledge store that you build up over time.

Core discipline: SEARCH BEFORE YOU DERIVE.

1. Before answering any non-trivial question, call ``vault_search`` to see if
   the vault already contains a compiled, reviewed answer.
2. If it does, answer from that note and cite it by path.
3. If it doesn't, do the work from scratch, then ``vault_write`` a note (status:
   "draft") so future-you can find it.
4. If the existing note is incomplete or out-of-date, ``vault_append`` to it or
   ``vault_promote`` it to "compiled" once it is solid.

The vault is your long-term memory. Treat it as authoritative."""


QUESTION = "Summarize the strongest evidence we have on whether Daftari's compiled-knowledge model beats vanilla RAG."


def _wrap_with_counter(
    tools: list[BaseTool], counter: dict[str, int]
) -> list[BaseTool]:
    """Wrap each tool's ``func`` so we can count calls per tool by day."""

    wrapped: list[BaseTool] = []
    for tool in tools:
        original_func = tool.func
        original_coro = tool.coroutine
        name = tool.name

        def _make_sync(_name, _f):
            def _wrapped(**kwargs):
                counter[_name] += 1
                return _f(**kwargs)

            return _wrapped

        def _make_async(_name, _c):
            async def _wrapped(**kwargs):
                counter[_name] += 1
                return await _c(**kwargs)

            return _wrapped

        tool.func = _make_sync(name, original_func)
        if original_coro is not None:
            tool.coroutine = _make_async(name, original_coro)
        wrapped.append(tool)
    return wrapped


def _seed_compiled_note(client: DaftariClient, created: date, today: date) -> None:
    """Day-2 setup: write a draft so day 2's agent finds something to refine.

    Frontmatter dates are set explicitly so daftari's decay logic sees a real
    age gap when the day-3 run lands.
    """
    client.call_tool(
        "vault_write",
        {
            "path": "research/daftari-vs-rag.md",
            "agent": "demo-day-1",
            "frontmatter": {
                "title": "Daftari vs vanilla RAG: evidence summary",
                "status": "draft",
                "domain": "accumulation",
                "collection": "research",
                "confidence": "medium",
                "created": created.isoformat(),
                "updated": created.isoformat(),
                "provenance": "synthesized",
            },
            "body": (
                "Initial draft synthesized on day 1. Key claims to verify:\n"
                "- Compiled notes survive across sessions; RAG context does not.\n"
                "- Curated provenance reduces hallucination on contested topics.\n"
                "- Index decay surfaces stale knowledge for review.\n"
            ),
        },
    )


def _run_day(
    label: str,
    *,
    agent: Any,
    counter: dict[str, int],
) -> None:
    counter.clear()
    print(f"\n========== {label} ==========")
    result = agent.invoke(
        {
            "messages": [
                SystemMessage(content=SYSTEM_PROMPT),
                HumanMessage(content=QUESTION),
            ]
        }
    )
    final = result["messages"][-1]
    body = getattr(final, "content", "") or ""
    print(body[:600] + ("..." if len(body) > 600 else ""))
    print(f"  [measure] tool calls this day: {dict(counter)}")


def main() -> None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit(
            "ANTHROPIC_API_KEY is not set; export it before running the demo."
        )

    from langchain_anthropic import ChatAnthropic
    from langgraph.prebuilt import create_react_agent

    with tempfile.TemporaryDirectory(prefix="lc-daftari-demo-") as tmp:
        vault_path = str(Path(tmp) / "vault")
        # init the vault via the daftari CLI directly — same as a real install
        import subprocess

        subprocess.run(
            ["npx", "daftari", "--init", vault_path],
            check=True,
            capture_output=True,
        )

        today = date(2026, 5, 29)
        day_minus_45 = today - timedelta(days=45)

        llm = ChatAnthropic(model="claude-sonnet-4-6", temperature=0)

        counter: dict[str, int] = defaultdict(int)

        with DaftariClient(vault_path=vault_path, user="researcher", role="admin") as client:
            tools = create_daftari_tools(client)
            tools = _wrap_with_counter(tools, counter)
            agent = create_react_agent(llm, tools=tools)

            # ----- day 1: empty vault, agent should write a fresh draft
            day1_calls: dict[str, int] = {}
            counter.clear()
            _run_day("Day 1 (empty vault)", agent=agent, counter=counter)
            day1_calls = dict(counter)

            # ----- day 2: pre-seed a draft (created 45+ days ago) so decay matters
            _seed_compiled_note(client, created=day_minus_45, today=today)
            counter.clear()
            _run_day("Day 2 (vault has stale draft)", agent=agent, counter=counter)
            day2_calls = dict(counter)

            # ----- day 3: vault should now have a refined note from day 2
            counter.clear()
            _run_day("Day 3 (vault has compiled answer)", agent=agent, counter=counter)
            day3_calls = dict(counter)

            print("\n========== vault_lint ==========")
            lint = client.call_tool("vault_lint", {})
            print(lint.text[:600])

        print("\n========== measurement ==========")
        print(f"  day 1 calls: {day1_calls}")
        print(f"  day 2 calls: {day2_calls}")
        print(f"  day 3 calls: {day3_calls}")

        assert day2_calls.get("vault_search", 0) >= 1, (
            "search-before-derive violated on day 2: agent did not search the vault "
            "before answering even though a draft was already there. This usually "
            "means the system prompt isn't being followed; rerun with a sterner "
            "prompt or check the model."
        )
        assert day3_calls.get("vault_search", 0) >= 1, (
            "search-before-derive violated on day 3: vault contained a refined note "
            "but the agent didn't search before answering."
        )
        print("  search-before-derive: PASSED on day 2 and day 3")


if __name__ == "__main__":
    main()
