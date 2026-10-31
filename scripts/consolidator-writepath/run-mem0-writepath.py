#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["mem0ai>=2.0.11,<3", "fastembed>=0.7", "qdrant-client>=1.15"]
# ///
"""
run-mem0-writepath.py — M3: run a real OSS consolidator's actual write path
(mem0ai's Memory.add()) on the paper's corpus-B 39 items (33 supersession traps
+ 6 genuine editor-certified tensions), and record what its store does.

Item M3, docs/paper/2026-07-01-moderator-review-correction-plan.md:
    "run one OSS consolidator's actual write path on the 39 Wikipedia items
    (33 traps + 6 tensions), ingest stale-then-governing (and both tension
    positions), inspect the store: one value kept? which? history survives?"

Protocol
--------
Traps (33): ingest staleText, then governingText, in that order (chronological,
    as a memory would see the edit stream). Then inspect get_all() for this
    item's fresh scope: how many memories survive, and is the surviving/most
    recent value governing, stale, or both? Then call history() on every
    surviving memory id to see if mem0 retained the superseded value or
    overwrote in place.
Tensions (6): ingest positionA, then positionB (the two editor-certified
    competing RfC positions, in citation order — status quo first). Inspect:
    did the store end up with both positions, did one overwrite/merge the
    other (the masquerade the paper's keystone forbids), or did the model
    correctly refuse to touch anything after seeing the tension.

Every item gets a FRESH Memory instance (fresh in-process qdrant collection,
`path=":memory:"`) and a fresh user_id, so items cannot contaminate each other
via mem0's cross-message extraction/dedup logic.

Config (top of file, no CLI flags to keep this a single-file, self-contained
artifact per the task spec)
---------------------------
LLM:        openai/gpt-4o via OpenRouter (OPENROUTER_API_KEY from env/~/.zshenv).
            mem0's OpenAILLM auto-detects OPENROUTER_API_KEY and routes through
            https://openrouter.ai/api/v1 — see mem0/llms/openai.py in the
            installed package. No custom client plumbing needed.
Embedder:   fastembed (BAAI/bge-small-en-v1.5), a local ONNX model, zero API
            key, zero network dependency after the one-time model download.
            Chosen because mem0's OpenAI embedder does NOT route through
            OpenRouter (OpenRouter has no generic /embeddings passthrough for
            arbitrary embedding models) and OPENAI_API_KEY is not set in this
            environment (checked; see the results doc's setup section).
Vector store: qdrant, path=":memory:" — the embedded, zero-infra local mode
            (no server, nothing to install beyond the qdrant-client package).

Run with: uv run scripts/consolidator-writepath/run-mem0-writepath.py
(the shebang + inline PEP 723 metadata block make `uv run` resolve and
install mem0ai/fastembed/qdrant-client automatically into an ephemeral venv).

Cost/budget note: this makes ~1 mem0 LLM extraction call per ingest (78 calls:
39 items x 2 ingests) plus incidental entity-extraction work mem0 does
internally. Model is openai/gpt-4o via OpenRouter, temperature 0, single run.
Budget guard: ~$5 total (see results doc for actual spend once metered).
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SEED = 20260701  # not used for LLM sampling (temp=0) but pins any local tie-breaks
MODEL = "openai/gpt-4o"
TEMPERATURE = 0
EMBEDDER_MODEL = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIMS = 384
RUN_DATE = "2026-07-01"

HERE = Path(__file__).resolve().parent
CORPUS_PATH = HERE / "corpus-b-39.json"
OUT_PATH = HERE / "mem0-writepath-results.json"


def die(msg: str) -> None:
    print(f"STOP: {msg}", file=sys.stderr)
    sys.exit(1)


def check_env() -> str:
    """Verify we have a usable LLM route before spending anything. Returns
    the routing mode string used in the results doc ('openrouter' or
    'openai_direct'); exits with STOP + dry-run guidance if neither key
    is present."""
    if os.environ.get("OPENROUTER_API_KEY"):
        return "openrouter"
    if os.environ.get("OPENAI_API_KEY"):
        return "openai_direct"
    die(
        "Neither OPENROUTER_API_KEY nor OPENAI_API_KEY is set in the environment.\n"
        "This harness requires one of them to drive mem0's LLM write path "
        "(mem0's OpenAILLM auto-routes through OpenRouter when OPENROUTER_API_KEY "
        "is present; otherwise it falls back to api.openai.com with OPENAI_API_KEY).\n"
        "Per the task's stop condition: no results were fabricated. To dry-run the "
        "harness mechanics without spend, run with MEM0_WRITEPATH_MOCK=1, which "
        "exercises the same ingest/inspect loop over the first 2 items using a "
        "canned mock LLM response instead of a real API call."
    )


def load_corpus() -> dict:
    if not CORPUS_PATH.exists():
        die(
            f"{CORPUS_PATH} not found. Run "
            f"`node scripts/consolidator-writepath/extract-corpus-b.mjs` first "
            f"(requires integrations/consensus-bench to be built: `npm run build` "
            f"in that workspace, or use the committed dist/ output)."
        )
    return json.loads(CORPUS_PATH.read_text())


def build_memory(collection_name: str, mock: bool):
    """Fresh Memory instance per item: fresh in-process qdrant collection AND
    a fresh user_id (belt and suspenders against cross-item contamination via
    mem0's within-session extraction context).

    mock=True does NOT use a mem0 "mock" provider (mem0 has no such provider —
    see mem0/utils/factory.py's provider_to_class). Instead it builds the real
    OpenAILLM object (so config plumbing is exercised identically) and
    monkeypatches generate_response() on that instance to return a canned,
    clearly-labeled extraction so the ingest/inspect loop can be verified
    end-to-end with zero API spend."""
    from mem0 import Memory

    config = {
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "path": ":memory:",
                "collection_name": collection_name,
                "embedding_model_dims": EMBEDDING_DIMS,
            },
        },
        "llm": {
            "provider": "openai",
            "config": {"model": MODEL, "temperature": TEMPERATURE},
        },
        "embedder": {
            "provider": "fastembed",
            "config": {"model": EMBEDDER_MODEL, "embedding_dims": EMBEDDING_DIMS},
        },
    }
    mem = Memory.from_config(config_dict=config)

    if mock:
        def fake_generate_response(messages, response_format=None, tools=None, tool_choice="auto", **kwargs):
            # Mirror mem0's additive-extraction JSON contract closely enough that
            # the real parsing path in mem0/memory/main.py runs unmodified.
            # Extracts the literal message content mem0 sent us as "new_messages"
            # is not attempted here — this is a fixed canned fact, deliberately
            # labeled MOCK so it can never be mistaken for a real model output.
            user_msg = messages[-1]["content"] if messages else ""
            fact = "[MOCK-LLM extraction, no real API call made]"
            return json.dumps({"memory": [{"text": fact, "event": "ADD"}]})

        mem.llm.generate_response = fake_generate_response  # type: ignore[method-assign]

    return mem


def get_all_for(mem, user_id: str) -> list[dict]:
    res = mem.get_all(filters={"user_id": user_id})
    return res.get("results", res if isinstance(res, list) else [])


def history_for(mem, memory_id: str) -> list[dict]:
    try:
        h = mem.history(memory_id)
        return h if isinstance(h, list) else []
    except Exception as e:  # noqa: BLE001 — record, don't crash the run
        return [{"error": str(e)}]


def norm(s: str) -> str:
    return " ".join(s.split()).strip().lower()


def classify_survivor(text: str, stale: str, governing: str) -> str:
    t = norm(text)
    s_in_t = norm(stale) in t or t in norm(stale)
    g_in_t = norm(governing) in t or t in norm(governing)
    if g_in_t and not s_in_t:
        return "governing"
    if s_in_t and not g_in_t:
        return "stale"
    if s_in_t and g_in_t:
        return "both"
    return "other"  # e.g. mem0 paraphrased/summarized rather than storing verbatim


def run_trap(item: dict, mock: bool) -> dict:
    item_id = item["id"]
    collection = f"m0-{item_id}"
    user_id = f"user-{item_id}"
    mem = build_memory(collection, mock)

    t0 = time.time()
    add_stale = mem.add(item["staleText"], user_id=user_id)
    add_governing = mem.add(item["governingText"], user_id=user_id)
    elapsed = time.time() - t0

    survivors = get_all_for(mem, user_id)
    survivor_rows = []
    for s in survivors:
        cls = classify_survivor(s.get("memory", ""), item["staleText"], item["governingText"])
        hist = history_for(mem, s["id"])
        survivor_rows.append(
            {
                "id": s["id"],
                "memory": s.get("memory", ""),
                "classification": cls,
                "history_events": [h.get("event") for h in hist if isinstance(h, dict)],
                "history_raw": hist,
            }
        )

    classes = {r["classification"] for r in survivor_rows}
    n = len(survivor_rows)
    if n == 0:
        outcome = "no_memories_survived"
    elif n == 1 and classes == {"governing"}:
        outcome = "one_value_kept_governing"
    elif n == 1 and classes == {"stale"}:
        outcome = "one_value_kept_stale"
    elif n == 1:
        outcome = "one_value_kept_other"
    elif "governing" in classes and "stale" in classes:
        outcome = "both_kept_separately"
    else:
        outcome = f"multiple_kept_{n}"

    return {
        "id": item_id,
        "kind": "trap",
        "governingNum": item["governingNum"],
        "revid": item["revid"],
        "add_stale_result": add_stale,
        "add_governing_result": add_governing,
        "survivors": survivor_rows,
        "n_survivors": n,
        "outcome": outcome,
        "elapsed_s": round(elapsed, 2),
    }


def run_tension(item: dict, mock: bool) -> dict:
    item_id = item["id"]
    collection = f"m0-{item_id}"
    user_id = f"user-{item_id}"
    mem = build_memory(collection, mock)

    t0 = time.time()
    add_a = mem.add(item["positionA"], user_id=user_id)
    add_b = mem.add(item["positionB"], user_id=user_id)
    elapsed = time.time() - t0

    survivors = get_all_for(mem, user_id)
    survivor_rows = []
    for s in survivors:
        cls = classify_survivor(s.get("memory", ""), item["positionA"], item["positionB"])
        hist = history_for(mem, s["id"])
        survivor_rows.append(
            {
                "id": s["id"],
                "memory": s.get("memory", ""),
                "classification": cls,  # "governing"-label reused as "positionB", "stale" as "positionA" via classify_survivor(text, positionA, positionB)
                "history_events": [h.get("event") for h in hist if isinstance(h, dict)],
                "history_raw": hist,
            }
        )

    classes = {r["classification"] for r in survivor_rows}
    n = len(survivor_rows)
    if n == 0:
        outcome = "no_memories_survived"
    elif "governing" in classes and "stale" in classes:
        outcome = "both_kept_separately"  # preserve-not-resolve outcome (non-masquerade)
    elif n == 1:
        outcome = "one_overwrote_the_other"  # masquerade: tension collapsed to a single value
    else:
        outcome = f"multiple_kept_{n}_ambiguous"

    return {
        "id": item_id,
        "kind": "tension",
        "article": item["article"],
        "num": item["num"],
        "topic": item["topic"],
        "add_positionA_result": add_a,
        "add_positionB_result": add_b,
        "survivors": survivor_rows,
        "n_survivors": n,
        "outcome": outcome,
        "elapsed_s": round(elapsed, 2),
    }


def main() -> None:
    mock = os.environ.get("MEM0_WRITEPATH_MOCK") == "1"
    route = "mock" if mock else check_env()

    corpus = load_corpus()
    traps = corpus["traps"]
    tensions = corpus["tensions"]

    if mock:
        traps = traps[:1]
        tensions = tensions[:1]
        print("MOCK MODE: running the harness mechanics on 1 trap + 1 tension, no real LLM spend.")

    print(f"Route: {route}  Model: {MODEL if not mock else 'mock'}  Items: {len(traps)} traps + {len(tensions)} tensions")

    trap_results = []
    for i, item in enumerate(traps, 1):
        print(f"[{i}/{len(traps)}] trap {item['id']} (governingNum {item['governingNum']})...", flush=True)
        try:
            trap_results.append(run_trap(item, mock))
        except Exception as e:  # noqa: BLE001 — record the error, keep going
            print(f"  ERROR: {e}", file=sys.stderr)
            trap_results.append({"id": item["id"], "kind": "trap", "error": str(e)})

    tension_results = []
    for i, item in enumerate(tensions, 1):
        print(f"[{i}/{len(tensions)}] tension {item['id']} ({item['article']} #{item['num']})...", flush=True)
        try:
            tension_results.append(run_tension(item, mock))
        except Exception as e:  # noqa: BLE001
            print(f"  ERROR: {e}", file=sys.stderr)
            tension_results.append({"id": item["id"], "kind": "tension", "error": str(e)})

    out = {
        "meta": {
            "date": RUN_DATE,
            "model": MODEL,
            "temperature": TEMPERATURE,
            "route": route,
            "embedder": EMBEDDER_MODEL,
            "vector_store": "qdrant (path=':memory:')",
            "mock": mock,
            "run_started_at_utc": datetime.now(timezone.utc).isoformat(),
            "mem0ai_version": _mem0_version(),
        },
        "traps": trap_results,
        "tensions": tension_results,
    }

    out_path = HERE / ("mem0-writepath-results.mock.json" if mock else "mem0-writepath-results.json")
    out_path.write_text(json.dumps(out, indent=2, default=str))
    print(f"\nWrote {out_path}")

    # quick console summary
    trap_outcomes = [r.get("outcome", f"ERROR:{r.get('error')}") for r in trap_results]
    tension_outcomes = [r.get("outcome", f"ERROR:{r.get('error')}") for r in tension_results]
    print("\nTrap outcomes:", json.dumps(_count(trap_outcomes), indent=2))
    print("Tension outcomes:", json.dumps(_count(tension_outcomes), indent=2))


def _count(xs: list[str]) -> dict[str, int]:
    d: dict[str, int] = {}
    for x in xs:
        d[x] = d.get(x, 0) + 1
    return d


def _mem0_version() -> str:
    try:
        import importlib.metadata as im

        return im.version("mem0ai")
    except Exception:
        return "unknown"


if __name__ == "__main__":
    main()
