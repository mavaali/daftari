#!/usr/bin/env python3
"""Exp #1 — Information-vs-Priors harness (protocol §5).

Blind elicitation of a 0-100 score under three conditions across N model
families x R repeats (prompt axis). Resumable JSONL output.

Usage:
  uv run --with httpx python harness.py --phase c2          # prior labeling
  uv run --with httpx python harness.py --phase c1c3        # after C2 freeze
  uv run --with httpx python harness.py --phase c2 --limit 2  # smoke test
"""
import argparse, asyncio, json, os, re, sys, time
from pathlib import Path
import httpx

ROOT = Path(__file__).parent
RAW = ROOT / "raw"; RAW.mkdir(exist_ok=True)
OUT = RAW / "results.jsonl"
ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"

def load_env():
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        sys.exit("OPENROUTER_API_KEY not set (expected in experiments/exp1-info-vs-priors/.env)")
    return key

SYSTEM = ("You are a careful, honest evaluator. Reason briefly, then always end your "
          "reply with a line in exactly this format: SCORE: <integer 0-100>")

# --- prompt templates: 3 framings (prompt axis) per condition. Blind: no mention
#     of an experiment, no prior verdicts, no strength. ---
def c2_prompt(e, r):
    X = e["from_claim"]
    return [
        f"Claim: {X}\n\nUsing only your own knowledge, how likely is this claim to be true? "
        f"Give an integer 0-100 (0 = certainly false, 100 = certainly true).",
        f"Assess this statement for truthfulness based on what you know.\n\nStatement: {X}\n\n"
        f"Report your confidence that it is correct as an integer 0 to 100.",
        f"{X}\n\nFrom your own knowledge alone, rate how strongly this holds, "
        f"from 0 (false) to 100 (true).",
    ][r]

def deriv_prompt(e, premise, r):
    X = e["from_claim"]
    return [
        f"Premise: {premise}\n\nClaim: {X}\n\nTaking only the premise as given, does the claim "
        f"follow from / depend on it? Re-derive this independently from the premise; do not assume "
        f"the claim is true on its own. Give an integer 0-100 (0 = does not follow from the premise "
        f"at all, 100 = follows directly from the premise).",
        f"Consider this premise as the only available basis:\n\nPremise: {premise}\n\nNow evaluate: "
        f"does the following claim derive from that premise?\nClaim: {X}\n\nWork it out from the "
        f"premise itself, not from outside knowledge. Rate 0-100 (0 = unsupported by the premise, "
        f"100 = directly entailed by it).",
        f"Premise (treat this as the given): {premise}\nClaim to test: {X}\n\nHow strongly does the "
        f"claim depend on / derive from the premise as stated? Reason from the premise alone, not "
        f"from what you already believe. Integer 0-100.",
    ][r]

def build_tasks(edges, families, conditions, repeats):
    tasks = []
    for e in edges:
        for fam in families:
            for r in range(repeats):
                for cond in conditions:
                    if cond == "C2":
                        prompt = c2_prompt(e, r)
                    elif cond == "C1":
                        prompt = deriv_prompt(e, e["to_premise_true"], r)
                    elif cond == "C3":
                        prompt = deriv_prompt(e, e["to_premise_flipped"], r)
                    elif cond == "W1":            # weakened: remove-quantifier
                        if not e.get("to_premise_weak_quant"): continue
                        prompt = deriv_prompt(e, e["to_premise_weak_quant"], r)
                    elif cond == "W2":            # weakened: vague-hedge
                        if not e.get("to_premise_weak_hedge"): continue
                        prompt = deriv_prompt(e, e["to_premise_weak_hedge"], r)
                    elif cond == "P":             # partial: moderate support (cliff-vs-graded probe)
                        if not e.get("to_premise_partial"): continue
                        prompt = deriv_prompt(e, e["to_premise_partial"], r)
                    else:
                        continue
                    tasks.append({
                        "key": f"{e['edge_id']}|{cond}|{fam['key']}|r{r}",
                        "edge_id": e["edge_id"], "condition": cond,
                        "family": fam["key"], "model": fam["id"], "repeat": r,
                        "prompt": prompt,
                    })
    return tasks

