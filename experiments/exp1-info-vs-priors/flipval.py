#!/usr/bin/env python3
"""Flip validation (protocol §4): a held-out strong model judges each C3 flip on
two criteria — (i) coherent prose, (ii) removes/contradicts the specific support the
claim relied on. NOT blind (this is a meta-judgment, separate from the blind
re-derivation). Flips failing either criterion are flagged for human review/rejection.

  uv run --with httpx python flipval.py        # validate all non-negative-control edges
Writes raw/flipval.jsonl. Run analyze.py afterward; rejected flips are excluded.
"""
import json, os, re, time, asyncio, sys
from pathlib import Path
import httpx

ROOT = Path(__file__).parent
OUT = ROOT / "raw" / "flipval.jsonl"
ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
VALIDATOR = "openai/gpt-5"   # held-out-ish strong judge (distinct task from the blind re-derivation panel)

def load_env():
    for line in (ROOT/".env").read_text().splitlines():
        if line.strip() and not line.startswith("#") and "=" in line:
            k,v=line.split("=",1); os.environ.setdefault(k.strip(),v.strip())
    k=os.environ.get("OPENROUTER_API_KEY")
    if not k: sys.exit("OPENROUTER_API_KEY missing")
    return k

RUBRIC = """You are validating a test item. You are given a CLAIM, a TRUE premise, and a
FLIPPED premise. The flipped premise is supposed to be a minimal, coherent edit of the
true premise that CONTRADICTS or REMOVES the specific support the claim relied on.

CLAIM: {X}
TRUE premise: {Y}
FLIPPED premise: {Yp}

Judge two things:
1. COHERENT: is the flipped premise fluent, plausible-sounding prose (not nonsense/word-salad)? yes/no
2. CONTRADICTS: does the flipped premise genuinely negate or remove the specific support
   that the true premise gave the claim (so that, given the flipped premise, the claim no
   longer follows)? yes/no

Answer in exactly this format on one line:
COHERENT: <yes|no> | CONTRADICTS: <yes|no> | NOTE: <short reason>"""

def parse(text):
    if not text: return None
    coh = re.search(r"COHERENT:\s*(yes|no)", text, re.I)
    con = re.search(r"CONTRADICTS:\s*(yes|no)", text, re.I)
    if not (coh and con): return None
    return (coh.group(1).lower()=="yes", con.group(1).lower()=="yes")

async def one(client, key, e, sem):
    prompt = RUBRIC.format(X=e["from_claim"], Y=e["to_premise_true"], Yp=e["to_premise_flipped"])
    payload={"model":VALIDATOR,"max_tokens":1200,"temperature":0,"reasoning":{"effort":"low"},
             "provider":{"data_collection":"deny"},
             "messages":[{"role":"system","content":"You are a precise test-item validator."},
                         {"role":"user","content":prompt}]}
    async with sem:
        for a in range(4):
            try:
                r=await client.post(ENDPOINT,json=payload,headers={"Authorization":f"Bearer {key}"},timeout=120)
                if r.status_code in (429,500,502,503,529): await asyncio.sleep(2**a+1); continue
                r.raise_for_status()
                txt=r.json()["choices"][0]["message"]["content"]; p=parse(txt)
                return {"edge_id":e["edge_id"],"coherent":(p[0] if p else None),
                        "contradicts":(p[1] if p else None),
                        "flip_ok":(bool(p[0] and p[1]) if p else None),
                        "raw":(txt or "")[:400],"ts":time.time()}
            except Exception as ex:
                if a==3: return {"edge_id":e["edge_id"],"coherent":None,"contradicts":None,
                                 "flip_ok":None,"error":str(ex)[:160],"ts":time.time()}
                await asyncio.sleep(2**a+1)

async def main():
    key=load_env()
    edges=json.load(open(ROOT/"claimset.json"))
    # negative controls' flips are schema-filler (C1 itself is NO) — skip them
    todo=[e for e in edges if e.get("control")!="negative"]
    done=set()
    if OUT.exists():
        for l in OUT.read_text().splitlines():
            try:
                r=json.loads(l)
                if r.get("flip_ok") is not None: done.add(r["edge_id"])
            except Exception: pass
    todo=[e for e in todo if e["edge_id"] not in done]
    print(f"flip-validation: {len(todo)} edges (validator={VALIDATOR})")
    if not todo: print("nothing to do"); return
    sem=asyncio.Semaphore(8); ok=bad=err=0
    async with httpx.AsyncClient() as client:
        with open(OUT,"a") as fh:
            for fut in asyncio.as_completed([one(client,key,e,sem) for e in todo]):
                rec=await fut; fh.write(json.dumps(rec)+"\n"); fh.flush()
                if rec["flip_ok"] is True: ok+=1
                elif rec["flip_ok"] is False: bad+=1
                else: err+=1
    print(f"done. flip_ok={ok} flip_REJECT={bad} err={err} -> {OUT}")
    if bad: print("  (rejected flips will be excluded from C1/C3 analysis; see flipval.jsonl)")

if __name__=="__main__":
    asyncio.run(main())
