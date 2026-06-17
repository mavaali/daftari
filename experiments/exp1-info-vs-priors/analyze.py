#!/usr/bin/env python3
"""Exp #1 analysis (protocol §6) -> §7 verdict.

Stage 1 (C2 only): freeze prior-congruence labels (favors>60, disfavors<40, discard 40-60).
Stage 2 (C1/C3 present): IS, flip-rate, mixed-effects decomposition, axis-prior tell,
conventionality-bias FN, controls check -> apply frozen §7 decision rules.

  uv run --with 'pandas,statsmodels,numpy' python analyze.py
"""
import json, sys
from pathlib import Path
from collections import defaultdict
import numpy as np

ROOT = Path(__file__).parent
RAW = ROOT / "raw" / "results.jsonl"

def load():
    edges = {e["edge_id"]: e for e in json.load(open(ROOT / "claimset.json"))}
    recs = [json.loads(l) for l in open(RAW)] if RAW.exists() else []
    recs = [r for r in recs if not r.get("refusal")]  # drop refusals/errors
    return edges, recs

def by(recs, *keys):
    d = defaultdict(list)
    for r in recs:
        d[tuple(r[k] for k in keys)].append(r)
    return d

def freeze_priors(edges, recs):
    """Per-edge mean C2 across models+repeats -> prior label. Returns {edge_id: (mean, label)}."""
    g = defaultdict(list)
    for r in recs:
        if r["condition"] == "C2":
            g[r["edge_id"]].append(r)
    out = {}
    for eid, rs in g.items():
        scores = [r["score"] for r in rs if r["score"] is not None]
        if not scores:
            continue
        m = float(np.mean(scores))
        label = "favors" if m > 60 else ("disfavors" if m < 40 else "DISCARD")
        out[eid] = (m, label, len(scores))
    return out

def agreement(recs, condition):
    """Mean pairwise inter-model agreement on the binary verdict for a condition.
    Per edge: fraction of model-pairs that agree on majority survives/fails."""
    rs = [r for r in recs if r["condition"] == condition and r["survives"] is not None]
    per_edge_model = defaultdict(lambda: defaultdict(list))
    for r in rs:
        per_edge_model[r["edge_id"]][r["family"]].append(1 if r["survives"] else 0)
    agrees = []
    for eid, fam in per_edge_model.items():
        verdict = {f: (1 if np.mean(v) >= 0.5 else 0) for f, v in fam.items() if v}
        fams = list(verdict)
        if len(fams) < 2:
            continue
        pairs = [(verdict[a] == verdict[b]) for i, a in enumerate(fams) for b in fams[i+1:]]
        agrees.append(np.mean(pairs))
    return float(np.mean(agrees)) if agrees else None

