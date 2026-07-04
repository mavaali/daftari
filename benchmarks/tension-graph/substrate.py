"""Per-cell substrate adapters: what information each cell can put in front of
the agent for a query. This is where the structural difference between the cells
lives (spec §4).

Four cell configs:

  data-olympus   their real Index.search over the corpus. Returns ranked docs.
                 Cannot expose a contradiction — status is only {active,
                 accepted, superseded}; two active feud docs come back ranked by
                 FTS with no signal that they conflict.
  daftari-no-tg  daftari retrieval + supersede-chain, tension-graph WITHDRAWN.
                 Same structural ceiling as data-olympus on feuds.
  daftari-tg-3a  tension-graph reachable via a dedicated tool the agent MAY call
                 (check_contradictions). Not surfaced in the ranked payload.
  daftari-tg-3b  tension-graph surfaced INLINE: the retrieval payload carries a
                 [CONTESTED: a vs b] marker (adapter post-joins the tension log).

FIDELITY NOTE. For the offline scaffold the daftari cells reuse the data-olympus
Index for ranking and take tension records from the feud manifest (the tensions
that WOULD be pre-logged via vault_tension_log). This is information-faithful for
the feud axis — it models exactly what the agent can see — but the published run
should swap ranking to the live daftari MCP (vault_search) and tension lookup to
vault_tension_blast. Marked as a §7 follow-on; it does not change the contract or
the metrics.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from benchmarks.feud_corpus import FeudRecord

DATA_OLYMPUS = "data-olympus"
DAFTARI_NO_TG = "daftari-no-tg"
DAFTARI_TG_3A = "daftari-tg-3a"
DAFTARI_TG_3B = "daftari-tg-3b"

ALL_CELLS = (DATA_OLYMPUS, DAFTARI_NO_TG, DAFTARI_TG_3A, DAFTARI_TG_3B)
TENSION_CELLS = (DAFTARI_TG_3A, DAFTARI_TG_3B)


@dataclass(frozen=True)
class RetrievedDoc:
    id: str
    title: str
    snippet: str


@dataclass(frozen=True)
class Context:
    """What the agent is handed for one query in one cell."""

    query: str
    docs: list[RetrievedDoc]
    inline_contested: str | None = None      # 3b only: a rendered [CONTESTED] line
    tension_tool_available: bool = False     # 3a only
    # Records the tool would return if the agent calls it (3a). Never shown unless
    # the agent chooses to look — that is what 3a measures.
    _tension_records: list[dict] = field(default_factory=list)

    def call_check_contradictions(self) -> list[dict]:
        """The dedicated tool the 3a agent may invoke. Empty for cells whose
        substrate cannot represent a contradiction."""
        return list(self._tension_records) if self.tension_tool_available else []


def _rank(idx: object, query: str, *, k: int = 6) -> list[RetrievedDoc]:
    """Rank via the data-olympus Index (shared retrieval floor for all cells in
    the offline scaffold)."""
    out: list[RetrievedDoc] = []
    for r in idx.search(query)[:k]:  # type: ignore[attr-defined]
        doc_id = getattr(r, "id", getattr(r, "concept_id", None))
        title = getattr(r, "title", "") or ""
        body = getattr(r, "content_markdown", getattr(r, "body", "")) or ""
        out.append(RetrievedDoc(id=str(doc_id), title=title, snippet=body[:240]))
    return out


def _feud_for_query(feuds: list[FeudRecord], gold_ids: set[str]) -> FeudRecord | None:
    for f in feuds:
        if {f.doc_a_id, f.doc_b_id} & gold_ids:
            return f
    return None


def build_context(
    *,
    cell: str,
    query: str,
    gold_ids: list[str],
    idx: object,
    feuds: list[FeudRecord],
    k: int = 6,
) -> Context:
    """Construct the query context for one cell. gold_ids identify the feud so
    the tension-aware cells can attach the (pre-logged) tension record."""
    docs = _rank(idx, query, k=k)
    feud = _feud_for_query(feuds, set(gold_ids))

    if cell in (DATA_OLYMPUS, DAFTARI_NO_TG) or feud is None:
        # No tension representation reaches the agent.
        return Context(query=query, docs=docs)

    record = {
        "doc_a": feud.doc_a_id,
        "claim_a": feud.claim_a,
        "doc_b": feud.doc_b_id,
        "claim_b": feud.claim_b,
        "status": "unresolved",
    }

    if cell == DAFTARI_TG_3A:
        return Context(
            query=query,
            docs=docs,
            tension_tool_available=True,
            _tension_records=[record],
        )

    if cell == DAFTARI_TG_3B:
        marker = (
            f"[CONTESTED: {feud.doc_a_id} says \"{feud.claim_a}\" "
            f"vs {feud.doc_b_id} says \"{feud.claim_b}\" — unresolved tension]"
        )
        return Context(query=query, docs=docs, inline_contested=marker)

    return Context(query=query, docs=docs)