SCORE_RE = re.compile(r"SCORE:\s*(\d{1,3})", re.I)
def parse_score(text):
    if not text:
        return None
    hits = SCORE_RE.findall(text)
    if hits:
        v = int(hits[-1])
        return v if 0 <= v <= 100 else None
    nums = re.findall(r"\b(\d{1,3})\b", text)
    for n in reversed(nums):
        if 0 <= int(n) <= 100:
            return int(n)
    return None

async def call_one(client, key, t, sem, retries=4):
    payload = {"model": t["model"], "max_tokens": 1500, "temperature": 0.7,
               "reasoning": {"effort": "low"},  # reasoning models (gpt-5): brief reason, reach SCORE line
               # zero-data-retention: route ONLY to providers that do not store prompts
               # (protects the proprietary novel-cell content). Fails the call rather than
               # falling through to a logging provider.
               "provider": {"data_collection": "deny"},
               "messages": [{"role": "system", "content": SYSTEM},
                            {"role": "user", "content": t["prompt"]}]}
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    async with sem:
        for attempt in range(retries):
            try:
                resp = await client.post(ENDPOINT, json=payload, headers=headers, timeout=120)
                if resp.status_code in (429, 500, 502, 503, 529):
                    await asyncio.sleep(2 ** attempt + 1); continue
                resp.raise_for_status()
                data = resp.json()
                text = data["choices"][0]["message"]["content"]
                score = parse_score(text)
                return {**{k: t[k] for k in ("key","edge_id","condition","family","model","repeat")},
                        "score": score, "survives": (score >= 50) if score is not None else None,
                        "refusal": score is None, "raw": (text or "")[:600], "ts": time.time()}
            except Exception as ex:
                if attempt == retries - 1:
                    return {**{k: t[k] for k in ("key","edge_id","condition","family","model","repeat")},
                            "score": None, "survives": None, "refusal": True,
                            "error": f"{type(ex).__name__}: {ex}"[:200], "ts": time.time()}
                await asyncio.sleep(2 ** attempt + 1)

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", choices=["c2","c1c3","weak","partial","all"], required=True)
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--limit", type=int, default=0, help="smoke test: first N edges only")
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--scope", choices=["all","nonproprietary","novel"], default="all",
                    help="nonproprietary = public domain + controls (no IP egress); novel = novel cells only")
    args = ap.parse_args()
    key = load_env()
    edges = json.load(open(ROOT / "claimset.json"))
    families = json.load(open(ROOT / "models.json"))["families"]
    if args.scope == "nonproprietary":
        edges = [e for e in edges if e["domain"] == "public" or e["control"]]
    elif args.scope == "novel":
        edges = [e for e in edges if e["domain"] == "novel" and not e["control"]]
    if args.limit:
        edges = edges[:args.limit]
    conds = {"c2": ["C2"], "c1c3": ["C1","C3"], "weak": ["W1","W2"], "partial": ["P"],
             "all": ["C2","C1","C3","W1","W2","P"]}[args.phase]
    tasks = build_tasks(edges, families, conds, args.repeats)

    done = set()  # only SUCCESSFUL records count as done; refusals/errors retry on resume
    if OUT.exists():
        for line in OUT.read_text().splitlines():
            try:
                rec = json.loads(line)
                if not rec.get("refusal"):
                    done.add(rec["key"])
            except Exception: pass
    todo = [t for t in tasks if t["key"] not in done]
    print(f"phase={args.phase} edges={len(edges)} families={len(families)} repeats={args.repeats}")
    print(f"total tasks={len(tasks)} already_done={len(tasks)-len(todo)} todo={len(todo)}")
    if not todo:
        print("nothing to do"); return

    sem = asyncio.Semaphore(args.concurrency)
    n_ok = n_ref = 0
    async with httpx.AsyncClient() as client:
        with open(OUT, "a") as fh:
            coros = [call_one(client, key, t, sem) for t in todo]
            for i, fut in enumerate(asyncio.as_completed(coros), 1):
                rec = await fut
                fh.write(json.dumps(rec) + "\n"); fh.flush()
                if rec["refusal"]: n_ref += 1
                else: n_ok += 1
                if i % 25 == 0 or i == len(todo):
                    print(f"  {i}/{len(todo)}  ok={n_ok} refusal/err={n_ref}", flush=True)
    print(f"done. ok={n_ok} refusal/err={n_ref} -> {OUT}")

if __name__ == "__main__":
    asyncio.run(main())
