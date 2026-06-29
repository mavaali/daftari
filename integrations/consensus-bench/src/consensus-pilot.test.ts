import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseConsensus } from "./consensus-parse.js";
import { loadDiffsFromFile } from "./consensus-content.js";
import { runPilot } from "./consensus-pilot.js";

const BOX = parseConsensus(
  readFileSync(fileURLToPath(new URL("./__fixtures__/trump-current-consensus.wikitext", import.meta.url)), "utf8"),
);
const DIFFS = loadDiffsFromFile(
  fileURLToPath(new URL("./__fixtures__/co2-diff-single.json", import.meta.url)),
);

describe("runPilot", () => {
  const result = runPilot(BOX, DIFFS);

  test("produces one row per diff with arm classifications", () => {
    expect(result.rows).toHaveLength(1);
    const r = result.rows[0];
    expect(r.armABefore).toBe("stale");      // recency fails at the bad edit
    expect(r.armAAfter).toBe("governing");   // fair foil: passes once corrected
    expect(r.armC).toBe("governing");        // daftari foregrounds governing
  });

  test("metrics summarize the kill gate", () => {
    const m = result.metrics;
    expect(m.scorable).toBe(1);
    expect(m.armAFailBefore).toBe(1);  // count classified 'stale' at before
    expect(m.armAPassAfter).toBe(1);
    expect(m.armCGoverning).toBe(1);
  });
});
