import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseConsensus } from "./consensus-parse.js";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("./__fixtures__/trump-current-consensus.wikitext", import.meta.url)),
  "utf8",
);

describe("parseConsensus", () => {
  test("parses an active item with number, anchor, status, and statement", () => {
    const items = parseConsensus(FIXTURE);
    const item1 = items.find((i) => i.num === 1);
    expect(item1).toBeDefined();
    expect(item1?.anchor).toBe("C1");
    expect(item1?.status).toBe("active");
    expect(item1?.statement).toContain("official White House portrait as the infobox image");
  });

  test("parses a superseded item with its supersededBy edge", () => {
    const items = parseConsensus(FIXTURE);
    const item4 = items.find((i) => i.num === 4);
    expect(item4?.status).toBe("superseded");
    expect(item4?.supersededBy).toContain(15);
  });

  test("parses the supersedes edge and a two-way chain link", () => {
    const items = parseConsensus(FIXTURE);
    const item17 = items.find((i) => i.num === 17);
    expect(item17?.status).toBe("superseded");
    expect(item17?.supersededBy).toContain(50);
    expect(item17?.supersedes).toContain(11);
    // supersedes is the reverse edge; it must NOT leak its successor.
    expect(item17?.supersedes).not.toContain(50);
  });

  test("extracts a hidden item's statement from its content body, not the hide header", () => {
    const items = parseConsensus(FIXTURE);
    const item4 = items.find((i) => i.num === 4);
    expect(item4?.statement).toContain("Lead phrasing of Trump");
    expect(item4?.statement).not.toContain("headerstyle");
  });

  test("an active item carries no supersededBy edge even when its statement opens with 'Supersedes'", () => {
    const items = parseConsensus(FIXTURE);
    // #30 is active and its statement begins "Supersedes [[#C24|#24]]...". The
    // leading ref is the reverse (supersedes) edge, NOT a supersededBy pointer.
    // An active item is current by definition: nothing in-corpus supersedes it.
    const item30 = items.find((i) => i.num === 30);
    expect(item30?.status).toBe("active");
    expect(item30?.supersededBy).toEqual([]);
    expect(item30?.supersedes).toContain(24);
  });

  test("captures every predecessor when an item supersedes more than one", () => {
    const items = parseConsensus(FIXTURE);
    // #39 "Supersedes [[#C21|#21]] and [[#C36|#36]]" — both must be recorded.
    const item39 = items.find((i) => i.num === 39);
    expect(item39?.supersedes).toContain(21);
    expect(item39?.supersedes).toContain(36);
  });

  test("parses every item without dropping any (contiguous 1..76)", () => {
    const items = parseConsensus(FIXTURE);
    expect(items).toHaveLength(76);
    const nums = items.map((i) => i.num).sort((a, b) => a - b);
    expect(nums[0]).toBe(1);
    expect(nums.at(-1)).toBe(76);
    expect(new Set(nums).size).toBe(76); // no duplicates
  });
});
