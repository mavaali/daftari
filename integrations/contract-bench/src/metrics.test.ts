import { describe, expect, test } from "vitest";
import { scoreArms, compareArms, WIN_THRESHOLD, type ArmAnswers } from "./metrics.js";
import type { ContractQA } from "./qa-build.js";

// Hand-built fixture: 3 scoped-current, 2 latest-current, 1 unamended, 2 no-value
const QAS: ContractQA[] = [
  { id: "scoped-current:4.1", clause: "4.1", question: "q", answer: "NEW-A", governingDoc: "amend-1", bucket: "scoped-current" },
  { id: "scoped-current:4.2", clause: "4.2", question: "q", answer: "NEW-B", governingDoc: "amend-1", bucket: "scoped-current" },
  { id: "scoped-current:4.3", clause: "4.3", question: "q", answer: "NEW-C", governingDoc: "amend-1", bucket: "scoped-current" },
  { id: "latest-current:4.4", clause: "4.4", question: "q", answer: "LATEST-D", governingDoc: "amend-2", bucket: "latest-current" },
  { id: "latest-current:4.5", clause: "4.5", question: "q", answer: "LATEST-E", governingDoc: "amend-2", bucket: "latest-current" },
  { id: "unamended:4.6", clause: "4.6", question: "q", answer: "ORIG-F", governingDoc: "master", bucket: "unamended" },
  { id: "no-value:4.99", clause: "4.99", question: "q", answer: "NOT_PRESENT", governingDoc: "", bucket: "no-value" },
  { id: "no-value:4.100", clause: "4.100", question: "q", answer: "NOT_PRESENT", governingDoc: "", bucket: "no-value" },
];

// Arm A (recency foil): wrong on all 3 scoped-current (returns OLD), right on rest.
const ARM_A: ArmAnswers = {
  arm: "recency",
  byClauseId: {
    "scoped-current:4.1": "OLD-A",   // WRONG
    "scoped-current:4.2": "OLD-B",   // WRONG
    "scoped-current:4.3": "OLD-C",   // WRONG
    "latest-current:4.4": "LATEST-D", // correct
    "latest-current:4.5": "LATEST-E", // correct
    "unamended:4.6": "ORIG-F",        // correct
    "no-value:4.99": "NOT_PRESENT",   // correct (no fabrication)
    "no-value:4.100": "FABRICATED",   // fabricates!
  },
};

// Arm C (daftari): all 3 scoped-current correct, rest same as A.
const ARM_C: ArmAnswers = {
  arm: "daftari",
  byClauseId: {
    "scoped-current:4.1": "NEW-A",   // CORRECT
    "scoped-current:4.2": "NEW-B",   // CORRECT
    "scoped-current:4.3": "NEW-C",   // CORRECT
    "latest-current:4.4": "LATEST-D", // correct
    "latest-current:4.5": "LATEST-E", // correct
    "unamended:4.6": "ORIG-F",        // correct
    "no-value:4.99": "NOT_PRESENT",   // correct
    "no-value:4.100": "NOT_PRESENT",  // correct
  },
};

describe("metrics — per-bucket accuracy", () => {
  test("Arm A: 0/3 on scoped-current, 2/2 on latest-current, 1/1 on unamended", () => {
    const { arms } = scoreArms(QAS, [ARM_A]);
    const a = arms[0];
    const scoped = a.buckets.find((b) => b.bucket === "scoped-current")!;
    const latest = a.buckets.find((b) => b.bucket === "latest-current")!;
    const unamended = a.buckets.find((b) => b.bucket === "unamended")!;

    expect(scoped.total).toBe(3);
    expect(scoped.correct).toBe(0);
    expect(scoped.accuracy).toBeCloseTo(0);

    expect(latest.total).toBe(2);
    expect(latest.correct).toBe(2);
    expect(latest.accuracy).toBeCloseTo(1);

    expect(unamended.total).toBe(1);
    expect(unamended.correct).toBe(1);
    expect(unamended.accuracy).toBeCloseTo(1);
  });

  test("Arm C: 3/3 on scoped-current (perfect)", () => {
    const { arms } = scoreArms(QAS, [ARM_C]);
    const c = arms[0];
    const scoped = c.buckets.find((b) => b.bucket === "scoped-current")!;

    expect(scoped.total).toBe(3);
    expect(scoped.correct).toBe(3);
    expect(scoped.accuracy).toBeCloseTo(1);
  });

  test("bucket with zero QAs reports NaN accuracy (not a crash)", () => {
    const { arms } = scoreArms([], [{ arm: "empty", byClauseId: {} }]);
    const a = arms[0];
    for (const b of a.buckets) {
      expect(b.total).toBe(0);
      expect(Number.isNaN(b.accuracy)).toBe(true);
    }
  });
});

