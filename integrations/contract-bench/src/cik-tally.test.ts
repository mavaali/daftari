import { describe, expect, test } from "vitest";
import { tallyCiks } from "./cik-tally.js";
import type { EftsHit } from "./efts-search.js";

const hit = (cik: string): EftsHit => ({ cik, accession: "a", filename: "f", formType: "8-K", fileDate: "2023-01-01" });

describe("tallyCiks", () => {
  test("ranks CIKs by frequency, descending, with a deterministic CIK tiebreak", () => {
    const hits = [hit("A"), hit("B"), hit("A"), hit("C"), hit("B"), hit("A")];
    expect(tallyCiks(hits)).toEqual([{ cik: "A", count: 3 }, { cik: "B", count: 2 }, { cik: "C", count: 1 }]);
  });
});
