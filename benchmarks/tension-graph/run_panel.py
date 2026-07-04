"""Publication-grade panel runner (Phase 1: information-faithful stand-in).

Divergent regime, neutral query, over the 250-concept base bed. Runs a panel of
neutral models x repetitions, streams every trial to JSONL (so a long run
survives interruption), and writes a summary with 95% CIs and a two-proportion
test on the buried-topic surfacing contrast (no-tg vs tension-graph).

    uv run python -m benchmarks.run_panel --reps 3 --temperature 0.7 \
        --models openai/gpt-5.4-mini google/gemini-2.5-flash openai/gpt-5-mini \
        --out benchmarks/tg_panel

Unit of analysis: one (model, cell, topic, rep) trial. Buried/co-retrieved is a
per-topic retrieval property (does side B fall out of top-k), computed once.
"""
from __future__ import annotations

import argparse
import json
import math
import tempfile
from pathlib import Path

from benchmarks.agent import OpenRouterLLM, run_agent
from benchmarks.corpus_gen import generate_corpus
from benchmarks.feud_corpus import generate_feud_corpus_divergent
from benchmarks.feud_metrics import SURFACE, classify_feud
from benchmarks.feud_queries import build_feud_queries
from benchmarks.substrate import ALL_CELLS, build_context

K = 6


def _buried_map(idx, queries):
    out = {}
    for q in queries:
        topk = [getattr(r, "id", None) for r in idx.search(q.text)][:K]
        out[q.topic] = q.doc_b_id not in topk
    return out


