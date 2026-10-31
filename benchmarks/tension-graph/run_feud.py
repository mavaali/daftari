"""Feud-stratum runner. Wires corpus -> index -> per-cell agent -> classifier ->
feud rates -> report.

Offline by default (MockLLM, zero cost) so the whole pipeline is provable without
spending anything or hitting the network. ``--live`` swaps in OpenRouterLLM for
the published run (billed).

    uv run python -m benchmarks.run_feud            # offline mock
    uv run python -m benchmarks.run_feud --live --model openai/gpt-4o-mini

The mock report is clearly labelled MOCK and is NOT a result to cite — it exists
to demonstrate the harness and the 3a<3b delta mechanism.
"""
from __future__ import annotations

import argparse
import tempfile
from dataclasses import dataclass
from pathlib import Path

from benchmarks.agent import MockLLM, run_agent
from benchmarks.feud_corpus import (
    generate_feud_corpus,
    generate_feud_corpus_divergent,
)
from benchmarks.feud_metrics import classify_feud, feud_rates, surface_rate_delta
from benchmarks.feud_queries import (
    build_feud_queries,
    build_feud_queries_divergent,
)
from benchmarks.governance_corpus import generate_governance_corpus
from benchmarks.substrate import (
    ALL_CELLS,
    DAFTARI_TG_3A,
    DAFTARI_TG_3B,
    build_context,
)


@dataclass
class CellResult:
    cell: str
    labels: list[str]


def run_feud_benchmark(*, llm_factory, regime: str = "shared", gov_n: int = 15) -> dict:
    """Run every cell over the feud stratum. ``llm_factory`` is called per cell to
    get an LLM (so cell-specific mock policies like diligent_3a can differ).

    regime='shared'    : both sides co-retrieve (measures nothing once the model
                         is capable — see the 2026-07-04 result).
    regime='divergent' : side B authored in divergent vocab over the full 250-
                         concept base corpus, so retrieval buries it; the tension
                         link is the only path to it. This is the validity test.
    """
    td = Path(tempfile.mkdtemp())
    bundle = td / "kb"
    if regime == "divergent":
        from benchmarks.corpus_gen import generate_corpus  # noqa: PLC0415
        generate_corpus(bundle, n=250, seed=0)  # distractor bed (their turf)
        manifest = generate_feud_corpus_divergent(bundle)
        # NEUTRAL label query (same one that got 10/10 in shared): A retrieves via
        # its label-matching triggers, B is buried. Isolates retrieval; no A-bias.
        queries = build_feud_queries(manifest)
    else:
        generate_governance_corpus(bundle, n=gov_n, seed=0)
        manifest = generate_feud_corpus(bundle)
        queries = build_feud_queries(manifest)

    from data_olympus.index import Index  # type: ignore[attr-defined]

    idx = Index(td / "idx.db")
    idx.build(bundle, source_commit="feud-run")

    results: list[CellResult] = []
    for cell in ALL_CELLS:
        llm = llm_factory(cell)
        labels: list[str] = []
        for q in queries:
            ctx = build_context(
                cell=cell,
                query=q.text,
                idx=idx,
                feuds=manifest.feuds,
            )
            ans = run_agent(llm, ctx)
            labels.append(classify_feud(ans, gold_a=q.doc_a_id, gold_b=q.doc_b_id))
        results.append(CellResult(cell=cell, labels=labels))

    rates = {r.cell: feud_rates(r.labels) for r in results}
    delta = surface_rate_delta(rates[DAFTARI_TG_3A], rates[DAFTARI_TG_3B])
    return {"n": len(queries), "rates": rates, "delta_3b_minus_3a": delta}


def format_report(report: dict, *, mock: bool) -> str:
    lines = ["# Feud-stratum report"]
    if mock:
        lines += ["", "**MOCK RUN — deterministic stand-in, NOT a citable result.**"]
    lines += [
        "",
        f"Queries per cell: {report['n']}",
        "",
        "| Cell | Surface | Pick | Fabricate | Miss | N |",
        "|---|---|---|---|---|---|",
    ]
    for cell, r in report["rates"].items():
        lines.append(
            f"| {cell} | {r.surface_rate:.3f} | {r.pick_rate:.3f} | "
            f"{r.fabrication_rate:.3f} | {r.miss_rate:.3f} | {r.n} |"
        )
    lines += [
        "",
        f"**3b − 3a surface-rate delta (value of surfacing tensions in search): "
        f"{report['delta_3b_minus_3a']:+.3f}**",
    ]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the feud-stratum benchmark")
    parser.add_argument("--live", action="store_true", help="use OpenRouter (billed)")
    parser.add_argument("--model", default="openai/gpt-4o-mini")
    parser.add_argument("--regime", default="shared", choices=["shared", "divergent"])
    parser.add_argument("--diligent-3a", action="store_true",
                        help="mock: make the 3a agent call the tension tool")
    args = parser.parse_args()

    if args.live:
        from benchmarks.agent import OpenRouterLLM
        llm = OpenRouterLLM(args.model)

        def factory(_cell: str):
            return llm
    else:
        def factory(cell: str):
            return MockLLM(diligent_3a=args.diligent_3a and cell == DAFTARI_TG_3A)

    report = run_feud_benchmark(llm_factory=factory, regime=args.regime)
    print(f"[regime={args.regime}]")
    print(format_report(report, mock=not args.live))


if __name__ == "__main__":
    main()