def main():
    edges, recs = load()
    if not recs:
        print("No results yet. Run the harness first."); return
    conds = set(r["condition"] for r in recs)
    print(f"records (non-refusal): {len(recs)} | conditions present: {sorted(conds)}")
    refusal_rate = None
    allrecs = [json.loads(l) for l in open(RAW)]
    refusal_rate = np.mean([1 if r.get("refusal") else 0 for r in allrecs])
    print(f"overall refusal/err rate: {refusal_rate:.3%}\n")

    # ---- Stage 1: prior-label freeze ----
    priors = freeze_priors(edges, recs)
    if priors:
        from collections import Counter
        # attach + report by intended vs confirmed
        confirmed = {eid: lab for eid,(m,lab,n) in priors.items()}
        print("=== Stage 1: C2 prior-label freeze ===")
        # accuracy of intended_prior hypothesis (non-control)
        cells = defaultdict(Counter)
        for eid, e in edges.items():
            if e["control"] or eid not in priors:
                continue
            m, lab, n = priors[eid]
            cells[(e["domain"], e["intended_prior"])][lab] += 1
        for (dom, intended), c in sorted(cells.items()):
            print(f"  {dom}/{intended:9} intended -> confirmed: {dict(c)}")
        disc = sum(1 for _,(m,l,n) in priors.items() if l=="DISCARD")
        print(f"  total DISCARD (40-60 ambiguous): {disc}")
        # write frozen labels back
        for eid,(m,lab,n) in priors.items():
            if eid in edges:
                edges[eid]["prior_confirmed"] = lab
                edges[eid]["c2_mean"] = round(m,1)
        json.dump(list(edges.values()), open(ROOT/"claimset_frozen.json","w"), indent=2)
        print("  -> wrote claimset_frozen.json")

    # ---- Stage 2: needs C1 and C3 ----
    if not {"C1","C3"} <= conds:
        print("\n(C1/C3 not present yet — Stage 2 measures + §7 verdict pending those runs.)")
        return

    # flip-validation: exclude rejected flips from C3-dependent measures (§4)
    rejected = set()
    fv = ROOT / "raw" / "flipval.jsonl"
    if fv.exists():
        for l in fv.read_text().splitlines():
            try:
                r = json.loads(l)
                if r.get("flip_ok") is False: rejected.add(r["edge_id"])
            except Exception: pass
        print(f"\nflip-validation: {len(rejected)} flips rejected (excluded from IS/flip-rate/decomp)")
    else:
        print("\n(flip-validation not run — C3 measures include unvalidated flips)")

    print("\n=== Stage 2: information-vs-priors measures (§6) ===")
    # per (edge, condition) mean confidence across models+repeats
    def cond_mean(eid, cond, fam=None):
        rs = [r for r in recs if r["edge_id"]==eid and r["condition"]==cond
              and (fam is None or r["family"]==fam) and r["score"] is not None]
        return float(np.mean([r["score"] for r in rs])) if rs else None

    prior_favors = [eid for eid,(m,l,n) in priors.items()
                    if l=="favors" and not edges[eid]["control"] and eid not in rejected]
    # IS = mean(C1 - C3) over prior-favors edges
    diffs = [cond_mean(eid,"C1")-cond_mean(eid,"C3") for eid in prior_favors
             if cond_mean(eid,"C1") is not None and cond_mean(eid,"C3") is not None]
    IS = float(np.mean(diffs)) if diffs else float("nan")
    # flip rate: fraction crossing 50 threshold C1->C3 (C1 survives & C3 fails) over prior-favors
    flips = []
    for eid in prior_favors:
        c1,c3 = cond_mean(eid,"C1"), cond_mean(eid,"C3")
        if c1 is None or c3 is None: continue
        flips.append(1 if (c1>=50 and c3<50) else 0)
    flip_rate = float(np.mean(flips)) if flips else float("nan")
    print(f"  Information Sensitivity IS = mean(C1-C3) over prior-favors = {IS:.1f}  (PASS>=40, FAIL<20)")
    print(f"  Flip rate (C1>=50 & C3<50) = {flip_rate:.1%}  (PASS>=70%, FAIL<50%)  n={len(flips)}")

    # axis-prior tell: agreement C2 vs C1/C3
    aC2, aC1, aC3 = agreement(recs,"C2"), agreement(recs,"C1"), agreement(recs,"C3")
    print(f"  Inter-model agreement: C2={aC2}  C1={aC1}  C3={aC3}")
    if aC2 is not None and aC1 is not None and aC3 is not None:
        print(f"    axis-prior tell: agree-more-in-C2? {aC2 > max(aC1,aC3)} (TRUE => prior-driven, FAIL signal)")

    # conventionality-bias FN: C1 x prior-disfavors true-premise wrongly FAILS
    pd_novel = [eid for eid,(m,l,n) in priors.items()
                if l=="disfavors" and not edges[eid]["control"]]
    fn = []
    for eid in pd_novel:
        c1 = cond_mean(eid,"C1")
        if c1 is None: continue
        fn.append(1 if c1 < 50 else 0)  # true premise should support -> survive; failing = FN
    fn_rate = float(np.mean(fn)) if fn else float("nan")
    print(f"  Conventionality-bias FN rate (C1 prior-disfavors fails) = {fn_rate:.1%} (PARTIAL if >30%) n={len(fn)}")

    # controls
    pos = [e["edge_id"] for e in edges.values() if e.get("control")=="positive"]
    neg = [e["edge_id"] for e in edges.values() if e.get("control")=="negative"]
    pos_c1 = np.mean([1 if (cond_mean(e,"C1") or 0)>=50 else 0 for e in pos if cond_mean(e,"C1") is not None])
    pos_c3 = np.mean([1 if (cond_mean(e,"C3") or 0)<50 else 0 for e in pos if cond_mean(e,"C3") is not None])
    neg_c1 = np.mean([1 if (cond_mean(e,"C1") or 0)<50 else 0 for e in neg if cond_mean(e,"C1") is not None])
    print(f"  Positive controls: C1-YES={pos_c1:.0%} C3-NO={pos_c3:.0%} (both should be ~100%)")
    print(f"  Negative controls: C1-NO={neg_c1:.0%} (should be high)")

    # mixed-effects decomposition
    try:
        import pandas as pd, statsmodels.formula.api as smf
        rows=[]
        for r in recs:
            if r["condition"] not in ("C1","C3") or r["score"] is None: continue
            e=edges[r["edge_id"]]
            if e["control"] or r["edge_id"] not in priors: continue
            if priors[r["edge_id"]][1]=="DISCARD": continue
            if r["condition"]=="C3" and r["edge_id"] in rejected: continue
            rows.append(dict(score=r["score"], premise=1 if r["condition"]=="C1" else 0,
                             prior=1 if priors[r["edge_id"]][1]=="favors" else 0,
                             domain=1 if e["domain"]=="novel" else 0,
                             edge=r["edge_id"], model=r["family"]))
        df=pd.DataFrame(rows)
        if len(df)>30:
            md=smf.mixedlm("score ~ premise + prior + domain + premise:domain", df,
                           groups=df["edge"], re_formula="~1")
            mf=md.fit(method="lbfgs", maxiter=200, disp=False)
            bp=mf.params.get("premise"); bpr=mf.params.get("prior")
            print(f"\n  Mixed-effects: beta(premise)={bp:.1f}  beta(prior)={bpr:.1f}  "
                  f"=> premise>prior? {bp>bpr}")
            print(mf.summary().tables[1])
    except Exception as ex:
        print(f"  (mixed-effects skipped: {ex})")

    # ---- §7 verdict ----
    print("\n=== §7 PRE-REGISTERED VERDICT ===")
    print("  (apply manually with full data + per-family checks; auto-summary below)")
    pass_is = IS>=40; pass_flip = flip_rate>=0.70
    fail_is = IS<20; fail_flip = flip_rate<0.50
    print(f"  IS={IS:.1f} flip={flip_rate:.1%} | PASS-gate(IS>=40 & flip>=70%)={pass_is and pass_flip}"
          f" | FAIL-gate(IS<20 or flip<50%)={fail_is or fail_flip}")

if __name__ == "__main__":
    main()