describe("metrics — fabrication rate on no-value bucket", () => {
  test("Arm A fabricates 1 of 2 no-value probes → rate = 0.5", () => {
    const { arms } = scoreArms(QAS, [ARM_A]);
    const a = arms[0];
    expect(a.noValueTotal).toBe(2);
    expect(a.noValueFabricated).toBe(1);
    expect(a.fabricationRate).toBeCloseTo(0.5);
  });

  test("Arm C fabricates 0 of 2 no-value probes → rate = 0", () => {
    const { arms } = scoreArms(QAS, [ARM_C]);
    const c = arms[0];
    expect(c.noValueTotal).toBe(2);
    expect(c.noValueFabricated).toBe(0);
    expect(c.fabricationRate).toBeCloseTo(0);
  });

  test("arm that always returns NOT_PRESENT has fabricationRate = 0", () => {
    const arm: ArmAnswers = {
      arm: "cautious",
      byClauseId: {
        "no-value:4.99": "NOT_PRESENT",
        "no-value:4.100": "NOT_PRESENT",
      },
    };
    const { arms } = scoreArms(QAS, [arm]);
    expect(arms[0].fabricationRate).toBeCloseTo(0);
  });

  test("arm that always fabricates has fabricationRate = 1", () => {
    const arm: ArmAnswers = {
      arm: "hallucinator",
      byClauseId: {
        "no-value:4.99": "MADE_UP",
        "no-value:4.100": "ALSO_MADE_UP",
      },
    };
    const { arms } = scoreArms(QAS, [arm]);
    expect(arms[0].fabricationRate).toBeCloseTo(1);
  });
});

