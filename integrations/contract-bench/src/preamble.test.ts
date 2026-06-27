import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { htmlToText } from "./html-to-text.js";
import { parsePreamble } from "./preamble.js";

const amd1 = htmlToText(readFileSync(new URL("./__fixtures__/ngs/amd1.htm", import.meta.url), "utf8"));

describe("parsePreamble", () => {
  test("extracts ordinal, BASE date (not the amendment's own effective date), and agreement type from real NGS amd-1", () => {
    const p = parsePreamble(amd1);
    expect(p).not.toBeNull();
    expect(p?.ordinal).toBe(1);
    expect(p?.ordinalWord.toLowerCase()).toBe("first"); // raw token preserved (uppercase in source); ordinal is the canonical key
    expect(p?.baseDate).toBe("February 28, 2023"); // NOT "November 14, 2023" (the amendment's own date)
    expect(p?.agreementType.toLowerCase()).toContain("credit agreement");
  });
  test("does NOT match the amendment's own 'dated effective as of' date", () => {
    expect(parsePreamble(amd1)?.baseDate).not.toBe("November 14, 2023");
  });
  test("returns null when there is no <Ordinal> Amendment", () => {
    expect(parsePreamble("This Credit Agreement dated as of January 1, 2020 by and among …")).toBeNull();
  });
  test("returns null when no base 'dated as of' date is present", () => {
    expect(parsePreamble("FIRST AMENDMENT TO CREDIT AGREEMENT. No date here.")).toBeNull();
  });
});
