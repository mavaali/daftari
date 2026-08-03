#!/usr/bin/env python3
"""case_lint.py — prove a Berlin Bureau case is solvable-and-fair.

A case is a Clue-style deduction over axes (e.g. who/how/what). The linter
enforces the invariants that make a case a real daftari lesson rather than a
guessing game:

  A. TRUTH-UNIQUENESS  — over the corroborated true clues, exactly one triple
     satisfies all constraints, and it equals the declared ground_truth.
  B. FAIRNESS          — every planted lie contradicts at least one corroborated
     true clue, so a disciplined analyst can quarantine it (no guessing needed).
  C. NAIVE-MISDIRECTION — a lazy reader who counts face-value clues without
     grading lands on the frame's verdict, not the truth. Discipline is load-bearing.
  D. SACRED-TENSION    — declared open tensions must stay open; solving may shift
     but never close them, and no axis value may BE a sacred tension.

Usage:  uv run --with pyyaml python case_lint.py <case.yaml>
Exit 0 = PASS (all invariants hold). Exit 1 = FAIL.
"""
import sys, itertools, yaml

def parse_literal(lit):
    # "who!=WEATHERVANE" -> ("who","!=","WEATHERVANE"); "how=route-survey-cover" -> ("how","=",...)
    if "!=" in lit:
        a, v = lit.split("!=", 1); return (a.strip(), "!=", v.strip())
    a, v = lit.split("=", 1); return (a.strip(), "=", v.strip())

def satisfies(triple, literals):
    for lit in literals:
        axis, op, val = parse_literal(lit)
        got = triple[axis]
        if op == "=" and got != val: return False
        if op == "!=" and got == val: return False
    return True

def solve(axes, literal_sets):
    lits = [l for s in literal_sets for l in s]
    keys = list(axes.keys())
    out = []
    for combo in itertools.product(*[axes[k] for k in keys]):
        triple = dict(zip(keys, combo))
        if satisfies(triple, lits):
            out.append(triple)
    return out

def main(path):
    case = yaml.safe_load(open(path))["case"]
    axes = case["axes"]; gt = case["ground_truth"]; frame = case.get("frame")
    clues = case["clues"]; verdict_axis = case["verdict_axis"]
    sacred = case.get("sacred_tensions", [])
    mode = case.get("mode", "standard")   # 'tutorial' relaxes invariant C (no trap by design)
    by_id = {c["id"]: c for c in clues}
    fails = []

    def is_corrob_true(c): return c.get("truth") is True and c.get("corroborated") is True

    # --- A. TRUTH-UNIQUENESS ---
    true_sets = [c.get("asserts", []) for c in clues if is_corrob_true(c)]
    sols = solve(axes, true_sets)
    if len(sols) != 1:
        fails.append(f"A truth-uniqueness: {len(sols)} solutions over corroborated-true clues (need exactly 1): {sols}")
    elif sols[0] != gt:
        fails.append(f"A truth-uniqueness: unique solution {sols[0]} != declared ground_truth {gt}")

    # --- B. FAIRNESS (every lie is catchable) ---
    for c in clues:
        if c.get("truth") is False:
            contra = c.get("contradicts", [])
            if not any(cid in by_id and is_corrob_true(by_id[cid]) for cid in contra):
                fails.append(f"B fairness: planted clue {c['id']} contradicts no corroborated-true clue (uncatchable)")

    # --- C. NAIVE-MISDIRECTION (lazy counting -> the frame's verdict) ---
    # A tutorial teaches the loop with no trap, so C is intentionally not enforced.
    naive = None
    if mode != "tutorial":
        if frame is None:
            fails.append("C naive-misdirection: standard case must declare a 'frame'")
        else:
            tally = {v: 0 for v in axes[verdict_axis]}
            for c in clues:  # face value: count equality literals on the verdict axis, planted included
                for lit in c.get("asserts", []):
                    a, op, v = parse_literal(lit)
                    if a == verdict_axis and op == "=" and v in tally:
                        tally[v] += 1
            naive = max(tally, key=tally.get)
            if naive == gt[verdict_axis]:
                fails.append(f"C naive-misdirection: face-value plurality on '{verdict_axis}' is the TRUTH ({naive}); a lazy player would win without discipline. tally={tally}")
            elif naive != frame[verdict_axis]:
                fails.append(f"C naive-misdirection: face-value plurality is {naive}, expected the frame's verdict {frame[verdict_axis]}. tally={tally}")
            if frame[verdict_axis] == gt[verdict_axis]:
                fails.append("C naive-misdirection: frame verdict == ground_truth verdict (no trap)")

    # --- D. SACRED-TENSION ---
    axis_vals = {v for vals in axes.values() for v in vals}
    for t in sacred:
        if t in axis_vals:
            fails.append(f"D sacred-tension: '{t}' is both a solution axis value and a sacred tension")
    for c in clues:
        for closed in c.get("closes", []):
            if closed in sacred:
                fails.append(f"D sacred-tension: clue {c['id']} closes sacred tension '{closed}'")

    # --- report ---
    print(f"case: {case['id']}  ({len(clues)} clues, axes={ {k:len(v) for k,v in axes.items()} })")
    if fails:
        for f in fails: print("  FAIL:", f)
        print("RESULT: FAIL"); return 1
    print(f"  A truth-uniqueness: unique solution == ground_truth {gt}")
    print(f"  B fairness: all {sum(1 for c in clues if c.get('truth') is False)} planted clue(s) catchable")
    if mode == "tutorial":
        print("  C naive-misdirection: SKIPPED (tutorial mode — no trap by design)")
    else:
        print(f"  C naive-misdirection: face-value '{verdict_axis}' -> {naive} (frame), truth is {gt[verdict_axis]}")
    print(f"  D sacred-tension: {sacred or 'none'} preserved")
    print("RESULT: PASS"); return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
