#!/usr/bin/env python
"""Populate the LangGraph BaseStore with adversarial fixtures and run LangMem's
own consolidation over them. See design.md for the experiment design.

Stages (run in order; each is idempotent-ish but designed for a fresh DB):

    python fixtures/populate.py distances     # embedding honesty check (no LLM)
    python fixtures/populate.py raw           # stateless per-trajectory extraction
    python fixtures/populate.py snapshot-raw  # -> fixtures/store-raw.sql
    python fixtures/populate.py v1            # realistic: per-session namespaces
    python fixtures/populate.py v2            # charitable: one shared namespace
    python fixtures/populate.py v3            # aggressive: global single-context pass
    python fixtures/populate.py dates         # shift created_at per session age
    python fixtures/populate.py snapshot-post # -> fixtures/store-post-langmem.sql
    python fixtures/populate.py verify        # plant assertions -> extraction-report.json

    python fixtures/populate.py all           # everything, in order
"""

import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from transcripts import (  # noqa: E402
    DISTANCE_PAIRS,
    PLANTS,
    SESSION_AGE_DAYS,
    SESSIONS,
    session_parts,
)

SUPER_DSN = "postgresql://postgres:postgres@localhost:5433/memories"
CONTAINER = "daftari-langgraph-demo-postgres-1"
LLM_MODEL = "openai/gpt-5.2"  # via OpenRouter
EMBED_MODEL = "text-embedding-3-small"
EMBED_DIMS = 1536

# LangMem's default instructions are user-profile-oriented ("what should the
# agent learn about the user") — under them the extractor stores meta-notes
# like "the AI supplied facts, treat as unverified" instead of the org facts
# themselves. `instructions` is LangMem's documented customization point; we
# redirect WHAT to extract to the org-memory use case while keeping their
# consolidation directives VERBATIM (final paragraph) so the behavior under
# test — their consolidation — is unchanged. Same instructions for every
# variant (raw/v1/v2/v3).
ORG_INSTRUCTIONS = """You maintain the shared long-term memory for Meridian \
Labs' agent fleet. Extract factual claims about the company, its product \
Relay, infrastructure, pricing, policies, and operations from the interaction \
— whether stated by the user or the assistant; both are trusted internal \
sources. Record each distinct fact as its own memory, phrased as a standalone \
declarative statement dense enough to be recalled without the conversation. \
Do not merge unrelated facts into one memory. Record the operational claims \
themselves (qualifying confidence is fine), not meta-advice about whether the \
conversation should be trusted.

Consolidate and compress redundant memories to maintain information-density; \
strengthen based on reliability and recency; maximize SNR by avoiding idle \
words. Remove incorrect or redundant memories while maintaining internal \
consistency."""


def load_env() -> None:
    import os

    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            k, _, v = line.partition("=")
            os.environ.setdefault(k, v)


def make_llm():
    import os

    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        model=LLM_MODEL,
        base_url="https://openrouter.ai/api/v1",
        api_key=os.environ["OPENROUTER_API_KEY"],
        timeout=180,
        max_retries=2,
    )


_STORE_CM = None  # keeps the connection's context manager alive for the process


def make_store():
    global _STORE_CM
    from langchain_openai import OpenAIEmbeddings
    from langgraph.store.postgres import PostgresStore

    _STORE_CM = PostgresStore.from_conn_string(
        SUPER_DSN,
        index={"dims": EMBED_DIMS, "embed": OpenAIEmbeddings(model=EMBED_MODEL)},
    )
    store = _STORE_CM.__enter__()
    store.setup()
    return store


def rows_in(store, namespace: tuple) -> list:
    return store.search(namespace, limit=1000)


def row_text(item) -> str:
    return json.dumps(item.value, ensure_ascii=False).lower()


# ---------------------------------------------------------------- distances
def stage_distances() -> None:
    import os

    from openai import OpenAI

    oc = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    texts = sorted({t for _, a, b, _ in DISTANCE_PAIRS for t in (a, b)})
    vecs = {}
    resp = oc.embeddings.create(model=EMBED_MODEL, input=texts)
    for t, d in zip(texts, resp.data):
        vecs[t] = d.embedding

    def cos(a, b):
        num = sum(x * y for x, y in zip(a, b))
        den = (sum(x * x for x in a) ** 0.5) * (sum(y * y for y in b) ** 0.5)
        return num / den

    out = []
    for label, a, b, kind in DISTANCE_PAIRS:
        out.append({"pair": label, "kind": kind, "cosine": round(cos(vecs[a], vecs[b]), 4)})
    (HERE / "distances.json").write_text(json.dumps(out, indent=2))

    nd = [r["cosine"] for r in out if r["kind"] == "near-dup"]
    other = [r["cosine"] for r in out if r["kind"] != "near-dup"]
    print(json.dumps(out, indent=2))
    print(f"\nnear-dup   min={min(nd):.4f}  (must be the HIGH group)")
    print(f"contradict max={max(other):.4f} (must sit clearly below near-dup min)")
    if max(other) >= min(nd):
        print("FAIL: a contradiction pair is as close as a near-dup pair — redesign fixtures")
        sys.exit(1)
    print("OK: contradiction pairs are embedding-distant from near-dup pairs")


