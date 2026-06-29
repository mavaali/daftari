import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadDiffsFromFile } from "./consensus-content.js";
import { parsePassage, markerPresent } from "./consensus-passage.js";

const REAL = loadDiffsFromFile(
  fileURLToPath(new URL("./__fixtures__/co2-diff-single.json", import.meta.url)),
)[0];

const MULTI = `
<tr><td class="diff-deletedline"><div>old one</div></td><td class="diff-addedline"><div>new one</div></td></tr>
<tr><td class="diff-deletedline"><div>old two</div></td><td class="diff-addedline"><div>new two</div></td></tr>`;

const ADD_ONLY = `<tr><td class="diff-addedline"><div>brand new line</div></td></tr>`;

describe("parsePassage", () => {
  test("extracts governing (added) and stale (deleted) text from a single-hunk diff", () => {
    const p = parsePassage(REAL.diffHtml);
    expect(p.scorable).toBe(true);
    // Text is wikitext (links/bold preserved, e.g. "[[president of the United States]]");
    // both arms read from the same diff so comparison stays apples-to-apples.
    expect(p.governingText).toContain("47th");
    expect(p.governingText).toContain("president of the United States");
    expect(p.governingText).not.toContain("<!--"); // comments stripped
    expect(p.governingText).not.toContain("<div"); // tags stripped
    expect(p.staleText.length).toBeGreaterThan(0);
    expect(p.staleText).not.toBe(p.governingText);
  });

  test("flags a multi-hunk diff unscorable", () => {
    const p = parsePassage(MULTI);
    expect(p.scorable).toBe(false);
    expect(p.reason).toContain("multi-hunk");
  });

  test("flags an add-only diff unscorable", () => {
    const p = parsePassage(ADD_ONLY);
    expect(p.scorable).toBe(false);
    expect(p.reason).toContain("add-only");
  });
});

describe("markerPresent", () => {
  test("detects the inline consensus marker for the cited item", () => {
    expect(markerPresent(REAL.diffHtml, 70)).toBe(true);
    expect(markerPresent(REAL.diffHtml, 999)).toBe(false);
  });
});
