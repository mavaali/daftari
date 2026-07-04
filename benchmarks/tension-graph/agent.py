"""The benchmark agent: given a per-cell Context, produce the structured answer
contract (spec §5). Provider-agnostic LLM interface with two implementations:

  MockLLM        deterministic, offline, zero-cost. A pure function of the prompt
                 text — used to prove the pipeline end-to-end and to make the
                 3a-vs-3b delta visible without spending anything. NOT real data.
  OpenRouterLLM  neutral third-party model via OpenRouter (decided §9 item 2).
                 The published run swaps MockLLM -> OpenRouterLLM. Requires
                 OPENROUTER_API_KEY; makes billed network calls.

The agent loop is identical across cells and both cell-3 variants (anti-gaming,
spec §4): same instructions, same budget. The ONLY difference is what the
substrate put in the Context — an inline [CONTESTED] marker (3b), a callable
tool (3a), or nothing (data-olympus / daftari-no-tg).
"""
from __future__ import annotations

import json
import os
from typing import TYPE_CHECKING, Protocol

from benchmarks.feud_metrics import FeudAnswer

if TYPE_CHECKING:
    from benchmarks.substrate import Context

_SYSTEM = (
    "You are a governance assistant answering an engineering question from a "
    "knowledge base. Use ONLY the provided documents. If the evidence is "
    "settled, give the governing rule. If two documents make contradicting "
    "claims and nothing resolves which governs, you MUST surface the "
    "contradiction rather than pick one or invent a synthesis.\n"
    "Reply with ONLY a JSON object: "
    '{"answer": str, "evidence_state": "settled"|"contested"|"unknown", '
    '"cited_docs": [doc_id, ...]}.'
)

_DECIDE_SYSTEM = (
    "You are a governance assistant. A tool check_contradictions() can report "
    "whether the retrieved documents are subject to a recorded, unresolved "
    "contradiction. Decide whether to call it. Reply with exactly one word: "
    "CALL or ANSWER."
)


class LLM(Protocol):
    def complete(self, system: str, user: str) -> str: ...


# ---------------------------------------------------------------------------
# Prompt rendering
# ---------------------------------------------------------------------------

def _render_docs(ctx: Context) -> str:
    lines = [f"Query: {ctx.query}", "", "Retrieved documents:"]
    for d in ctx.docs:
        lines.append(f"- id={d.id} title={d.title!r}\n  {d.snippet}")
    if ctx.inline_contested:
        lines += ["", ctx.inline_contested]
    return "\n".join(lines)


def _render_tool_output(records: list[dict]) -> str:
    if not records:
        return "\ncheck_contradictions() -> [] (no recorded contradiction)"
    lines = ["\ncheck_contradictions() ->"]
    for r in records:
        lines.append(
            f'  UNRESOLVED TENSION: {r["doc_a"]} says "{r["claim_a"]}" '
            f'vs {r["doc_b"]} says "{r["claim_b"]}"'
        )
    return "\n".join(lines)


_ANSWER_INSTRUCTION = "\n\nNow answer with ONLY the JSON object."


# ---------------------------------------------------------------------------
# Contract parsing
# ---------------------------------------------------------------------------

def parse_contract(raw: str) -> FeudAnswer:
    """Extract the JSON contract from a model reply. On any failure, return an
    'unknown' answer (classified as a miss, not a fabrication)."""
    text = raw.strip()
    if "```" in text:
        # strip a fenced block if present
        parts = text.split("```")
        for p in parts:
            p = p.strip()
            if p.startswith("{") or p.startswith("json"):
                text = p[4:].strip() if p.startswith("json") else p
                break
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return FeudAnswer(answer=raw[:200], evidence_state="unknown", cited_docs=[])
    try:
        obj = json.loads(text[start : end + 1])
    except (json.JSONDecodeError, ValueError):
        return FeudAnswer(answer=raw[:200], evidence_state="unknown", cited_docs=[])
    state = str(obj.get("evidence_state", "unknown")).strip().lower()
    cited = obj.get("cited_docs", []) or []
    if not isinstance(cited, list):
        cited = []
    return FeudAnswer(
        answer=str(obj.get("answer", "")),
        evidence_state=state,
        cited_docs=[str(c) for c in cited],
    )


