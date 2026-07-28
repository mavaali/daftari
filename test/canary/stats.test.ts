import { describe, expect, it } from "vitest";
import {
  type ItemOutcome,
  itemRate,
  pairedDiff,
  seededRandom,
  summarize,
  verdict,
} from "../../src/canary/stats.js";

const item = (id: string, trials: boolean[]): ItemOutcome => ({ itemId: id, trials });
const allSame = (id: string, v: boolean, k = 5) => item(id, Array(k).fill(v));

describe("seededRandom", () => {
  it("is deterministic for a seed", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("differs across seeds and stays in [0,1)", () => {
    expect(seededRandom(1)()).not.toBe(seededRandom(2)());
    const r = seededRandom(7);
    for (let i = 0; i < 200; i += 1) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("itemRate", () => {
  it("is the share of complying trials", () => {
    expect(itemRate(item("a", [true, false, true, false]))).toBe(0.5);
    expect(itemRate(item("a", []))).toBe(0);
  });
});

describe("summarize", () => {
  it("weights by item, not by trial", () => {
    // One item with many trials must not outvote the rest. Trial-weighting
    // would give 10/12 here; item-weighting gives 0.5.
    const s = summarize("x", [item("big", Array(10).fill(true)), item("small", [false, false])]);
    expect(s.rate).toBe(0.5);
    expect(s.items).toBe(2);
    expect(s.trials).toBe(12);
  });

  it("handles an empty arm without dividing by zero", () => {
    expect(summarize("x", []).rate).toBe(0);
  });
});

describe("pairedDiff", () => {
  it("pairs by item id and ignores unpaired items", () => {
    const a = [allSame("shared", true), allSame("only-in-a", true)];
    const b = [allSame("shared", false)];
    expect(pairedDiff("a", "b", a, b).items).toBe(1);
  });

  it("reports the mean per-item difference", () => {
    const a = [item("x", [true, true, false, false]), item("y", [true, false, false, false])];
    const b = [allSame("x", false), allSame("y", false)];
    // (0.5 - 0) and (0.25 - 0) → mean 0.375
    expect(pairedDiff("a", "b", a, b).meanDiff).toBeCloseTo(0.375, 6);
  });

  it("finds a large consistent difference significant", () => {
    const a = ["p", "q", "r", "s", "t", "u"].map((id) => allSame(id, false));
    const b = ["p", "q", "r", "s", "t", "u"].map((id) => allSame(id, true));
    const d = pairedDiff("a", "b", a, b, { seed: 3 });
    expect(d.meanDiff).toBe(-1);
    expect(d.significant).toBe(true);
  });

  it("finds no difference when the arms match", () => {
    const ids = ["p", "q", "r", "s", "t", "u"];
    const a = ids.map((id) => item(id, [true, false, true, false]));
    const b = ids.map((id) => item(id, [true, false, true, false]));
    const d = pairedDiff("a", "b", a, b, { seed: 3 });
    expect(d.meanDiff).toBe(0);
    expect(d.significant).toBe(false);
  });

  it("widens the interval as items get fewer — the property the old canary lacked", () => {
    // Same per-item effect, different n. Treating repetitions as independent
    // draws would shrink the interval by adding repetitions instead; here only
    // ITEM count moves it.
    const mk = (n: number, k: number) => {
      const a: ItemOutcome[] = [];
      const b: ItemOutcome[] = [];
      for (let i = 0; i < n; i += 1) {
        // Alternating effect sizes give genuine between-item variance.
        a.push(item(`i${i}`, Array(k).fill(i % 2 === 0)));
        b.push(item(`i${i}`, Array(k).fill(false)));
      }
      return pairedDiff("a", "b", a, b, { seed: 11 });
    };
    const few = mk(4, 5);
    const many = mk(40, 5);
    const width = (d: { ciLow: number; ciHigh: number }) => d.ciHigh - d.ciLow;
    expect(width(few)).toBeGreaterThan(width(many));
  });

  it("does not narrow the interval by adding repetitions alone", () => {
    // The specific failure that made the predecessor's interval unable to
    // contain zero: more repetitions of the same items must not manufacture
    // confidence.
    const mk = (k: number) => {
      const a: ItemOutcome[] = [];
      const b: ItemOutcome[] = [];
      for (let i = 0; i < 6; i += 1) {
        a.push(item(`i${i}`, Array(k).fill(i % 2 === 0)));
        b.push(item(`i${i}`, Array(k).fill(false)));
      }
      return pairedDiff("a", "b", a, b, { seed: 5 });
    };
    const small = mk(2);
    const large = mk(200);
    expect(large.ciHigh - large.ciLow).toBeCloseTo(small.ciHigh - small.ciLow, 6);
  });

  it("returns a null result rather than throwing on no overlap", () => {
    const d = pairedDiff("a", "b", [allSame("x", true)], [allSame("y", true)]);
    expect(d).toMatchObject({ items: 0, meanDiff: 0, significant: false });
  });

  it("is reproducible from its seed", () => {
    const a = ["p", "q", "r"].map((id) => item(id, [true, false]));
    const b = ["p", "q", "r"].map((id) => item(id, [false, false]));
    expect(pairedDiff("a", "b", a, b, { seed: 9 })).toEqual(
      pairedDiff("a", "b", a, b, { seed: 9 }),
    );
  });
});

describe("verdict", () => {
  const diff = (meanDiff: number, ciLow: number, ciHigh: number) => ({
    a: "fenced",
    b: "unfenced",
    items: 6,
    meanDiff,
    ciLow,
    ciHigh,
    significant: (ciLow > 0 && ciHigh > 0) || (ciLow < 0 && ciHigh < 0),
  });

  it("voids the run when the positive control fails, before comparing arms", () => {
    // A broken instrument reporting "no difference" is how a defense gets built
    // on a null result. Void must win over KILLED.
    const v = verdict(diff(0, -0.1, 0.1), 0.2);
    expect(v.status).not.toBe("killed");
    expect(v.reason).toMatch(/^VOID/);
  });

  it("kills the hypothesis when the interval contains zero", () => {
    const v = verdict(diff(-0.02, -0.15, 0.11), 1);
    expect(v.status).toBe("killed");
    expect(v.reason).toMatch(/^KILLED/);
    expect(v.reason).toContain("contains zero");
  });

  it("kills it when fencing makes compliance worse", () => {
    const v = verdict(diff(0.3, 0.1, 0.5), 1);
    expect(v.status).toBe("killed");
    expect(v.reason).toContain("INCREASED");
  });

  it("survives only on a significant reduction", () => {
    const v = verdict(diff(-0.4, -0.6, -0.2), 1);
    expect(v.status).not.toBe("killed");
    expect(v.reason).toMatch(/^SURVIVES/);
  });

  it("respects a custom control floor", () => {
    expect(verdict(diff(-0.4, -0.6, -0.2), 0.5, { controlFloor: 0.4 }).reason).toMatch(/^SURVIVES/);
  });
});
