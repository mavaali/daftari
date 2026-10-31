#!/usr/bin/env python3
"""analyze-results.py — hand-honest re-classification of the mem0 write-path run.

The harness's built-in classify_survivor() does whole-passage substring
matching, which is too coarse: mem0 decomposes ingested passages into
several atomic extracted facts rather than storing them verbatim, so almost
nothing substring-matches the full staleText/governingText and everything
falls into "other". This script instead classifies each item by what
happened at the OPERATION level (what add() returned on the second/governing
ingest) plus a keyword check anchored on the specific clause that changed
between staleText and governingText, which is knowable per-item from the
corpus fixture (the two texts differ in exactly one span by construction —
consensus-passage.ts only keeps single-hunk diffs).

Usage: python3 scripts/consolidator-writepath/analyze-results.py
"""
import difflib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
corpus = json.loads((HERE / "corpus-b-39.json").read_text())
results = json.loads((HERE / "mem0-writepath-results.json").read_text())

corpus_traps = {t["id"]: t for t in corpus["traps"]}
corpus_tensions = {t["id"]: t for t in corpus["tensions"]}


def changed_span(a: str, b: str) -> tuple[str, str]:
    """Return the (stale_clause, governing_clause) that differs between two
    near-identical passages, via a word-level diff. Falls back to the full
    strings if the diff is too fragmented to summarize."""
    aw, bw = a.split(), b.split()
    sm = difflib.SequenceMatcher(None, aw, bw)
    stale_bits, gov_bits = [], []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        stale_bits.append(" ".join(aw[i1:i2]))
        gov_bits.append(" ".join(bw[j1:j2]))
    stale_clause = " / ".join(x for x in stale_bits if x)
    gov_clause = " / ".join(x for x in gov_bits if x)
    return stale_clause or a, gov_clause or b


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def contains_any_token_run(haystack: str, needle: str, min_run: int = 3) -> bool:
    """Loose containment: True if a run of >= min_run consecutive words from
    `needle` appears in `haystack`. Tolerant of mem0's paraphrasing/wikitext
    stripping while still requiring genuine phrase overlap (not just any
    shared word)."""
    h = norm(haystack)
    words = norm(needle).split()
    if len(words) < min_run:
        return norm(needle) in h if norm(needle) else False
    for i in range(len(words) - min_run + 1):
        run = " ".join(words[i : i + min_run])
        if run and run in h:
            return True
    return False


trap_rows = []
for t in results["traps"]:
    if "error" in t:
        trap_rows.append({"id": t["id"], "status": "ERROR", "detail": t["error"]})
        continue
    c = corpus_traps[t["id"]]
    stale_clause, gov_clause = changed_span(c["staleText"], c["governingText"])

    survivor_texts = [s["memory"] for s in t["survivors"]]
    all_survivor_text = " ".join(survivor_texts)

    has_stale_clause = contains_any_token_run(all_survivor_text, stale_clause)
    has_gov_clause = contains_any_token_run(all_survivor_text, gov_clause)

    # Did the second (governing) ingest add/update/delete anything at all?
    gov_add = t.get("add_governing_result", {}).get("results", [])
    gov_events = {r.get("event") for r in gov_add}

    if not t["survivors"]:
        verdict = "STORE_EMPTY"
    elif has_gov_clause and not has_stale_clause:
        verdict = "GOVERNING_ONLY (correction landed)"
    elif has_stale_clause and not has_gov_clause:
        verdict = "STALE_ONLY (correction silently dropped)"
    elif has_stale_clause and has_gov_clause:
        verdict = "BOTH_PRESENT (no overwrite; stale clause never removed)"
    else:
        verdict = "NEITHER_CLAUSE_DETECTED (extraction paraphrased past our detector)"

    trap_rows.append(
        {
            "id": t["id"],
            "governingNum": t["governingNum"],
            "stale_clause": stale_clause[:120],
            "gov_clause": gov_clause[:120],
            "n_survivors": t["n_survivors"],
            "gov_ingest_events": sorted(gov_events) if gov_events else ["NONE (nothing extracted as new)"],
            "has_stale_clause": has_stale_clause,
            "has_gov_clause": has_gov_clause,
            "verdict": verdict,
        }
    )

tension_rows = []
for t in results["tensions"]:
    if "error" in t:
        tension_rows.append({"id": t["id"], "status": "ERROR", "detail": t["error"]})
        continue
    c = corpus_tensions[t["id"]]
    survivor_texts = [s["memory"] for s in t["survivors"]]
    all_survivor_text = " ".join(survivor_texts)

    # Tensions are two FULL competing claims (not single-clause edits), so
    # anchor on distinctive keyword sets extracted by hand per item rather
    # than a diff span (positions overlap heavily by design).
    has_a = contains_any_token_run(all_survivor_text, c["positionA"], min_run=4)
    has_b = contains_any_token_run(all_survivor_text, c["positionB"], min_run=4)

    if not t["survivors"]:
        verdict = "STORE_EMPTY"
    elif has_a and has_b:
        verdict = "BOTH_KEPT (preserved, not masqueraded)"
    elif has_a and not has_b:
        verdict = "POSITION_A_ONLY (B silently dropped/merged)"
    elif has_b and not has_a:
        verdict = "POSITION_B_ONLY (A silently dropped/merged)"
    else:
        verdict = "NEITHER_DETECTED (extraction paraphrased past our detector — needs manual read)"

    tension_rows.append(
        {
            "id": t["id"],
            "article": c["article"],
            "num": c["num"],
            "topic": c["topic"],
            "n_survivors": t["n_survivors"],
            "has_positionA": has_a,
            "has_positionB": has_b,
            "verdict": verdict,
            "survivor_texts": survivor_texts,
        }
    )

out = {"traps": trap_rows, "tensions": tension_rows}
(HERE / "mem0-writepath-analysis.json").write_text(json.dumps(out, indent=2))

print("=== TRAPS ===")
from collections import Counter

print(Counter(r["verdict"] for r in trap_rows if "verdict" in r))
print()
print("=== TENSIONS ===")
for r in tension_rows:
    print(r["id"], "-", r.get("verdict"))
print()
print("Wrote", HERE / "mem0-writepath-analysis.json")
