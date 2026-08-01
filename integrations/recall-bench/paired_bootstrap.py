"""Paired bootstrap CI on B-A for the timestamp baseline.

Pairs questions by qa.id (a question recurs across checkpoints; we take the mean
composite per id per arm), then bootstraps the paired difference over questions.
Composite is 0-6; reported as percentage points (/6*100) for parity with the
harness aggregate. Usage: python paired_bootstrap.py A/questions.jsonl B/questions.jsonl
"""
import json
import random
import sys
from collections import defaultdict


def load(path):
    by_id = defaultdict(list)
    cat = {}
    for line in open(path):
        if not line.strip():
            continue
        r = json.loads(line)
        q = r["qa"]
        by_id[q["id"]].append(r["composite"])
        cat[q["id"]] = q["category"]
    return {i: sum(v) / len(v) for i, v in by_id.items()}, cat


def pct(x):
    return x / 6 * 100


def main():
    A, catA = load(sys.argv[1])
    B, catB = load(sys.argv[2])
    cat = {**catA, **catB}
    ids = sorted(set(A) & set(B))
    n = len(ids)
    if n == 0:
        print("no paired ids")
        return
    diffs = {i: B[i] - A[i] for i in ids}

    a_overall = pct(sum(A[i] for i in ids) / n)
    b_overall = pct(sum(B[i] for i in ids) / n)
    mean_d = sum(diffs.values()) / n

    random.seed(42)
    BOOT = 10000
    boot = []
    for _ in range(BOOT):
        s = random.choices(ids, k=n)
        boot.append(sum(diffs[i] for i in s) / n)
    boot.sort()
    lo = boot[int(0.025 * BOOT)]
    hi = boot[int(0.975 * BOOT)]

    print(f"paired questions: {n}")
    print(f"A (timestamps OFF) overall: {a_overall:.1f}%")
    print(f"B (timestamps ON)  overall: {b_overall:.1f}%")
    print(f"B-A: {pct(mean_d):+.1f}pp   95% bootstrap CI [{pct(lo):+.1f}, {pct(hi):+.1f}]")

    bycat = defaultdict(list)
    for i in ids:
        bycat[cat[i]].append(diffs[i])
    print("--- per-category B-A (pp), n ---")
    for c in sorted(bycat):
        ds = bycat[c]
        print(f"  {c:26s} {pct(sum(ds) / len(ds)):+6.1f}  n={len(ds)}")


if __name__ == "__main__":
    main()
