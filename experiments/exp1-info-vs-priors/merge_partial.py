import json, os, sys
SRC=["draft_partial_public_ctl.json","draft_partial_novel.json"]
for f in SRC:
    if not os.path.exists(f): sys.exit(f"FATAL: missing source file {f}")
if not os.path.exists("claimset.bak.json"): sys.exit("FATAL: no backup present; aborting")
edges=json.load(open("claimset.json"))
part={}
for f in SRC:
    for p in json.load(open(f)):
        if not p.get("to_premise_partial"): sys.exit(f"FATAL: empty partial for {p.get('edge_id')}")
        part[p["edge_id"]]=p["to_premise_partial"]
need=[e["edge_id"] for e in edges if e.get("control")!="negative"]
missing=[eid for eid in need if eid not in part]
if missing: sys.exit(f"FATAL: {len(missing)} edges have no partial: {missing}")
orphans=[k for k in part if k not in {e['edge_id'] for e in edges}]
if orphans: sys.exit(f"FATAL: orphan edge_ids in drafts: {orphans}")
for e in edges:
    e["to_premise_partial"]= None if e.get("control")=="negative" else part[e["edge_id"]]
tmp="claimset.json.tmp"
json.dump(edges, open(tmp,"w"), indent=2)
os.replace(tmp,"claimset.json")
print(f"OK: partials applied to ALL {len(need)} non-negative-control edges (0 missing, 0 orphan). claimset.json written atomically; backup at claimset.bak.json")
