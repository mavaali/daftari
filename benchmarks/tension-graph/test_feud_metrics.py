"""Unit tests for the deterministic feud classifier + an offline end-to-end run.

Runs INSIDE a vendored data-olympus checkout (files copied into benchmarks/).
"""
from __future__ import annotations

from benchmarks.agent import MockLLM, parse_contract
from benchmarks.feud_metrics import (
    FABRICATE,
    MISS,
    PICK,
    SURFACE,
    FeudAnswer,
    classify_feud,
    feud_rates,
    recovery_rate,
)
from benchmarks.run_feud import run_feud_benchmark
from benchmarks.substrate import (
    DAFTARI_NO_TG,
    DAFTARI_TG_3A,
    DAFTARI_TG_3B,
    DATA_OLYMPUS,
)

A, B = "FEUD_X_A", "FEUD_X_B"


def _ans(state, cited):
    return FeudAnswer(answer="", evidence_state=state, cited_docs=cited)


# --- classifier truth table ------------------------------------------------

def test_contested_with_both_sides_is_surface():
    assert classify_feud(_ans("contested", [A, B]), gold_a=A, gold_b=B) == SURFACE


def test_contested_with_one_side_is_surface():
    assert classify_feud(_ans("contested", [A]), gold_a=A, gold_b=B) == SURFACE


def test_contested_with_no_gold_is_fabricate():
    # Claims a contradiction it cannot ground in the corpus.
    assert classify_feud(_ans("contested", ["OTHER"]), gold_a=A, gold_b=B) == FABRICATE


def test_settled_one_side_is_pick():
    assert classify_feud(_ans("settled", [A]), gold_a=A, gold_b=B) == PICK
    assert classify_feud(_ans("settled", [B]), gold_a=A, gold_b=B) == PICK


def test_settled_spanning_both_is_fabricate():
    # Asserting the matter is settled while citing both contradicting docs.
    assert classify_feud(_ans("settled", [A, B]), gold_a=A, gold_b=B) == FABRICATE


def test_settled_offcorpus_is_fabricate():
    assert classify_feud(_ans("settled", ["OTHER"]), gold_a=A, gold_b=B) == FABRICATE
    assert classify_feud(_ans("settled", []), gold_a=A, gold_b=B) == FABRICATE


def test_unknown_is_miss():
    assert classify_feud(_ans("unknown", []), gold_a=A, gold_b=B) == MISS


def test_garbage_state_is_fabricate():
    assert classify_feud(_ans("whatever", [A]), gold_a=A, gold_b=B) == FABRICATE


# --- rates + recovery ------------------------------------------------------

def test_feud_rates_partition():
    r = feud_rates([SURFACE, SURFACE, PICK, FABRICATE])
    assert r.n == 4
    assert r.surface_rate == 0.5
    assert r.pick_rate == 0.25
    assert r.fabrication_rate == 0.25
    assert abs(r.surface_rate + r.pick_rate + r.fabrication_rate + r.miss_rate - 1.0) < 1e-9


def test_recovery_rate():
    # 2 of 3 correctly switched to the resolved side.
    assert recovery_rate([PICK, PICK, SURFACE], [True, True, False]) == 2 / 3
    assert recovery_rate([PICK], [False]) == 0.0  # picked wrong side


# --- contract parsing ------------------------------------------------------

def test_parse_contract_plain_and_fenced():
    a = parse_contract('{"answer":"x","evidence_state":"contested","cited_docs":["A","B"]}')
    assert a.evidence_state == "contested" and a.cited_docs == ["A", "B"]
    b = parse_contract('```json\n{"answer":"y","evidence_state":"settled","cited_docs":["A"]}\n```')
    assert b.evidence_state == "settled" and b.cited_docs == ["A"]


def test_parse_contract_garbage_is_unknown():
    a = parse_contract("I cannot answer that.")
    assert a.evidence_state == "unknown" and a.cited_docs == []


# --- offline end-to-end ----------------------------------------------------

def test_offline_endtoend_delta_visible():
    """The whole pipeline runs on the mock, and the mechanism holds:
    no-tension cells never surface; 3b surfaces; lazy 3a matches no-tg; and a
    diligent 3a closes the gap. This proves the harness, not a real result."""
    def lazy_factory(cell):
        return MockLLM(diligent_3a=False)

    report = run_feud_benchmark(llm_factory=lazy_factory)
    rates = report["rates"]

    # Structural ceiling: cells with no tension representation never surface.
    assert rates[DATA_OLYMPUS].surface_rate == 0.0
    assert rates[DAFTARI_NO_TG].surface_rate == 0.0
    # 3b (inline) surfaces every feud.
    assert rates[DAFTARI_TG_3B].surface_rate == 1.0
    # Lazy 3a behaves like no-tg (agent never consults the tool).
    assert rates[DAFTARI_TG_3A].surface_rate == 0.0
    # The headline delta is positive and equals the full 3b surfacing.
    assert report["delta_3b_minus_3a"] == 1.0

    # A diligent 3a (calls the tool) closes the gap -> surfaces.
    def diligent_factory(cell):
        return MockLLM(diligent_3a=(cell == DAFTARI_TG_3A))

    report2 = run_feud_benchmark(llm_factory=diligent_factory)
    assert report2["rates"][DAFTARI_TG_3A].surface_rate == 1.0
