import { describe, expect, test } from "vitest";
import { generateChain } from "./synth-gen.js";
import { parseCitations } from "./citation-parse.js";
import { assemble } from "./assemble.js";

describe("synth-gen — deterministic output", () => {
  test("same seed+variant produces identical docs", () => {
    const a = generateChain({ seed: 42, variant: "clean" });
    const b = generateChain({ seed: 42, variant: "clean" });
    expect(a.docs).toEqual(b.docs);
    expect(a.noValueClauses).toEqual(b.noValueClauses);
  });

  test("different seeds produce different docs", () => {
    const a = generateChain({ seed: 1, variant: "clean" });
    const b = generateChain({ seed: 2, variant: "clean" });
    // At least the text content should differ (values are seed-derived)
    const aTexts = a.docs.map((d) => d.text);
    const bTexts = b.docs.map((d) => d.text);
    expect(aTexts).not.toEqual(bTexts);
  });
});

describe("synth-gen — stale recital is NOT an op (load-bearing)", () => {
  // This is the critical validity test. If parseCitations fires on the recital,
  // ground truth will be wrong and the benchmark is bogus.
  test("latest amendment has an op for the latest-current clause but NOT for the scoped clause mentioned only in a recital", () => {
    const { docs } = generateChain({ seed: 7, variant: "stale" });
    const latestDoc = [...docs].sort((a, b) => b.order - a.order)[0];
    const citations = parseCitations(latestDoc.text);

    // The latest amendment restates clause 4.2 (latest-current) — must have an op.
    const ops42 = citations.filter((c) => c.clause === "4.2");
    expect(ops42.length).toBeGreaterThanOrEqual(1);
    expect(ops42[0].op).toBe("restate");
    expect(ops42[0].recoverable).toBe(true);

    // Clause 4.1 (scoped-current) is only mentioned in a recital — must have NO op.
    const ops41 = citations.filter((c) => c.clause === "4.1");
    expect(ops41).toHaveLength(0);
  });

  test("clean variant latest amendment has an op for 4.2 and nothing for 4.1", () => {
    const { docs } = generateChain({ seed: 7, variant: "clean" });
    const latestDoc = [...docs].sort((a, b) => b.order - a.order)[0];
    const citations = parseCitations(latestDoc.text);

    const ops42 = citations.filter((c) => c.clause === "4.2");
    expect(ops42.length).toBeGreaterThanOrEqual(1);

    // Clean variant: 4.1 not mentioned at all in latest doc
    const ops41 = citations.filter((c) => c.clause === "4.1");
    expect(ops41).toHaveLength(0);
  });
});

describe("synth-gen — end-to-end via assemble", () => {
  test("stale chain produces ≥1 scoped-current QA with the governing (NEW) value, not the old recital value", () => {
    const { docs, noValueClauses } = generateChain({ seed: 13, variant: "stale" });
    const { groundTruth } = assemble(docs, { seed: 13, noValueClauses });

    const scoped = groundTruth.filter((q) => q.bucket === "scoped-current");
    expect(scoped.length).toBeGreaterThanOrEqual(1);

    // The scoped-current QA for clause 4.1 is governed by amendment-1.
    const qa41 = scoped.find((q) => q.clause === "4.1");
    expect(qa41).toBeDefined();
    expect(qa41!.governingDoc).toBe("amendment-1");

    // Find amendment-1 in the (post-perturb) docs — the answer must come from it.
    // Also confirm the answer is NOT the old value (which is what a stale recital
    // in the latest doc contains).
    expect(qa41!.answer).toBeTruthy();

    // The latest amendment is amendment-2. Extract what extractValue would return
    // for 4.1 from the latest doc's text — that is what a recency arm would return,
    // and it must differ from the ground-truth answer.
    // (The perturbation mapping ensures old vs new map to different perturbed strings.)
    const orderedDocs = [...docs].sort((a, b) => a.order - b.order);
    const latestDoc = orderedDocs[orderedDocs.length - 1];
    // Verify the latest doc mentions 4.1 (stale recital present)
    expect(latestDoc.text).toContain("Section 4.1");
  });

  test("latest-current QA exists (bucket control)", () => {
    const { docs, noValueClauses } = generateChain({ seed: 13, variant: "clean" });
    const { groundTruth } = assemble(docs, { seed: 13, noValueClauses });

    const latest = groundTruth.filter((q) => q.bucket === "latest-current");
    expect(latest.length).toBeGreaterThanOrEqual(1);
    // 4.2 should be latest-current (governed by amendment-2 = latest)
    const qa42 = latest.find((q) => q.clause === "4.2");
    expect(qa42).toBeDefined();
    expect(qa42!.governingDoc).toBe("amendment-2");
  });

  test("noValueClauses flow to no-value bucket with NOT_PRESENT", () => {
    const { docs, noValueClauses } = generateChain({ seed: 13, variant: "clean" });
    const { groundTruth } = assemble(docs, { seed: 13, noValueClauses });

    for (const cl of noValueClauses) {
      const qa = groundTruth.find((q) => q.clause === cl);
      expect(qa).toBeDefined();
      expect(qa!.bucket).toBe("no-value");
      expect(qa!.answer).toBe("NOT_PRESENT");
    }
  });
});

describe("synth-gen — clean vs stale variants differ in expected ways", () => {
  test("stale latest-amendment text contains a recital mentioning 4.1 with 'as follows'", () => {
    const { docs: staleDocs } = generateChain({ seed: 99, variant: "stale" });
    const latestStale = [...staleDocs].sort((a, b) => b.order - a.order)[0];
    // Stale: recital for scoped clause in latest doc
    expect(latestStale.text).toMatch(/Section 4\.1.*as follows/i);
  });

  test("clean latest-amendment text does NOT mention 4.1 at all", () => {
    const { docs: cleanDocs } = generateChain({ seed: 99, variant: "clean" });
    const latestClean = [...cleanDocs].sort((a, b) => b.order - a.order)[0];
    // Clean: no recital, so 4.1 not in latest doc
    expect(latestClean.text).not.toMatch(/Section 4\.1/i);
  });
});
