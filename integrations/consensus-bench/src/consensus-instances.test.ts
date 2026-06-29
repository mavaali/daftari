import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseConsensus } from "./consensus-parse.js";
import { buildInstances } from "./consensus-instances.js";
import { loadRevisionsFromFile } from "./consensus-revisions.js";

const BOX = parseConsensus(
  readFileSync(fileURLToPath(new URL("./__fixtures__/trump-current-consensus.wikitext", import.meta.url)), "utf8"),
);
const REVS = loadRevisionsFromFile(
  fileURLToPath(new URL("./__fixtures__/revisions-synthetic.json", import.meta.url)),
);

describe("buildInstances", () => {
  test("joins a citing revert to the governing terminal via resolveCurrent", () => {
    const inst = buildInstances(BOX, REVS);
    // cited 70 is active terminal of 11->17->50->70; governing = 70.
    const i70 = inst.find((x) => x.citedNum === 70);
    expect(i70?.resolved).toBe(true);
    expect(i70?.governingNum).toBe(70);
  });

  test("surfaces a citation of a non-existent item as an anomaly, not a drop", () => {
    const inst = buildInstances(BOX, REVS);
    const i999 = inst.find((x) => x.citedNum === 999);
    expect(i999).toBeDefined();
    expect(i999?.resolved).toBe(false);
    expect(i999?.governingNum).toBeUndefined();
  });

  test("resolves a cited item that is already active to itself", () => {
    const inst = buildInstances(BOX, REVS);
    const i71 = inst.find((x) => x.citedNum === 71); // #71 active
    expect(i71?.governingNum).toBe(71);
  });
});
