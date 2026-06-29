import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadDiffsFromFile } from "./consensus-content.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/co2-diff-single.json", import.meta.url));

describe("loadDiffsFromFile", () => {
  test("loads revert diffs keyed with the fields the pilot needs", () => {
    const diffs = loadDiffsFromFile(FIXTURE);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ revid: 1358996228, parentid: 1358989658, citedNum: 70, governingNum: 70 });
    expect(diffs[0].diffHtml).toContain("diff-addedline");
    expect(diffs[0].diffHtml).toContain("consensus 70");
  });
});
