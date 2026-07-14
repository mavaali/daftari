#!/usr/bin/env python
"""Agent detection pass — daftari's actual usage model, scripted.

The two-gate consolidate loop builds a DERIVATION graph; contradiction
detection in daftari is agent work: an agent reads notes, retrieves related
notes (vault_search_related), judges conflicts, and logs them with
vault_tension_log. This script is that agent, pinned down and instrumented.

Deliberate symmetry with the LangMem side (fixtures/populate.py):
  - same judge model (gpt-5.2 via OpenRouter),
  - same retrieval-scoped view: the judge only ever sees ONE PAIR of claims
    at a time — it never sees the whole corpus, exactly like LangMem's
    query_limit-scoped consolidation.
The architectural difference under test is what happens AFTER a conflict is
seen: LangMem arbitrates in place (overwrite/delete); daftari appends to a
tension ledger, and connected components assemble the n-way structure no
single judgment ever saw.

Anti-theatre instrumentation: every search and judge call is counted;
pair-level verdicts land in detect-report.json. No eyeball verification.

Usage: .venv/bin/python detect_tensions.py [vault] [--limit N]
"""

import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "integrations" / "langchain" / "src"))

from langchain_daftari import DaftariClient  # noqa: E402

VAULT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else str(HERE / "vault")
RELATED_LIMIT = 6
JUDGE_MODEL = "openai/gpt-5.2"

JUDGE_PROMPT = """You are auditing an organization's knowledge base for \
contradictions. Two claim documents follow. Decide whether they make claims \
that cannot both be true as stated (factual conflict), conflict only in time \
or versioning (temporal), or conflict in framing/responsibility (interpretive).

Be conservative: related-but-compatible claims, or claims about different \
scopes that could both hold, are NOT conflicts. Only flag genuine \
incompatibility a curator should review.

CLAIM A ({path_a}):
{text_a}

CLAIM B ({path_b}):
{text_b}

Answer with only JSON: {{"conflict": true|false, "kind": "factual"|"temporal"|"interpretive", "reason": "<one sentence>"}}"""


def load_env() -> None:
    for line in (HERE / ".env").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            k, _, v = line.partition("=")
            os.environ.setdefault(k, v)


def note_text(path: Path) -> str:
    """Claim text = body minus frontmatter and the provenance section."""
    raw = path.read_text()
    body = re.split(r"^---$", raw, flags=re.M)[-1]
    return body.split("## Provenance")[0].strip()


def main() -> None:
    load_env()
    from openai import OpenAI

    llm = OpenAI(base_url="https://openrouter.ai/api/v1", api_key=os.environ["OPENROUTER_API_KEY"])

    vault = Path(VAULT)
    notes = sorted(p for p in vault.rglob("*.md") if ".daftari" not in p.parts)
    rels = [str(p.relative_to(vault)) for p in notes]
    texts = {r: note_text(vault / r) for r in rels}

    report = {
        "notes": len(rels),
        "search_calls": 0,
        "judge_calls": 0,
        "pairs_judged": 0,
        "tensions_logged": 0,
        "verdicts": [],
    }
    judged: set[frozenset] = set()

    with DaftariClient(
        vault_path=str(vault),
        user="demo-agent",
        role="admin",
        command=["node", str(REPO / "dist" / "cli.js")],
        timeout=180,
    ) as client:
        for rel in rels:
            resp = client.call_tool("vault_search_related", {"path": rel, "limit": RELATED_LIMIT})
            report["search_calls"] += 1
            if resp.is_error:
                print(f"search error on {rel}: {resp.text[:120]}", file=sys.stderr)
                continue
            hits = resp.data.get("hits", []) if isinstance(resp.data, dict) else []
            neighbor_paths = [h["path"] for h in hits if isinstance(h, dict) and h.get("path") in texts]

            for nb in neighbor_paths:
                pair = frozenset((rel, nb))
                if len(pair) != 2 or pair in judged:
                    continue
                judged.add(pair)
                report["pairs_judged"] += 1

                prompt = JUDGE_PROMPT.format(
                    path_a=rel, text_a=texts[rel], path_b=nb, text_b=texts[nb]
                )
                r = llm.chat.completions.create(
                    model=JUDGE_MODEL,
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=5000,
                )
                report["judge_calls"] += 1
                out = (r.choices[0].message.content or "").strip()
                m = re.search(r"\{.*\}", out, re.S)
                try:
                    verdict = json.loads(m.group(0)) if m else {"conflict": False}
                except json.JSONDecodeError:
                    verdict = {"conflict": False, "reason": f"unparseable: {out[:80]}"}

                report["verdicts"].append({"a": rel, "b": nb, **verdict})
                if not verdict.get("conflict"):
                    continue

                kind = verdict.get("kind", "factual")
                if kind not in ("factual", "temporal", "interpretive"):
                    kind = "factual"
                title = f"{Path(rel).stem[:40]} vs {Path(nb).stem[:40]}"
                log = client.call_tool(
                    "vault_tension_log",
                    {
                        "title": title,
                        "sourceA": rel,
                        "claimA": texts[rel][:200],
                        "sourceB": nb,
                        "claimB": texts[nb][:200],
                        "kind": kind,
                        "agent": "agent:demo-detector",
                    },
                )
                if log.is_error:
                    print(f"tension_log error: {log.text[:160]}", file=sys.stderr)
                else:
                    report["tensions_logged"] += 1
                    print(f"TENSION [{kind}] {rel}  <->  {nb}")

    (HERE / "detect-report.json").write_text(json.dumps(report, indent=2))
    print(
        f"\nnotes={report['notes']} searches={report['search_calls']} "
        f"pairs={report['pairs_judged']} judges={report['judge_calls']} "
        f"tensions={report['tensions_logged']}"
    )


if __name__ == "__main__":
    main()
