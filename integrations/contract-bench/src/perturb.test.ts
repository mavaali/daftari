import { describe, expect, test } from "vitest";
import { perturbValues } from "./perturb.js";

describe("perturbValues — seeded, type-preserving value substitution", () => {
  test("perturbs a duration to a different same-unit value, deterministically and consistently", () => {
    const input =
      "Net 30 days from the first invoice; the second invoice is also Net 30 days.";
    const a = perturbValues(input, 42);
    const b = perturbValues(input, 42);

    expect(a.text).toEqual(b.text); // deterministic for a fixed seed
    expect(a.text).not.toContain("30 days"); // original replaced
    const fake = a.mapping["30 days"];
    expect(fake).toMatch(/^\d+ days$/); // same unit preserved
    expect(fake).not.toEqual("30 days"); // value actually changed
    // both occurrences map to the same fake (cross-reference consistency)
    expect(a.text.match(/\d+ days/g)).toEqual([fake, fake]);
  });

  test("perturbs a currency amount to a different value of the same magnitude and $ format", () => {
    const input = "The liability cap is $5,000,000 for the initial term.";
    const r = perturbValues(input, 7);
    expect(r.text).not.toContain("$5,000,000");
    const fake = r.mapping["$5,000,000"];
    expect(fake).toMatch(/^\$[\d,]+$/); // dollar sign + grouped digits
    expect(fake).not.toEqual("$5,000,000");
    expect(fake.replace(/[$,]/g, "")).toHaveLength(7); // same magnitude (7 digits)
    expect(r.text).toContain(fake);
  });

  test("carries the mapping across documents: shared values stay identical, superseded values differ", () => {
    // master defines the cap and term; amendment supersedes the term only.
    const master = perturbValues("Cap is $1,000,000; the term is 12 months.", 99);
    const amend = perturbValues(
      "The $1,000,000 cap is unchanged; the term is now 24 months.",
      99,
      master.mapping,
    );
    // shared cap -> identical fake in both documents
    const capFake = master.mapping["$1,000,000"];
    expect(amend.mapping["$1,000,000"]).toEqual(capFake);
    expect(amend.text).toContain(capFake);
    expect(amend.text).not.toContain("$1,000,000");
    // superseded term -> the two versions map to different fakes
    expect(amend.mapping["24 months"]).not.toEqual(master.mapping["12 months"]);
  });
});
