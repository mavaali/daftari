"""Feud query stratum: the fifth stratum added to data-olympus's four.

data-olympus's governance queries have four strata (trigger_covered,
paraphrase_uncovered, supersession, negative — benchmarks/governance_queries.py).
This adds ``feud``.

A feud query is phrased *as if a single answer exists* — deliberately, to test
whether the system invents one:

    "What is the current governing rule for <label>?"

Gold = BOTH doc ids. Surfacing the contradiction requires retrieving both; the
downstream answer classification {surface, pick, fabricate} (see the spec §3/§5)
is computed on the agent's answer, not derivable from the ranked list alone. Gold
here supports the recall sanity check (did retrieval even return both sides).

The query text is built ONLY from the topic label + shared triggers — never from
a side's position vocab — so retrieval cannot lexically favor a side. Enforced by
an integrity assert and mirrored in test_feud_disjoint.py.

Runs INSIDE a vendored data-olympus checkout. yaml round-trip mirrors
governance_queries.write/load so feud queries can join the same queries.yaml.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path

    from benchmarks.feud_corpus import FeudCorpusManifest


@dataclass(frozen=True)
class FeudQuery:
    """A single feud scenario query with ground-truth metadata."""

    text: str
    stratum: str          # always "feud"
    gold_ids: list[str]   # [doc_a_id, doc_b_id] — both sides are gold
    topic: str
    doc_a_id: str
    doc_b_id: str


# Function words carry no side signal; excluded from the fairness check so a
# shared "for"/"the"/"to" between the query and a multi-word vocab phrase (e.g.
# "select for update") is not mistaken for a position-vocab leak.
_STOPWORDS: frozenset[str] = frozenset({
    "a", "an", "and", "as", "at", "by", "for", "in", "into", "is", "of", "on",
    "or", "over", "the", "to", "with",
})


def _content_words(phrase: str) -> set[str]:
    return {w for w in phrase.lower().split() if w not in _STOPWORDS}


def _feud_query_text(label: str) -> str:
    """Phrased to presuppose a single governing rule (the trap)."""
    return f"What is the current governing rule for {label}?"


def build_feud_queries(manifest: FeudCorpusManifest) -> list[FeudQuery]:
    """Build one feud query per feud topic from a FeudCorpusManifest.

    Integrity (per-topic): asserts the query text for a topic contains no content
    word from THAT topic's own side-A or side-B position vocab, so the query
    cannot lexically favor a side of the feud it queries. Cross-topic word sharing
    (a query term that appears in a *different* topic's vocab) is allowed — it acts
    as an ordinary retrieval distractor and cannot bias the two sides of this feud.
    """
    from benchmarks.feud_corpus import _FEUD_TOPICS  # noqa: PLC0415

    queries: list[FeudQuery] = []
    for f in manifest.feuds:
        text = _feud_query_text(f.label)
        spec = _FEUD_TOPICS[f.topic]
        own_vocab: set[str] = set()
        for term in [*spec.side_a.vocab, *spec.side_b.vocab]:
            own_vocab |= _content_words(term)
        overlap = _content_words(text) & own_vocab
        assert not overlap, (
            f"feud query for {f.topic} leaks its own position vocab {overlap}: {text!r}"
        )
        queries.append(FeudQuery(
            text=text,
            stratum="feud",
            gold_ids=[f.doc_a_id, f.doc_b_id],
            topic=f.topic,
            doc_a_id=f.doc_a_id,
            doc_b_id=f.doc_b_id,
        ))
    return queries


def build_feud_queries_divergent(manifest: FeudCorpusManifest) -> list[FeudQuery]:
    """Divergent-regime queries: phrased in side A's (query-aligned) vocabulary so
    ordinary retrieval finds A and buries the divergent side B. gold = both sides;
    surfacing B requires the id-based tension link, not lexical retrieval."""
    from benchmarks.feud_corpus import _FEUD_TOPICS  # noqa: PLC0415

    queries: list[FeudQuery] = []
    for f in manifest.feuds:
        a = _FEUD_TOPICS[f.topic].side_a
        t0, t1 = a.vocab[0], a.vocab[1]
        text = (
            f"Our team is standardizing on {t0} and {t1}. "
            f"What is the governing rule we should follow?"
        )
        queries.append(FeudQuery(
            text=text,
            stratum="feud",
            gold_ids=[f.doc_a_id, f.doc_b_id],
            topic=f.topic,
            doc_a_id=f.doc_a_id,
            doc_b_id=f.doc_b_id,
        ))
    return queries


# ---------------------------------------------------------------------------
# yaml round-trip (same shape as governance_queries.write/load_governance_queries)
# ---------------------------------------------------------------------------

def write_feud_queries(queries: list[FeudQuery], dest: Path) -> None:
    import yaml  # type: ignore[import-untyped]

    records = [
        {
            "text": q.text,
            "stratum": q.stratum,
            "gold_ids": q.gold_ids,
            "topic": q.topic,
            "doc_a_id": q.doc_a_id,
            "doc_b_id": q.doc_b_id,
        }
        for q in queries
    ]
    dest.write_text(
        yaml.safe_dump(records, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )


def load_feud_queries(src: Path) -> list[FeudQuery]:
    import yaml  # type: ignore[import-untyped]

    records = yaml.safe_load(src.read_text(encoding="utf-8")) or []
    return [
        FeudQuery(
            text=r["text"],
            stratum=r["stratum"],
            gold_ids=r["gold_ids"],
            topic=r["topic"],
            doc_a_id=r["doc_a_id"],
            doc_b_id=r["doc_b_id"],
        )
        for r in records
    ]
