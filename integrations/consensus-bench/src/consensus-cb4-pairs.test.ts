import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadDiffsFromFile } from "./consensus-content.js";
import { truePairs, controlPairs } from "./consensus-cb4-pairs.js";

const DIFFS = loadDiffsFromFile(
  fileURLToPath(new URL("./__fixtures__/trump-instance-diffs.json", import.meta.url)),
);

describe("truePairs", () => {
  const tp = truePairs(DIFFS);
  test("one per scorable instance with gov/stale text + governingNum", () => {
    expect(tp.length).toBe(33);
    for (const p of tp) {
      expect(p.govText.length).toBeGreaterThan(0);
      expect(p.staleText.length).toBeGreaterThan(0);
      expect(typeof p.governingNum).toBe("number");
    }
  });
});

describe("controlPairs", () => {
  const cp = controlPairs(DIFFS);
  test("every control pairs two DIFFERENT consensus items (truly unrelated)", () => {
    expect(cp.length).toBeGreaterThanOrEqual(10);
    for (const p of cp) {
      expect(p.numA).not.toBe(p.numB); // item-level dedup is load-bearing
      expect(p.textA.length).toBeGreaterThan(0);
      expect(p.textB.length).toBeGreaterThan(0);
    }
  });
});
