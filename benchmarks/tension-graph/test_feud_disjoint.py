"""Honesty guardrails for the feud augmentation, as executable asserts.

Mirrors data-olympus's own covered/uncovered disjointness test. If any of these
fail, the feud corpus could be accused of gaming — a query lexically favoring a
side, or a feud topic that overlaps the supersede-chain corpus.

Runs INSIDE a vendored data-olympus checkout (files copied into benchmarks/).
"""
from __future__ import annotations

import tempfile
from pathlib import Path

from benchmarks.feud_corpus import (
    _FEUD_TOPICS,
    _iter_vocab_conflicts,
    generate_feud_corpus,
)
from benchmarks.feud_queries import build_feud_queries, load_feud_queries, write_feud_queries


def test_feud_topics_disjoint_from_governance_and_distractors() -> None:
    from benchmarks.governance_corpus import _DISTRACTOR_TOPICS, _GOV_TOPICS

    feud = set(_FEUD_TOPICS)
    assert feud.isdisjoint(set(_GOV_TOPICS)), feud & set(_GOV_TOPICS)
    assert feud.isdisjoint(set(_DISTRACTOR_TOPICS)), feud & set(_DISTRACTOR_TOPICS)


def test_position_vocab_disjoint_and_query_neutral() -> None:
    # No within-topic vocab overlap (side-A vs side-B, and neither vs shared).
    assert _iter_vocab_conflicts() == []


def test_both_sides_active_no_supersession_link() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        manifest = generate_feud_corpus(root)
        assert len(manifest.feuds) == len(_FEUD_TOPICS)
        assert len(manifest.concepts) == 2 * len(_FEUD_TOPICS)
        for c in manifest.concepts:
            assert c.status == "active"
            text = (root / c.path).read_text(encoding="utf-8")
            assert "superseded_by" not in text
            assert "supersedes" not in text


def test_feud_query_gold_is_both_sides() -> None:
    with tempfile.TemporaryDirectory() as td:
        manifest = generate_feud_corpus(Path(td))
    queries = build_feud_queries(manifest)
    assert len(queries) == len(_FEUD_TOPICS)
    for q in queries:
        assert q.stratum == "feud"
        assert set(q.gold_ids) == {q.doc_a_id, q.doc_b_id}
        assert len(q.gold_ids) == 2


def test_feud_query_yaml_roundtrip() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        manifest = generate_feud_corpus(root)
        queries = build_feud_queries(manifest)
        dest = root / "feud_queries.yaml"
        write_feud_queries(queries, dest)
        reloaded = load_feud_queries(dest)
    assert reloaded == queries