describe("metrics — pairwise verdict", () => {
  test("WIN when Arm C is >> Arm A on scoped-current (delta >= WIN_THRESHOLD)", () => {
    // C = 3/3 = 1.0, A = 0/3 = 0.0 → delta = 1.0 >= 0.2
    const { verdict } = scoreArms(QAS, [ARM_A, ARM_C], { armC: "daftari", armA: "recency" });
    expect(verdict).not.toBeNull();
    expect(verdict!.verdict).toBe("WIN");
    expect(verdict!.delta).toBeCloseTo(1.0);
  });

  test("INCONCLUSIVE when Arm C and Arm A are tied on scoped-current", () => {
    // Both wrong → 0/3 each → delta = 0 (< WIN_THRESHOLD but >= 0)
    const armCWeak: ArmAnswers = {
      arm: "weak-daftari",
      byClauseId: {
        "scoped-current:4.1": "WRONG",
        "scoped-current:4.2": "WRONG",
        "scoped-current:4.3": "WRONG",
      },
    };
    const { verdict } = scoreArms(QAS, [ARM_A, armCWeak], { armC: "weak-daftari", armA: "recency" });
    expect(verdict!.verdict).toBe("INCONCLUSIVE");
    expect(verdict!.delta).toBeCloseTo(0);
  });

  test("INCONCLUSIVE when Arm C is slightly better but below WIN_THRESHOLD", () => {
    // C = 1/3, A = 0/3 → delta = 0.333 which is > threshold... let's use 1/3 vs 0/3
    // Actually 0.333 > 0.2 so that's WIN. Use 1/6 diff: needs 6 QAs. Use a minimal fixture instead.
    const smallQAs: ContractQA[] = [
      { id: "scoped-current:X.1", clause: "X.1", question: "q", answer: "CORRECT", governingDoc: "a", bucket: "scoped-current" },
      { id: "scoped-current:X.2", clause: "X.2", question: "q", answer: "CORRECT", governingDoc: "a", bucket: "scoped-current" },
      { id: "scoped-current:X.3", clause: "X.3", question: "q", answer: "CORRECT", governingDoc: "a", bucket: "scoped-current" },
      { id: "scoped-current:X.4", clause: "X.4", question: "q", answer: "CORRECT", governingDoc: "a", bucket: "scoped-current" },
      { id: "scoped-current:X.5", clause: "X.5", question: "q", answer: "CORRECT", governingDoc: "a", bucket: "scoped-current" },
      { id: "scoped-current:X.6", clause: "X.6", question: "q", answer: "CORRECT", governingDoc: "a", bucket: "scoped-current" },
      { id: "scoped-current:X.7", clause: "X.7", question: "q", answer: "CORRECT", governingDoc: "a", bucket: "scoped-current" },
      { id: "scoped-current:X.8", clause: "X.8", question: "q", answer: "CORRECT", governingDoc: "a", bucket: "scoped-current" },
      { id: "scoped-current:X.9", clause: "X.9", question: "q", answer: "CORRECT", governingDoc: "a", bucket: "scoped-current" },
      { id: "scoped-current:X.10", clause: "X.10", question: "q", answer: "CORRECT", governingDoc: "a", bucket: "scoped-current" },
    ];
    // C gets 2/10 = 0.2, A gets 1/10 = 0.1 → delta = 0.1 < 0.2 → INCONCLUSIVE
    const cAnswers: Record<string, string> = {};
    const aAnswers: Record<string, string> = {};
    for (const qa of smallQAs) {
      cAnswers[qa.id] = "WRONG";
      aAnswers[qa.id] = "WRONG";
    }
    cAnswers["scoped-current:X.1"] = "CORRECT";
    cAnswers["scoped-current:X.2"] = "CORRECT";
    aAnswers["scoped-current:X.1"] = "CORRECT";
    // C=2/10, A=1/10, delta=0.1
    const { verdict } = scoreArms(smallQAs, [
      { arm: "armA", byClauseId: aAnswers },
      { arm: "armC", byClauseId: cAnswers },
    ], { armC: "armC", armA: "armA" });
    expect(verdict!.verdict).toBe("INCONCLUSIVE");
    expect(verdict!.delta).toBeCloseTo(0.1);
    expect(WIN_THRESHOLD).toBe(0.2); // sanity: our threshold is what we expect
  });

  test("KILL when Arm A beats Arm C on scoped-current (delta < 0)", () => {
    // A gets 2/3, C gets 0/3 → delta < 0 → KILL
    const armABetter: ArmAnswers = {
      arm: "recency-strong",
      byClauseId: {
        "scoped-current:4.1": "NEW-A",   // CORRECT
        "scoped-current:4.2": "NEW-B",   // CORRECT
        "scoped-current:4.3": "WRONG",   // wrong
      },
    };
    const armCWeak: ArmAnswers = {
      arm: "daftari-weak",
      byClauseId: {
        "scoped-current:4.1": "WRONG",
        "scoped-current:4.2": "WRONG",
        "scoped-current:4.3": "WRONG",
      },
    };
    const { verdict } = scoreArms(QAS, [armABetter, armCWeak], { armC: "daftari-weak", armA: "recency-strong" });
    expect(verdict!.verdict).toBe("KILL");
    expect(verdict!.delta).toBeLessThan(0);
  });

  test("verdict is null when fewer than 2 arms provided (no armC/armA opts)", () => {
    const { verdict } = scoreArms(QAS, [ARM_A]);
    expect(verdict).toBeNull();
  });

  test("scoreArms returns both arm results when two arms provided", () => {
    const { arms } = scoreArms(QAS, [ARM_A, ARM_C], { armC: "daftari", armA: "recency" });
    expect(arms).toHaveLength(2);
    expect(arms.map((a) => a.arm)).toEqual(["recency", "daftari"]);
  });
});
