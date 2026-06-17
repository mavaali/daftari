import json, collections
edges = json.load(open("claimset.json"))
DROP = {"nv-pf-001","nv-pf-002","nv-pf-015",
        "nv-pd-001","nv-pd-009","nv-pd-013","nv-pd-014","nv-pd-017","nv-pd-018","nv-pd-019",
        "nv-pd-011","nv-pd-008","nv-pd-016"}  # private: inverse-problem(10)+career(1)+ATP-private/lesswrong(2)
dropped = [e for e in edges if e["edge_id"] in DROP]
kept = [e for e in edges if e["edge_id"] not in DROP]
for e in kept:
    if e["control"]:
        e["contamination"] = "n/a-control"
    elif e["domain"] == "novel":
        # Daftari repo created 2026-05-17, ATP-public first commit 2026-03-04 -> both post Jan-2026 cutoff
        e["contamination"] = "clean-postcutoff"
    else:
        e["contamination"] = "contaminated-by-design"  # public/factual = the contrast arm
json.dump(kept, open("claimset.json","w"), indent=2)
json.dump(dropped, open("claimset_dropped_private.json","w"), indent=2)
cells = collections.Counter()
for e in kept:
    cells[f"control:{e['control']}" if e["control"] else f"{e['domain']}/{e['intended_prior']}"] += 1
print(f"dropped (private): {len(dropped)}  |  kept: {len(kept)}")
for k in sorted(cells): print(f"  {k}: {cells[k]}")
print("novel contamination:", collections.Counter(e['contamination'] for e in kept if e['domain']=='novel'))
