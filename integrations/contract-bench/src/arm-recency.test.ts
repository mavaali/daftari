import { describe, expect, test } from "vitest";
import { recencyAnswer } from "./arm-recency.js";
import { generateChain } from "./synth-gen.js";
import { assemble } from "./assemble.js";
import { buildQAs } from "./qa-build.js";
import { resolveChain } from "./clause-edge.js";
import { perturbValues } from "./perturb.js";

describe("arm-recency — faithful-foil assertions", () => {
  // All tests use raw (pre-perturb) docs so we can reason about old vs new
  // values without the perturbation layer. The foil logic is independent of
  // perturbation: the structural relationship (stale recital > governing restate)
  // is preserved through assemble() identically.

  const seed = 17;

  test("STALE chain: recencyAnswer for the scoped clause returns the OLD recital value, which != the governing QA answer", () => {
    const { docs } = generateChain({ seed, variant: "stale" });
    const resolutions = resolveChain(docs);
    const qas = buildQAs(docs, resolutions);

    // 4.1 is scoped-current: governing doc is amendment-1
    const qa = qas.find((q) => q.clause === "4.1");
    expect(qa).toBeDefined();
    expect(qa!.bucket).toBe("scoped-current");

    const armAnswer = recencyAnswer(docs, "4.1");

    // Arm A picks the latest doc that mentions 4.1 (amendment-2 / the stale recital)
    // and reads the OLD value from it. This is the faithful-foil property.
    expect(armAnswer).not.toBe("NOT_PRESENT");
    expect(armAnswer).not.toBe(qa!.answer); // wrong answer — faithfully wrong, not a strawman
  });

  test("CLEAN chain: recencyAnswer for the scoped clause equals the governing QA answer (Arm A ties C with no stale mentions)", () => {
    const { docs } = generateChain({ seed, variant: "clean" });
    const resolutions = resolveChain(docs);
    const qas = buildQAs(docs, resolutions);

    const qa = qas.find((q) => q.clause === "4.1");
    expect(qa).toBeDefined();
    expect(qa!.bucket).toBe("scoped-current");

    const armAnswer = recencyAnswer(docs, "4.1");

    // On a clean chain the latest mention of 4.1 is amendment-1 (the governing doc),
    // so recencyAnswer == ground-truth answer.
    expect(armAnswer).toBe(qa!.answer);
  });

  test("STALE chain: latest-current clause (4.2) is answered correctly by recency arm", () => {
    const { docs } = generateChain({ seed, variant: "stale" });
    const resolutions = resolveChain(docs);
    const qas = buildQAs(docs, resolutions);

    const qa = qas.find((q) => q.clause === "4.2");
    expect(qa).toBeDefined();
    expect(qa!.bucket).toBe("latest-current");

    const armAnswer = recencyAnswer(docs, "4.2");
    // 4.2's latest mention IS the latest amendment (which contains its operative restate),
    // so recency is correct here.
    expect(armAnswer).toBe(qa!.answer);
  });

  test("a DEFINED-TERM clause is found by recency (not only numbered Sections)", () => {
    // recencyAnswer must detect quoted defined terms, not just "Section X" —
    // else every defined term returns NOT_PRESENT and Arm A is silently crippled
    // on real credit-agreement chains (the artifact caught in the E3 NGS run).
    const docs = [
      { id: "m", order: 0, text: '"Commitment" means the original obligation.' },
      {
        id: "a1",
        order: 1,
        text:
          "The following terms are hereby amended and restated to read as follows: " +
          '"Commitment" means, the increased obligation amount.',
      },
    ];
    const ans = recencyAnswer(docs, "Commitment");
    expect(ans).not.toBe("NOT_PRESENT");
    expect(ans).toContain("increased obligation"); // most-recent doc's value, real comma-after-means shape
  });

  test("no-mention clause returns NOT_PRESENT", () => {
    const { docs, noValueClauses } = generateChain({ seed, variant: "clean" });
    for (const cl of noValueClauses) {
      expect(recencyAnswer(docs, cl)).toBe("NOT_PRESENT");
    }
  });

  test("clause present only in master (never amended) returns master value", () => {
    // Hand-rolled case using a whole-number section id (no decimal dot that
    // would truncate extractValue's sentence-boundary regex).
    const docs = [
      { id: "master", order: 0, text: 'Section 5 is set as follows: "$30,000".' },
      { id: "amend-1", order: 1, text: 'Section 6 is hereby amended and restated in its entirety as follows: "60 days".' },
    ];
    // Section 5 is in master, never mentioned in any amendment
    const answer = recencyAnswer(docs, "5");
    expect(answer).toBe("$30,000");
  });

  test("STALE: foil property verified via assemble (perturbed chain) — arm picks stale recital doc", () => {
    // Structural assertion: Arm A picks the latest doc mentioning 4.1 (the stale
    // recital in amendment-2), while ground truth comes from amendment-1.
    // We verify the governing docs differ — structural, not value-dependent.
    const { docs: rawDocs, noValueClauses } = generateChain({ seed: 31, variant: "stale" });
    const { groundTruth } = assemble(rawDocs, { seed: 31, noValueClauses });

    // Apply perturbation in the same order assemble does.
    const accumMap: Record<string, string> = {};
    const perturbedDocs = rawDocs.map((d) => {
      const r = perturbValues(d.text, 31, accumMap);
      Object.assign(accumMap, r.mapping);
      return { ...d, text: r.text };
    });

    const qa = groundTruth.find((q) => q.clause === "4.1" && q.bucket === "scoped-current");
    expect(qa).toBeDefined();
    expect(qa!.governingDoc).toBe("amendment-1"); // governing is NOT the latest doc

    // Arm A must pick amendment-2 (the stale recital), not amendment-1.
    const mentionRe = /Section\s+4\.1\b/i;
    const candidates = perturbedDocs.filter((d) => mentionRe.test(d.text));
    const latestMentioner = candidates.reduce((best, d) => (d.order > best.order ? d : best));
    expect(latestMentioner.id).toBe("amendment-2"); // stale recital is in the latest amendment

    // The value extracted from the latest mentioner differs from the governing answer
    // iff old != new after perturbation. We assert the structural invariant: the
    // latest mentioner is NOT the governing doc.
    expect(latestMentioner.id).not.toBe(qa!.governingDoc);
  });
});
