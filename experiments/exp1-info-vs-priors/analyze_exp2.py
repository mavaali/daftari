#!/usr/bin/env python3
"""Exp #2 analysis (premise-strength x prior) -> RATIFY decision.

Reuses Exp #1's C1/C2 records + the new W1/W2. Measures: prior-reassertion index,
weak-premise FN rate (the decision number), strength:prior interaction, W1/W2
type-robustness. Applies the frozen §7 thresholds.

  uv run --with 'pandas,statsmodels,numpy' python analyze_exp2.py
"""
import json
from pathlib import Path
from collections import defaultdict, Counter
import numpy as np

ROOT = Path(__file__).parent

def load():
    edges = {e["edge_id"]: e for e in json.load(open(ROOT/"claimset.json"))}
    recs = [json.loads(l) for l in open(ROOT/"raw"/"results.jsonl")] if (ROOT/"raw"/"results.jsonl").exists() else []
    recs = [r for r in recs if not r.get("refusal")]
    # weakening rejections: per edge|variant
    rejW = set()
    wv = ROOT/"raw"/"weakval.jsonl"
    if wv.exists():
        for l in wv.read_text().splitlines():
            try:
                r=json.loads(l)
                if r.get("weak_ok") is False: rejW.add((r["edge_id"], r["variant"]))
            except Exception: pass
    return edges, recs, rejW

def freeze_priors(recs):
    g=defaultdict(list)
    for r in recs:
        if r["condition"]=="C2": g[r["edge_id"]].append(r)
    out={}
    for eid,rs in g.items():
        s=[r["score"] for r in rs if r["score"] is not None]
        if s:
            m=float(np.mean(s)); out[eid]=("favors" if m>60 else "disfavors" if m<40 else "DISCARD", m)
    return out

