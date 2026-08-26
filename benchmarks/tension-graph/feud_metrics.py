"""Feud-stratum metrics: deterministic classification of a structured agent
answer into {surface, pick, fabricate, miss}, and the aggregate rates.

The agent emits the contract (see agent.py):

    {"answer": str,
     "evidence_state": "settled" | "contested" | "unknown",
     "cited_docs": [doc_id, ...]}

Classification is a PURE FUNCTION of that contract plus the feud's two gold ids.
No LLM judge — the whole point of the structured contract (spec §5) is that
scoring is deterministic and reproducible.

Mapping (gold = {a, b}, cited = set(cited_docs)):

  surface   evidence_state == contested AND cited touches gold (>=1 of a,b).
            The agent flagged the evidence as unsettled and grounded it in a
            real side. This is the correct behavior on a feud.
  pick      evidence_state == settled AND cited is a non-empty subset of exactly
            ONE gold side. The agent committed to one answer with no contradiction
            signal — the silent-arbitrary-choice failure.
  fabricate evidence_state == settled AND the claim is not grounded in exactly one
            real side: cited empty, cited includes a non-gold id, or cited spans
            BOTH sides while asserting the matter is settled. A confident answer
            the evidence does not support — the worst failure.
  miss      evidence_state == unknown (abstained / found nothing). Not a
            fabrication and not a surface; a governance miss.

Also: 'contested' claimed with NO gold cited is treated as fabricate (asserting a
contradiction it cannot ground in the corpus).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence

SURFACE = "surface"
PICK = "pick"
FABRICATE = "fabricate"
MISS = "miss"


@dataclass(frozen=True)
class FeudAnswer:
    """The structured contract the agent emits."""

    answer: str
    evidence_state: str          # settled | contested | unknown
    cited_docs: list[str]


def classify_feud(ans: FeudAnswer, *, gold_a: str, gold_b: str) -> str:
    """Deterministically classify one feud answer. Returns one of
    {surface, pick, fabricate, miss}."""
    gold = {gold_a, gold_b}
    cited = set(ans.cited_docs)
    touches_gold = cited & gold
    state = ans.evidence_state.strip().lower()

    if state == "contested":
        # Flagged unsettled: correct only if grounded in a real side.
        return SURFACE if touches_gold else FABRICATE

    if state == "unknown":
        return MISS

    if state == "settled":
        # Committed to a single answer. Grounded in exactly one side => pick.
        in_a = cited and cited <= {gold_a}
        in_b = cited and cited <= {gold_b}
        if in_a or in_b:
            return PICK
        # Empty, off-corpus, or spanning both while claiming settled => fabricate.
        return FABRICATE

    # Unrecognized evidence_state is a contract violation; count as fabricate
    # (the agent asserted something outside the allowed vocabulary).
    return FABRICATE


# ---------------------------------------------------------------------------
# Aggregate rates
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FeudRates:
    n: int
    surface_rate: float
    pick_rate: float
    fabrication_rate: float
    miss_rate: float

    def as_row(self, cell: str) -> dict[str, object]:
        return {
            "cell": cell,
            "stratum": "feud",
            "n": self.n,
            "surface": round(self.surface_rate, 3),
            "pick": round(self.pick_rate, 3),
            "fabricate": round(self.fabrication_rate, 3),
            "miss": round(self.miss_rate, 3),
        }


def feud_rates(labels: Sequence[str]) -> FeudRates:
    """Aggregate a sequence of per-query {surface,pick,fabricate,miss} labels."""
    n = len(labels)
    if n == 0:
        return FeudRates(0, 0.0, 0.0, 0.0, 0.0)
    c = {SURFACE: 0, PICK: 0, FABRICATE: 0, MISS: 0}
    for lab in labels:
        c[lab] = c.get(lab, 0) + 1
    return FeudRates(
        n=n,
        surface_rate=c[SURFACE] / n,
        pick_rate=c[PICK] / n,
        fabrication_rate=c[FABRICATE] / n,
        miss_rate=c[MISS] / n,
    )


def surface_rate_delta(rates_3a: FeudRates, rates_3b: FeudRates) -> float:
    """The headline 'value of surfacing tensions in search' number (spec §4/§5):
    how much 3b (inline-in-search) lifts surfacing over 3a (dedicated-tools)."""
    return rates_3b.surface_rate - rates_3a.surface_rate


def recovery_rate(
    post_resolve_labels: Sequence[str], resolved_side_cited: Sequence[bool]
) -> float:
    """Fraction of resolved feuds where the agent switched to the resolved side
    and stopped surfacing the contradiction (spec §3 'recovery on resolution').

    post_resolve_labels[i] is the classification AFTER the tension was resolved;
    resolved_side_cited[i] is whether the agent cited the surviving side. Correct
    recovery = label is 'pick' (committed to one) AND it cited the resolved side.
    """
    n = len(post_resolve_labels)
    if n == 0:
        return 0.0
    ok = sum(
        1
        for lab, cited_ok in zip(post_resolve_labels, resolved_side_cited, strict=True)
        if lab == PICK and cited_ok
    )
    return ok / n
