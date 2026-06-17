import json, collections
files = ["draft_public_favors.json","draft_public_disfavors.json","draft_novel.json","draft_novel_pd_expansion.json"]
DROP = {"pub-pd-012","pub-pd-018"}  # contested premises (protocol §8 faithfulness confound)
edges=[]
for f in files:
    edges.extend(json.load(open(f)))
edges=[e for e in edges if e["edge_id"] not in DROP]
req={"edge_id","domain","intended_prior","prior_confirmed","control","source","provenance","from_claim","to_premise_true","to_premise_flipped","derives_question","flip_validation","notes"}
ids=[e["edge_id"] for e in edges]
dupes=[i for i,c in collections.Counter(ids).items() if c>1]
bad=[e["edge_id"] for e in edges if set(e)!=req]
assert not dupes, f"DUP: {dupes}"
assert not bad, f"BAD SCHEMA: {bad}"
cells=collections.Counter()
for e in edges:
    cells[f"control:{e['control']}" if e["control"] else f"{e['domain']}/{e['intended_prior']}"]+=1
json.dump(edges, open("claimset.json","w"), indent=2)
print("DROPPED:", sorted(DROP))
print("TOTAL:", len(edges), "| prior-cell:", sum(1 for e in edges if not e['control']))
for k in sorted(cells): print(f"  {k}: {cells[k]}")
