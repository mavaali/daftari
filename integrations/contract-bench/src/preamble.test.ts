import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { htmlToText } from "./html-to-text.js";
import { parsePreamble } from "./preamble.js";

const amd1 = htmlToText(readFileSync(new URL("./__fixtures__/ngs/amd1.htm", import.meta.url), "utf8"));
const pqAmd8 = htmlToText(readFileSync(new URL("./__fixtures__/petroquest/amd8.htm", import.meta.url), "utf8"));
const pqAmd11 = htmlToText(readFileSync(new URL("./__fixtures__/petroquest/amd11.htm", import.meta.url), "utf8"));

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

  // PetroQuest: real 5-amendment chain. The title carries the amendment's OWN
  // date; the TRUE base is referenced later via the recital anchor "that certain
  // <Type> Agreement dated as of <base>". All amendments must resolve to the same
  // base so reconstruct.ts collapses them into ONE chain.
  test("PetroQuest amd-8: base date from recital anchor, NOT the title's own date", () => {
    const p = parsePreamble(pqAmd8);
    expect(p).not.toBeNull();
    expect(p?.ordinal).toBe(8);
    expect(p?.baseDate).toBe("October 2, 2008"); // NOT "September 29, 2014" (the amendment's own date in the title)
    expect(p?.baseDate).not.toBe("September 29, 2014");
    expect(p?.agreementType.toLowerCase()).toContain("credit agreement");
  });
  test("PetroQuest amd-11: ordinal past Tenth (NOT hijacked to 1 by 'First Amendment' in recitals)", () => {
    const p = parsePreamble(pqAmd11);
    expect(p).not.toBeNull();
    expect(p?.ordinal).toBe(11); // NOT 1 — proves extended ordinal list + first-match (title before recitals)
    expect(p?.baseDate).toBe("October 2, 2008");
  });
  test("prefers the recital base date over the amendment's own title date", () => {
    const synthetic =
      "FIRST AMENDMENT TO CREDIT AGREEMENT dated as of January 1, 2099 among ACME. " +
      "Whereas the parties are party to that certain Credit Agreement dated as of March 3, 2010, as amended.";
    const p = parsePreamble(synthetic);
    expect(p).not.toBeNull();
    expect(p?.baseDate).toBe("March 3, 2010"); // the recital base, NOT the title's own Jan 1 2099
  });
});