# ---------------------------------------------------------------------- raw
def stage_raw(store) -> None:
    from langmem import create_memory_manager

    llm = make_llm()
    manager = create_memory_manager(llm, instructions=ORG_INSTRUCTIONS)
    total = 0
    for sid, part, msgs in session_parts():
        extracted = manager.invoke({"messages": msgs})
        for mem in extracted:
            content = mem.content
            value = {"kind": content.__class__.__name__, "content": content.model_dump()}
            store.put(("raw", sid), str(mem.id), value)
        print(f"raw[{sid}/{part}]: {len(extracted)} memories")
        total += len(extracted)
    print(f"raw total: {total}")


# ----------------------------------------------------------------------- v1
def stage_v1(store) -> None:
    from langmem import create_memory_store_manager

    llm = make_llm()
    manager = create_memory_store_manager(
        llm,
        namespace=("v1", "{langgraph_user_id}"),
        store=store,
        instructions=ORG_INSTRUCTIONS,
        enable_inserts=True,
        enable_deletes=True,
    )
    for sid, part, msgs in session_parts():
        manager.invoke(
            {"messages": msgs},
            config={"configurable": {"langgraph_user_id": sid}},
        )
        n = len(rows_in(store, ("v1", sid)))
        print(f"v1[{sid}/{part}]: namespace now {n} rows")


# ----------------------------------------------------------------------- v2
def stage_v2(store) -> None:
    from langmem import create_memory_store_manager

    llm = make_llm()
    manager = create_memory_store_manager(
        llm,
        namespace=("v2", "meridian"),
        store=store,
        instructions=ORG_INSTRUCTIONS,
        enable_inserts=True,
        enable_deletes=True,
    )
    provenance: dict[str, str] = {}
    for sid, part, msgs in session_parts():
        before = {it.key for it in rows_in(store, ("v2", "meridian"))}
        manager.invoke({"messages": msgs})
        after = {it.key for it in rows_in(store, ("v2", "meridian"))}
        for key in after - before:
            provenance[key] = sid
        print(f"v2[{sid}/{part}]: +{len(after - before)} rows, total {len(after)}")
    (HERE / "provenance-v2.json").write_text(json.dumps(provenance, indent=2))

    # Sidecar table: fixture-owned session attribution (LangMem's store keeps
    # none — that omission is itself a finding for the writeup).
    import psycopg

    with psycopg.connect(SUPER_DSN, autocommit=True) as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS fixture_provenance ("
            "prefix text, key text, session text, PRIMARY KEY (prefix, key))"
        )
        conn.execute("DELETE FROM fixture_provenance")
        for key, sid in provenance.items():
            conn.execute(
                "INSERT INTO fixture_provenance VALUES ('v2.meridian', %s, %s)",
                (key, sid),
            )
    print(f"provenance recorded for {len(provenance)} v2 rows")


# ----------------------------------------------------------------------- v3
def stage_v3(store) -> None:
    from langmem import create_memory_manager

    llm = make_llm()
    v2_rows = rows_in(store, ("v2", "meridian"))
    existing = [
        (it.key, it.value.get("kind", "Memory"), it.value.get("content", it.value))
        for it in v2_rows
    ]
    manager = create_memory_manager(llm, instructions=ORG_INSTRUCTIONS, enable_inserts=False, enable_deletes=True)
    result = manager.invoke(
        {
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "Review the existing memories as one corpus. Consolidate "
                        "redundant memories and remove incorrect or mutually "
                        "inconsistent ones, maintaining internal consistency."
                    ),
                }
            ],
            "existing": existing,
        }
    )
    for mem in result:
        content = mem.content
        if hasattr(content, "model_dump"):
            value = {"kind": content.__class__.__name__, "content": content.model_dump()}
        else:  # dict passthrough: langmem echoes `existing` entries as plain dicts
            value = {"kind": "Memory", "content": content}
        store.put(("v3", "meridian"), str(mem.id), value)
    print(f"v3: {len(v2_rows)} in -> {len(result)} out (global single-context pass)")


# --------------------------------------------------------------------- dates
def stage_dates() -> None:
    import psycopg

    prov = json.loads((HERE / "provenance-v2.json").read_text()) if (HERE / "provenance-v2.json").exists() else {}
    with psycopg.connect(SUPER_DSN, autocommit=True) as conn:
        for sid, age in SESSION_AGE_DAYS.items():
            for variant in ("raw", "v1"):
                conn.execute(
                    "UPDATE store SET created_at = now() - %s * interval '1 day', "
                    "updated_at = created_at WHERE prefix = %s",
                    (age, f"{variant}.{sid}"),
                )
        for key, sid in prov.items():
            conn.execute(
                "UPDATE store SET created_at = now() - %s * interval '1 day', "
                "updated_at = created_at WHERE prefix = 'v2.meridian' AND key = %s",
                (SESSION_AGE_DAYS[sid], key),
            )
    print("created_at shifted per session age (pricing-90d, ops-60d, support-30d, docs-7d)")


