import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { assemble, writeAssembly } from "./assemble.js";

describe("assemble — end-to-end perturbed vault + ground truth", () => {
  const raw = [
    { id: "master", order: 0, text: "Section 4.2 governs payment." },
    {
      id: "amendment-1",
      order: 1,
      text: 'Section 4.2 is hereby amended and restated in its entirety as follows: "Net 30 days."',
    },
    {
      id: "amendment-2",
      order: 2,
      text: 'Section 7.1 is hereby amended and restated in its entirety as follows: "Term runs 12 months."',
    },
  ];

  test("the scoped-current answer is the PERTURBED value from the governing doc, consistent with the vault", () => {
    const a = assemble(raw, { seed: 5 });
    const qa = a.groundTruth.find((q) => q.clause === "4.2");
    // 4.2 is governed by amendment-1, not the latest doc -> scoped-current
    expect(qa?.bucket).toBe("scoped-current");
    // contamination dodge: the answer is no longer the pretrained "30 days"
    expect(qa?.answer).not.toContain("30 days");
    expect(qa?.answer).toMatch(/^Net \d+ days\.$/);
    // the same perturbed value lives in the governing doc in the vault
    const gov = a.vault.find((f) => f.path === "clause-4.2/amendment-1.md");
    expect(gov?.content).toContain(qa!.answer);
  });

  test("the vault carries the clause-scoped superseded_by chain", () => {
    const a = assemble(raw, { seed: 5 });
    const masterVersion = a.vault.find((f) => f.path === "clause-4.2/master.md");
    expect(masterVersion?.content).toContain('superseded_by: "clause-4.2/amendment-1.md"');
  });

  test("no-value probes flow through to ground truth", () => {
    const a = assemble(raw, { seed: 5, noValueClauses: ["88.8"] });
    expect(a.groundTruth.find((q) => q.clause === "88.8")).toMatchObject({
      bucket: "no-value",
      answer: "NOT_PRESENT",
    });
  });
});

describe("writeAssembly — on-disk artifacts", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("writes the vault (nested clause dirs), ground truth, pair dump and mapping", () => {
    dir = mkdtempSync(join(tmpdir(), "cb1-"));
    const a = assemble(
      [
        { id: "master", order: 0, text: "Section 4.2 governs payment." },
        {
          id: "amendment-1",
          order: 1,
          text: 'Section 4.2 is hereby amended and restated in its entirety as follows: "Net 30 days."',
        },
      ],
      { seed: 5 },
    );
    writeAssembly(a, dir);

    expect(existsSync(join(dir, "vault/clause-4.2/master.md"))).toBe(true);
    expect(existsSync(join(dir, "vault/clause-4.2/amendment-1.md"))).toBe(true);
    const gt = JSON.parse(readFileSync(join(dir, "ground-truth.json"), "utf8"));
    expect(Array.isArray(gt)).toBe(true);
    expect(gt.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "pairs.md"))).toBe(true);
    expect(existsSync(join(dir, "perturbation.json"))).toBe(true);
  });
});

describe("assemble — defined-term chain (end-to-end)", () => {
  const raw = [
    { id: "master", order: 0, text: '"Applicable Margin" means 2.00%. "Commitment" means $5,000,000.' },
    {
      id: "amendment-1",
      order: 1,
      text:
        "The following terms are hereby amended and restated in their respective " +
        'entireties to read in full as follows: "Applicable Margin" means 2.75%.',
    },
    {
      id: "amendment-2",
      order: 2,
      text:
        "The following terms are hereby amended and restated in their respective " +
        'entireties to read in full as follows: "Commitment" means $7,500,000.',
    },
  ];

  test("scoped-current term answered from governing doc, slugged vault path, $ perturbed", () => {
    const a = assemble(raw, { seed: 11 });
    const am = a.groundTruth.find((q) => q.clause === "Applicable Margin");
    expect(am?.bucket).toBe("scoped-current");
    expect(am?.governingDoc).toBe("amendment-1");
    const gov = a.vault.find((f) => f.path === "clause-Applicable-Margin/amendment-1.md");
    expect(gov).toBeDefined();
    expect(gov?.content).toContain(am!.answer);
    const commit = a.groundTruth.find((q) => q.clause === "Commitment");
    expect(commit?.answer).not.toContain("7,500,000");
  });
});