def main():
    edges, recs, rejW = load()
    if not recs: print("no results"); return
    conds=set(r["condition"] for r in recs)
    print(f"records: {len(recs)} | conditions: {sorted(conds)} | rejected weakenings: {len(rejW)}")
    priors=freeze_priors(recs)

    def cmean(eid, cond, fam=None):
        rs=[r["score"] for r in recs if r["edge_id"]==eid and r["condition"]==cond
            and (fam is None or r["family"]==fam) and r["score"] is not None]
        return float(np.mean(rs)) if rs else None

    def wmean(eid, fam=None):
        """mean over valid (non-rejected) weakened variants W1,W2"""
        vals=[]
        for var,cond in [("W1","W1"),("W2","W2")]:
            if (eid,var) in rejW: continue
            v=cmean(eid,cond,fam)
            if v is not None: vals.append(v)
        return float(np.mean(vals)) if vals else None

    if not {"W1","W2"} & conds:
        print("\n(W1/W2 not collected yet — run `harness.py --phase weak`. Showing prior freeze only.)")
        cells=Counter((edges[e]["domain"],lab) for e,(lab,m) in priors.items() if not edges[e]["control"])
        for k in sorted(cells): print(f"  {k}: {cells[k]}")
        return

    # ---- reassertion index per edge: (C1 - W)/(C1 - C2) ----
    print("\n=== Reassertion index (0=premise still carries it, 1=prior reasserted) ===")
    def reassert(eid):
        c1,c2,w=cmean(eid,"C1"),cmean(eid,"C2"),wmean(eid)
        if None in (c1,c2,w) or abs(c1-c2)<1e-6: return None
        return (c1-w)/(c1-c2)
    by_prior=defaultdict(list)
    for eid,(lab,m) in priors.items():
        if edges[eid]["control"] or lab=="DISCARD": continue
        ri=reassert(eid)
        if ri is not None: by_prior[lab].append(ri)
    for lab in ("favors","disfavors"):
        v=by_prior[lab]
        if v: print(f"  {lab:9}: mean reassertion={np.mean(v):.2f}  n={len(v)}")
    if by_prior["favors"] and by_prior["disfavors"]:
        print(f"  bias signal: disfavored reasserts more? {np.mean(by_prior['disfavors'])>np.mean(by_prior['favors'])}")

    # ---- weak-premise FN (decision number): prior-disfavored & derivable (C1>=50) failing under W ----
    dis_deriv=[eid for eid,(lab,m) in priors.items()
               if lab=="disfavors" and not edges[eid]["control"] and (cmean(eid,"C1") or 0)>=50]
    fn=[1 if (wmean(eid) or 0)<50 else 0 for eid in dis_deriv if wmean(eid) is not None]
    fn_rate=float(np.mean(fn)) if fn else float("nan")
    print(f"\n=== Weak-premise FN (decision number) ===")
    print(f"  prior-disfavored & derivable edges failing under weakened premise: {fn_rate:.1%}  n={len(fn)}")
    print(f"  (full-premise FN was 0% in Exp #1; thresholds: MANDATORY>=30%, OPTIONAL<15%)")

    # ---- type robustness: W1 vs W2 ----
    pairs=[(cmean(eid,"W1"),cmean(eid,"W2")) for eid in edges
           if cmean(eid,"W1") is not None and cmean(eid,"W2") is not None
           and (eid,"W1") not in rejW and (eid,"W2") not in rejW]
    if len(pairs)>3:
        a=np.array([p[0] for p in pairs]); b=np.array([p[1] for p in pairs])
        corr=float(np.corrcoef(a,b)[0,1])
        concord=float(np.mean([(x>=50)==(y>=50) for x,y in pairs]))
        print(f"\n=== Type-robustness (W1 vs W2) ===")
        print(f"  per-edge corr={corr:.2f}  verdict-concordance={concord:.1%}  (low => weakening-style artifact)")

    # ---- per-family weak-FN ----
    print("\n=== Per-family weak-premise FN (disfavored & derivable) ===")
    for fam in ["claude","gpt","qwen"]:
        ff=[1 if (wmean(eid,fam) or 0)<50 else 0 for eid in dis_deriv if wmean(eid,fam) is not None]
        print(f"  {fam:7}: {np.mean(ff):.1%}  n={len(ff)}")

    # ---- interaction: mixed-effects ----
    sig_interaction=None
    try:
        import pandas as pd, statsmodels.formula.api as smf
        strength={"C2":0,"W1":1,"W2":1,"C1":2}
        rows=[]
        for r in recs:
            if r["condition"] not in strength or r["score"] is None: continue
            eid=r["edge_id"]; e=edges[eid]
            if e["control"] or eid not in priors or priors[eid][0]=="DISCARD": continue
            if r["condition"] in ("W1","W2") and (eid, r["condition"]) in rejW: continue
            rows.append(dict(score=r["score"], strength=strength[r["condition"]],
                             prior=1 if priors[eid][0]=="favors" else 0,
                             domain=1 if e["domain"]=="novel" else 0, edge=eid, model=r["family"]))
        df=pd.DataFrame(rows)
        if len(df)>50:
            md=smf.mixedlm("score ~ strength * prior + domain", df, groups=df["edge"], re_formula="~1")
            mf=md.fit(method="lbfgs", maxiter=300, disp=False)
            b=mf.params.get("strength:prior"); p=mf.pvalues.get("strength:prior")
            sig_interaction=(p is not None and p<0.05)
            print(f"\n=== Interaction (mixed-effects) ===")
            print(f"  beta(strength:prior)={b:.2f}  p={p:.3g}  significant? {sig_interaction}")
            print("  (positive strength:prior => premise matters MORE for favored => prior reasserts for disfavored = bias)")
    except Exception as ex:
        print(f"  (mixed-effects skipped: {ex})")

    # ---- frozen §7 verdict ----
    print("\n=== §7 PRE-REGISTERED DECISION ===")
    mand = (fn_rate>=0.30) and bool(sig_interaction)
    opt  = (fn_rate<0.15) and (sig_interaction is False)
    verdict = "RATIFY-MANDATORY" if mand else "RATIFY-OPTIONAL" if opt else "INCONCLUSIVE"
    print(f"  weak-FN={fn_rate:.1%}  interaction-significant={sig_interaction}  =>  {verdict}")

if __name__=="__main__":
    main()
