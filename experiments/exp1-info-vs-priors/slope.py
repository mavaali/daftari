#!/usr/bin/env python3
"""Cliff-vs-graded probe (Exp #2.1 cheap version). Adds the Partial (P) level between
Full (C1) and Weakened (W) and asks: does re-derivation confidence degrade GRADUALLY
(P sits between C1 and W) or CLIFF (P already collapsed to ~W)?

partial-retention = (P - C2) / (C1 - C2)  per edge
  ~1  = partial premise retains the full-premise lift (graded; mild weakening is safe)
  ~0  = partial collapsed to the bare prior (cliff; any weakening over-contests)

  uv run --with numpy python slope.py
"""
import json
from pathlib import Path
from collections import defaultdict
import numpy as np

ROOT = Path(__file__).parent
recs = [json.loads(l) for l in open(ROOT/"raw"/"results.jsonl") if l.strip()]
recs = [r for r in recs if not r.get("refusal")]
edges = {e["edge_id"]: e for e in json.load(open(ROOT/"claimset.json"))}
rejW = set()  # (edge_id, variant) of weakenings that failed validation -> excluded
if (ROOT/"raw"/"weakval.jsonl").exists():
    for l in open(ROOT/"raw"/"weakval.jsonl"):
        r=json.loads(l)
        if r.get("weak_ok") is False: rejW.add((r["edge_id"], r["variant"]))

g=defaultdict(list)
for r in recs:
    if r["condition"]=="C2": g[r["edge_id"]].append(r["score"])
prior={e:("favors" if np.mean(s)>60 else "disfavors" if np.mean(s)<40 else "DISCARD")
       for e,s in g.items() if s}

def cm(eid, cond):
    s=[r["score"] for r in recs if r["edge_id"]==eid and r["condition"]==cond and r["score"] is not None]
    return float(np.mean(s)) if s else None
def wm(eid):
    v=[cm(eid,c) for c,var in [("W1","W1"),("W2","W2")] if (eid,var) not in rejW]
    v=[x for x in v if x is not None]
    return float(np.mean(v)) if v else None

if not any(r["condition"]=="P" for r in recs):
    print("Partial (P) not collected yet — run `harness.py --phase partial`."); raise SystemExit

print("=== 4-point strength slope (mean confidence) by prior class ===")
print(f"{'cell':10} {'C1 full':>8} {'P partial':>10} {'W weak':>8} {'C2 absent':>10} {'partial-retention':>18}")
verdicts={}
for lab in ("favors","disfavors"):
    es=[e for e in edges if prior.get(e)==lab and not edges[e]["control"] and (cm(e,"C1") or 0)>=50]
    C1=np.mean([cm(e,"C1") for e in es]); C2=np.mean([cm(e,"C2") for e in es])
    P=np.mean([cm(e,"P") for e in es if cm(e,"P") is not None])
    W=np.nanmean([wm(e) if wm(e) is not None else np.nan for e in es])
    ret=[ (cm(e,"P")-cm(e,"C2"))/(cm(e,"C1")-cm(e,"C2")) for e in es
          if None not in (cm(e,"P"),cm(e,"C2"),cm(e,"C1")) and abs(cm(e,"C1")-cm(e,"C2"))>5 ]
    retm=float(np.median(ret)) if ret else float("nan")
    verdicts[lab]=retm
    print(f"{lab:10} {C1:8.0f} {P:10.0f} {W:8.0f} {C2:10.0f} {retm:18.2f}   (n={len(es)}, retention n={len(ret)})")

print()
print("partial-retention: ~1 graded (mild weakening safe) | ~0 cliff (any weakening over-contests)")
for lab,r in verdicts.items():
    if r==r:  # not nan
        call = "GRADED" if r>0.6 else "CLIFF" if r<0.3 else "INTERMEDIATE"
        print(f"  {lab}: retention={r:.2f} -> {call}")
print()
print("Loop implication: CLIFF on the conventional (favors) cell => ordinary premise decay")
print("would mass-contest the core; the aging curve must be gentle. GRADED => safe to age.")