# ----------------------------------------------------------------- snapshots
def snapshot(name: str) -> None:
    out = subprocess.run(
        [
            "docker", "exec", CONTAINER,
            "pg_dump", "-U", "postgres", "-d", "memories",
            "--table=store", "--data-only", "--column-inserts",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    (HERE / name).write_text(out.stdout)
    inserts = out.stdout.count("INSERT INTO")
    print(f"{name}: {inserts} rows dumped")


# -------------------------------------------------------------------- verify
def stage_verify(store) -> None:
    report = {"plants": {}, "near_dup_merge": {}, "counts": {}}

    def match_rows(namespace, sig):
        rx = re.compile(sig, re.IGNORECASE | re.DOTALL)
        return [it for it in rows_in(store, namespace) if rx.search(row_text(it))]

    failures = []

    # 1. every plant landed in raw extraction (else transcripts need work)
    for pid, (cat, sig, sids) in PLANTS.items():
        hits = {sid: len(match_rows(("raw", sid), sig)) for sid in sids}
        landed = all(v >= 1 for v in hits.values())
        report["plants"][pid] = {"category": cat, "raw_hits": hits, "landed_raw": landed}
        if not landed:
            failures.append(f"plant {pid} missing from raw extraction: {hits}")

    # 2. near-dup control: merged in v1 iff sig matches exactly 1 row post-consolidation
    merged = 0
    for pid, (cat, sig, sids) in PLANTS.items():
        if cat != "near-dup":
            continue
        sid = sids[0]
        raw_n = len(match_rows(("raw", sid), sig))
        v1_n = len(match_rows(("v1", sid), sig))
        is_merged = raw_n >= 2 and v1_n == 1
        merged += is_merged
        report["near_dup_merge"][pid] = {"raw": raw_n, "v1": v1_n, "merged": is_merged}
    report["near_dup_merge"]["rate"] = f"{merged}/5"

    # 3. contradictions must SURVIVE v1 — the realistic variant and the
    #    Phase 2 import source. v2/v3 survival is REPORTED, not required:
    #    the first run showed v2 silently deletes one side of a conflict
    #    (recency wins, no flag) — that destruction rate is the indictment
    #    metric for RESULTS.md, not a fixture failure.
    destroyed_v2 = []
    for pid, (cat, sig, sids) in PLANTS.items():
        if cat == "near-dup":
            continue
        v1_hits = {sid: len(match_rows(("v1", sid), sig)) for sid in sids}
        v2_n = len(match_rows(("v2", "meridian"), sig))
        v3_n = len(match_rows(("v3", "meridian"), sig))
        report["plants"][pid]["v1_hits"] = v1_hits
        report["plants"][pid]["v2_hits"] = v2_n
        report["plants"][pid]["v3_hits"] = v3_n
        if not all(v >= 1 for v in v1_hits.values()):
            failures.append(f"plant {pid} did NOT survive v1 (import source) — redesign")
        if v2_n < 1:
            destroyed_v2.append(pid)
    report["v2_destroyed"] = destroyed_v2

    for variant, ns in [("raw", None), ("v1", None), ("v2", ("v2", "meridian")), ("v3", ("v3", "meridian"))]:
        if ns:
            report["counts"][variant] = len(rows_in(store, ns))
        else:
            report["counts"][variant] = sum(
                len(rows_in(store, (variant, sid))) for sid, _ in SESSIONS
            )

    (HERE / "extraction-report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    if failures:
        print("\nFAILURES:")
        for f in failures:
            print(" -", f)
        sys.exit(1)
    print(f"\nverify: all plants landed raw and survived v1 (import source); "
          f"v2 destroyed {len(destroyed_v2)} plant(s): {destroyed_v2 or 'none'}; "
          f"near-dup merge rate {merged}/5 (acceptance >=4)")
    if merged < 4:
        sys.exit(1)


STAGES = ["distances", "raw", "snapshot-raw", "v1", "v2", "v3", "dates", "snapshot-post", "verify"]


def main() -> None:
    load_env()
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    todo = STAGES if which == "all" else [which]
    store = None
    for stage in todo:
        print(f"\n=== stage: {stage} ===")
        if stage == "distances":
            stage_distances()
        elif stage == "dates":
            stage_dates()
        elif stage == "snapshot-raw":
            snapshot("store-raw.sql")
        elif stage == "snapshot-post":
            snapshot("store-post-langmem.sql")
        else:
            store = store or make_store()
            {"raw": stage_raw, "v1": stage_v1, "v2": stage_v2, "v3": stage_v3, "verify": stage_verify}[stage](store)


if __name__ == "__main__":
    main()