# ---------------------------------------------------------------------------
# Agent loop (identical across cells; branches only on what the Context offers)
# ---------------------------------------------------------------------------

def run_agent(llm: LLM, ctx: Context) -> FeudAnswer:
    docs_block = _render_docs(ctx)

    if ctx.tension_tool_available:  # cell 3a: the agent may consult the tool
        decision = llm.complete(_DECIDE_SYSTEM, docs_block)
        if "CALL" in decision.strip().upper():
            tool_out = _render_tool_output(ctx.call_check_contradictions())
            user = docs_block + tool_out + _ANSWER_INSTRUCTION
        else:
            user = docs_block + _ANSWER_INSTRUCTION
    else:
        user = docs_block + _ANSWER_INSTRUCTION

    return parse_contract(llm.complete(_SYSTEM, user))


# ---------------------------------------------------------------------------
# MockLLM — deterministic, offline. Pure function of the prompt text.
# ---------------------------------------------------------------------------

class MockLLM:
    """Deterministic stand-in. Behaves like an agent that reasons only from what
    it can see:
      - sees an inline [CONTESTED] marker or a tool-reported tension -> contested,
        cites both sides.
      - sees neither -> settled, cites the first retrieved doc (a 'pick').
    ``diligent_3a`` controls whether the 3a agent chooses to CALL the tool. Default
    False models the realistic lazy agent, making the 3a<3b delta visible.
    """

    def __init__(self, *, diligent_3a: bool = False) -> None:
        self.diligent_3a = diligent_3a

    def complete(self, system: str, user: str) -> str:
        if system == _DECIDE_SYSTEM:
            return "CALL" if self.diligent_3a else "ANSWER"

        contested = "CONTESTED" in user or "UNRESOLVED TENSION" in user
        ids = _mock_extract_ids(user)
        if contested:
            a, b = _mock_two_contested_ids(user)
            cite = [x for x in (a, b) if x] or ids[:2]
            return json.dumps({
                "answer": "Two active standards conflict and nothing resolves which governs.",
                "evidence_state": "contested",
                "cited_docs": cite,
            })
        # No contradiction visible: commit to the first retrieved doc.
        return json.dumps({
            "answer": "The governing rule is the top retrieved standard.",
            "evidence_state": "settled",
            "cited_docs": ids[:1],
        })


def _mock_extract_ids(user: str) -> list[str]:
    ids: list[str] = []
    for line in user.splitlines():
        marker = "id="
        if marker in line:
            frag = line.split(marker, 1)[1].split()[0]
            ids.append(frag)
    return ids


def _mock_two_contested_ids(user: str) -> tuple[str | None, str | None]:
    """Pull the two doc ids out of a [CONTESTED ...] or tool-output line."""
    import re

    m = re.findall(r"(FEUD_[A-Z0-9_]+)", user)
    if len(m) >= 2:
        # first two DISTINCT ids
        seen: list[str] = []
        for x in m:
            if x not in seen:
                seen.append(x)
            if len(seen) == 2:
                break
        if len(seen) == 2:
            return seen[0], seen[1]
    return (None, None)


# ---------------------------------------------------------------------------
# OpenRouterLLM — real, billed. Swapped in for the published run.
# ---------------------------------------------------------------------------

class OpenRouterLLM:
    """Neutral third-party model via OpenRouter. Uses urllib (no new deps).
    Requires OPENROUTER_API_KEY. Makes billed network calls — never used in the
    offline scaffold or tests."""

    def __init__(self, model: str = "openai/gpt-4o-mini", *, temperature: float = 0.0) -> None:
        self.model = model
        self.temperature = temperature
        self.api_key = os.environ.get("OPENROUTER_API_KEY")

    def complete(self, system: str, user: str) -> str:  # pragma: no cover - network
        import urllib.request

        if not self.api_key:
            raise RuntimeError("OPENROUTER_API_KEY not set")
        payload = json.dumps({
            "model": self.model,
            "temperature": self.temperature,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions",
            data=payload,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
            body = json.loads(resp.read().decode("utf-8"))
        return body["choices"][0]["message"]["content"]
