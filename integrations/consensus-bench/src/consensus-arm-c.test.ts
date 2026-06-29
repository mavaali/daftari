import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseConsensus } from "./consensus-parse.js";
import { loadDiffsFromFile } from "./consensus-content.js";
import { parsePassage } from "./consensus-passage.js";
import { armC } from "./consensus-arm-c.js";

const BOX = parseConsensus(
  readFileSync(fileURLToPath(new URL("./__fixtures__/trump-current-consensus.wikitext", import.meta.url)), "utf8"),
);
const REAL = loadDiffsFromFile(
  fileURLToPath(new URL("./__fixtures__/co2-diff-single.json", import.meta.url)),
)[0];

describe("armC (daftari)", () => {
  test("returns governing on a resolved, marker-confirmed, scorable instance", () => {
    const passage = parsePassage(REAL.diffHtml);
    const c = armC(BOX, REAL, passage, REAL.diffHtml);
    expect(c.classification).toBe("governing");
    expect(c.answer).toBe(passage.governingText);
  });

  test("abstains when the cited item is unresolved (dead-end => no-mint)", () => {
    // Synthesize a dead-end instance: cite #4, which resolves to #15 (superseded,
    // no successor) => resolveCurrent unresolved => abstain.
    const passage = parsePassage(REAL.diffHtml);
    const deadEnd = { ...REAL, citedNum: 4, governingNum: 4 };
    const c = armC(BOX, deadEnd, passage, REAL.diffHtml);
    expect(c.classification).toBe("abstain");
  });

  test("unscorable when the marker for the cited item is absent", () => {
    const passage = parsePassage(REAL.diffHtml);
    // Cite #30 (resolves/active) but its marker is not in this #70 diff window.
    const noMarker = { ...REAL, citedNum: 30, governingNum: 30 };
    const c = armC(BOX, noMarker, passage, REAL.diffHtml);
    expect(c.classification).toBe("unscorable");
  });
});
