"""Phase 2 export: emit the corpus spec for the Node/daftari harness.

Writes:
  <out>/base/*.md         the 250-concept distractor bed (OKF markdown; the Node
                          harness rewrites frontmatter to daftari's schema).
  <out>/feuds.json        feud specs so the Node harness can author daftari-native
                          feud docs whose RETRIEVAL SIGNAL LIVES IN THE BODY
                          (daftari indexes body+title, not frontmatter triggers).

Run inside the vendored data-olympus checkout:
  uv run python -m benchmarks.phase2_export --out /tmp/tg_phase2_src
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from benchmarks.corpus_gen import generate_corpus
from benchmarks.feud_corpus import _FEUD_TOPICS


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    out = Path(args.out)
    base = out / "base"
    base.mkdir(parents=True, exist_ok=True)

    # 250-concept distractor bed (same seed as Phase 1).
    manifest = generate_corpus(base, n=250, seed=0)

    feuds = []
    for topic, spec in _FEUD_TOPICS.items():
        a, b = spec.side_a, spec.side_b
        feuds.append({
            "topic": topic,
            "label": spec.label,
            "shared_triggers": list(spec.shared_triggers),
            "a_id": f"FEUDD_{topic}_{a.slug}".upper().replace("-", "_"),
            "b_id": f"FEUDD_{topic}_{b.slug}".upper().replace("-", "_"),
            "side_a": {"slug": a.slug, "vocab": list(a.vocab), "claim": a.claim},
            "side_b": {"slug": b.slug, "vocab": list(b.vocab), "claim": b.claim},
        })

    (out / "feuds.json").write_text(json.dumps({
        "base_doc_count": len(manifest.concepts),
        "feuds": feuds,
    }, indent=2), encoding="utf-8")
    print(f"wrote {len(manifest.concepts)} base docs to {base}")
    print(f"wrote {len(feuds)} feud specs to {out / 'feuds.json'}")


if __name__ == "__main__":
    main()
