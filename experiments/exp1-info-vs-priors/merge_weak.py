import json
edges = json.load(open("claimset.json"))
weak = {}
for f in ["draft_weak_public_favors.json","draft_weak_public_disfavors_ctl.json","draft_weak_novel.json"]:
    for w in json.load(open(f)):
        weak[w["edge_id"]] = w
missing=[]; applied=0
for e in edges:
    if e.get("control")=="negative":
        e["to_premise_weak_quant"]=None; e["to_premise_weak_hedge"]=None  # already non-entailing; not tested
        continue
    w=weak.get(e["edge_id"])
    if not w or not w.get("to_premise_weak_quant") or not w.get("to_premise_weak_hedge"):
        missing.append(e["edge_id"]); continue
    e["to_premise_weak_quant"]=w["to_premise_weak_quant"]
    e["to_premise_weak_hedge"]=w["to_premise_weak_hedge"]
    applied+=1
json.dump(edges, open("claimset.json","w"), indent=2)
need=[e["edge_id"] for e in edges if e.get("control")!="negative"]
print(f"weakenings applied: {applied} / need {len(need)} (non-negative-control edges)")
print("MISSING:", missing if missing else "none")