def run_panel(*, models, reps, temperature, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    jsonl = out_dir / "trials.jsonl"

    td = Path(tempfile.mkdtemp())
    bundle = td / "kb"
    generate_corpus(bundle, n=250, seed=0)
    manifest = generate_feud_corpus_divergent(bundle)
    queries = build_feud_queries(manifest)

    from data_olympus.index import Index  # type: ignore[attr-defined]

    idx = Index(td / "idx.db")
    idx.build(bundle, source_commit="panel")
    buried = _buried_map(idx, queries)

    with jsonl.open("w", encoding="utf-8") as fh:
        for model in models:
            llm = OpenRouterLLM(model, temperature=temperature)
            for q in queries:
                for cell in ALL_CELLS:
                    for rep in range(reps):
                        try:
                            ctx = build_context(cell=cell, query=q.text, idx=idx,
                                                feuds=manifest.feuds)
                            ans = run_agent(llm, ctx)
                            label = classify_feud(ans, gold_a=q.doc_a_id, gold_b=q.doc_b_id)
                        except Exception as e:  # noqa: BLE001 - keep the run alive
                            label = "error"
                            ans = None
                        rec = {
                            "model": model, "cell": cell, "topic": q.topic,
                            "rep": rep, "buried": buried[q.topic], "label": label,
                        }
                        fh.write(json.dumps(rec) + "\n")
                        fh.flush()
    _summarize(jsonl, out_dir / "summary.md", models=models, reps=reps,
               temperature=temperature, n_topics=len(queries),
               n_buried=sum(buried.values()))
    return out_dir


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

def _ci95(s: int, n: int) -> tuple[float, float]:
    if n == 0:
        return (0.0, 0.0)
    p = s / n
    se = math.sqrt(p * (1 - p) / n)
    return (max(0.0, p - 1.96 * se), min(1.0, p + 1.96 * se))


def _two_prop_z(s1: int, n1: int, s2: int, n2: int) -> tuple[float, float]:
    if n1 == 0 or n2 == 0:
        return (0.0, 1.0)
    p1, p2 = s1 / n1, s2 / n2
    p = (s1 + s2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    if se == 0:
        return (0.0, 1.0)
    z = (p1 - p2) / se
    pval = 2 * (1 - 0.5 * (1 + math.erf(abs(z) / math.sqrt(2))))
    return (z, pval)


def _load(jsonl: Path) -> list[dict]:
    return [json.loads(line) for line in jsonl.read_text().splitlines() if line.strip()]


def _summarize(jsonl: Path, out_md: Path, *, models, reps, temperature,
               n_topics, n_buried) -> None:
    rows = _load(jsonl)
    lines = [
        "# Feud panel — publication-grade (Phase 1: stand-in substrate)",
        "",
        f"Models: {', '.join(models)}  ",
        f"Reps: {reps}  Temperature: {temperature}  ",
        f"Topics: {n_topics} ({n_buried} buried, {n_topics - n_buried} co-retrieved)  ",
        "Regime: divergent, neutral query, 250-concept base bed  ",
        "Substrate: information-faithful stand-in (NOT live daftari MCP)  ",
        "",
    ]

    def rate(subset, cell, label=SURFACE):
        rs = [r for r in subset if r["cell"] == cell]
        n = len(rs)
        s = sum(1 for r in rs if r["label"] == label)
        return s, n

    # Per-cell surfacing, pooled across models+reps, split by regime.
    for scope, pred in (("ALL", lambda r: True),
                        ("BURIED", lambda r: r["buried"]),
                        ("CO-RETRIEVED", lambda r: not r["buried"])):
        sub = [r for r in rows if pred(r)]
        lines += [f"## Surfacing rate — {scope} topics", "",
                  "| Cell | surface | 95% CI | fabricate | miss | trials |",
                  "|---|---|---|---|---|---|"]
        for cell in ALL_CELLS:
            s, n = rate(sub, cell)
            fab, _ = rate(sub, cell, "fabricate")
            miss, _ = rate(sub, cell, "miss")
            lo, hi = _ci95(s, n)
            sr = s / n if n else 0.0
            lines.append(f"| {cell} | {sr:.3f} | [{lo:.3f}, {hi:.3f}] | "
                         f"{fab/n if n else 0:.3f} | {miss/n if n else 0:.3f} | {n} |")
        lines.append("")

    # Two-proportion test on BURIED surfacing: no-tg vs each tension-graph cell.
    buried_rows = [r for r in rows if r["buried"]]
    s_no, n_no = rate(buried_rows, "daftari-no-tg")
    lines += ["## Two-proportion test — surfacing on BURIED topics", "",
              f"Baseline daftari-no-tg: {s_no}/{n_no} = {(s_no/n_no if n_no else 0):.3f}", ""]
    for cell in ("daftari-tg-3a", "daftari-tg-3b"):
        s_c, n_c = rate(buried_rows, cell)
        z, pval = _two_prop_z(s_c, n_c, s_no, n_no)
        lines.append(f"- **{cell}**: {s_c}/{n_c} = {(s_c/n_c if n_c else 0):.3f}  "
                     f"vs no-tg  z={z:.2f}  p={pval:.2e}")
    lines.append("")

    # Per-model buried-surfacing (robustness across families).
    lines += ["## Per-model buried-topic surfacing (robustness)", "",
              "| Model | no-tg | tg-3a | tg-3b |", "|---|---|---|---|"]
    for m in models:
        mr = [r for r in buried_rows if r["model"] == m]
        def cell_rate(c):
            s, n = rate(mr, c)
            return f"{(s/n if n else 0):.3f}"
        lines.append(f"| {m} | {cell_rate('daftari-no-tg')} | "
                     f"{cell_rate('daftari-tg-3a')} | {cell_rate('daftari-tg-3b')} |")
    lines.append("")
    out_md.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--temperature", type=float, default=0.7)
    ap.add_argument("--models", nargs="+",
                    default=["openai/gpt-5.4-mini", "google/gemini-2.5-flash", "openai/gpt-5-mini"])
    ap.add_argument("--out", default="benchmarks/tg_panel")
    args = ap.parse_args()
    out = run_panel(models=args.models, reps=args.reps, temperature=args.temperature,
                    out_dir=Path(args.out))
    print((out / "summary.md").read_text())


if __name__ == "__main__":
    main()
