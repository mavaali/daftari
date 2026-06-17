#!/usr/bin/env python3
"""Weakening validation (Exp #2 protocol §4): a held-out strong model judges each
weakened premise (W1 remove-quantifier, W2 vague-hedge) on three criteria —
(i) coherent prose, (ii) NON-entailing (the claim should NOT clearly follow),
(iii) NOT a contradiction (must not negate the claim — that would be a flip/C3).
A valid weakening is coherent AND non-entailing AND non-contradicting.

  uv run --with httpx python weakval.py
Writes raw/weakval.jsonl. analyze_exp2.py excludes rejected weakenings.
"""
import json, os, re, time, asyncio, sys
from pathlib import Path
import httpx

ROOT = Path(__file__).parent
OUT = ROOT / "raw" / "weakval.jsonl"
ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
VALIDATOR = "openai/gpt-5"

def load_env():
    for line in (ROOT/".env").read_text().splitlines():
        if line.strip() and not line.startswith("#") and "=" in line:
            k,v=line.split("=",1); os.environ.setdefault(k.strip(),v.strip())
    k=os.environ.get("OPENROUTER_API_KEY")
    if not k: sys.exit("OPENROUTER_API_KEY missing")
    return k

RUBRIC = """You are validating a test item. You are given a CLAIM and a WEAKENED premise.
The weakened premise is supposed to be a coherent, on-topic statement that has had the
specific support REMOVED, so that the claim no longer clearly follows from it — but it must
NOT contradict the claim (that would be a different item type).

CLAIM: {X}
WEAKENED premise: {W}

Judge three things:
1. COHERENT: is the weakened premise fluent, plausible-sounding prose (not nonsense)? yes/no
2. ENTAILS: given ONLY this weakened premise, does the claim still clearly follow / is it
   well-supported? (We WANT this to be 'no' — the support should be gone.) yes/no
3. CONTRADICTS: does the weakened premise assert the opposite of, or directly conflict
   with, the claim? (We WANT 'no' — weakening removes support, it does not negate.) yes/no

Answer on one line, exactly:
COHERENT: <yes|no> | ENTAILS: <yes|no> | CONTRADICTS: <yes|no> | NOTE: <short reason>"""

def parse(text):
    if not text: return None
    g=lambda k: re.search(k+r":\s*(yes|no)", text, re.I)
    coh,ent,con=g("COHERENT"),g("ENTAILS"),g("CONTRADICTS")
    if not (coh and ent and con): return None
    return (coh.group(1).lower()=="yes", ent.group(1).lower()=="yes", con.group(1).lower()=="yes")

async def one(client, key, eid, variant, X, W, sem):
    prompt=RUBRIC.format(X=X, W=W)
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
                # valid weakening: coherent AND not-entailing AND not-contradicting
                ok=(p[0] and (not p[1]) and (not p[2])) if p else None
                return {"key":f"{eid}|{variant}","edge_id":eid,"variant":variant,
                        "coherent":(p[0] if p else None),"entails":(p[1] if p else None),
                        "contradicts":(p[2] if p else None),"weak_ok":ok,
                        "raw":(txt or "")[:400],"ts":time.time()}
            except Exception as ex:
                if a==3: return {"key":f"{eid}|{variant}","edge_id":eid,"variant":variant,
                                 "coherent":None,"entails":None,"contradicts":None,"weak_ok":None,
                                 "error":str(ex)[:160],"ts":time.time()}
                await asyncio.sleep(2**a+1)

async def main():
    key=load_env()
    edges=json.load(open(ROOT/"claimset.json"))
    tasks=[]
    for e in edges:
        if e.get("control")=="negative": continue
        if e.get("to_premise_weak_quant"): tasks.append((e["edge_id"],"W1",e["from_claim"],e["to_premise_weak_quant"]))
        if e.get("to_premise_weak_hedge"): tasks.append((e["edge_id"],"W2",e["from_claim"],e["to_premise_weak_hedge"]))
    done=set()
    if OUT.exists():
        for l in OUT.read_text().splitlines():
            try:
                r=json.loads(l)
                if r.get("weak_ok") is not None: done.add(r["key"])
            except Exception: pass
    tasks=[t for t in tasks if f"{t[0]}|{t[1]}" not in done]
    print(f"weakening-validation: {len(tasks)} variants (validator={VALIDATOR})")
    if not tasks: print("nothing to do"); return
    sem=asyncio.Semaphore(8); ok=bad=err=0
    async with httpx.AsyncClient() as client:
        with open(OUT,"a") as fh:
            for fut in asyncio.as_completed([one(client,key,eid,v,X,W,sem) for eid,v,X,W in tasks]):
                rec=await fut; fh.write(json.dumps(rec)+"\n"); fh.flush()
                if rec["weak_ok"] is True: ok+=1
                elif rec["weak_ok"] is False: bad+=1
                else: err+=1
    print(f"done. weak_ok={ok} weak_REJECT={bad} err={err} -> {OUT}")
    if bad: print("  (rejected weakenings excluded from analysis; see weakval.jsonl)")

if __name__=="__main__":
    asyncio.run(main())
