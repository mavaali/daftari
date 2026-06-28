import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseConsensus } from "./consensus-parse.js";
import { groupTopics } from "./consensus-topics.js";
import { buildInstances } from "./consensus-instances.js";
import { loadRevisionsFromFile } from "./consensus-revisions.js";
import { buildQa } from "./consensus-qa.js";

const BOX = parseConsensus(
  readFileSync(fileURLToPath(new URL("./__fixtures__/trump-current-consensus.wikitext", import.meta.url)), "utf8"),
);
const REVS = loadRevisionsFromFile(
  fileURLToPath(new URL("./__fixtures__/revisions-synthetic.json", import.meta.url)),
);

describe("buildQa", () => {
  const qa = buildQa(BOX, groupTopics(BOX), buildInstances(BOX, REVS));

  test("stale-restatement-trap: one QA per resolved instance, gold = governing terminal", () => {
    const trap = qa.filter((q) => q.bucket === "stale-restatement-trap");
    const t70 = trap.find((q) => q.governingNum === 70);
    expect(t70).toBeDefined();
    expect(t70?.staleCitedNum).toBe(70);
  });

  test("no-mint is box-derived: the dead-end {4,15} topic produces a no-mint QA, gold = not-present", () => {
    const noMint = qa.filter((q) => q.bucket === "no-mint");
    const deadEnd = noMint.find((q) => q.topicItems?.includes(4));
    expect(deadEnd).toBeDefined();
    expect(deadEnd?.gold).toBe("not-present");
  });

  test("CO1 does NOT auto-populate live-tension; settled 'no consensus' items are never mis-tagged", () => {
    // The box holds only settled items. #48/#56/#65 say "no consensus on wording
    // BUT the status quo is {...}" — settled decisions with a governing value, not
    // tensions. CO1 leaves the keystone bucket empty (deferred to a stream pass)
    // and must never tag these as live-tension.
    const tension = qa.filter((q) => q.bucket === "live-tension");
    expect(tension).toEqual([]);
    expect(qa.find((q) => q.topicItems?.includes(48) && q.bucket === "live-tension")).toBeUndefined();
  });

  test("current-decision: a settled active single-item topic not cited by any instance", () => {
    const baseline = qa.filter((q) => q.bucket === "current-decision");
    expect(baseline.length).toBeGreaterThan(0);
    for (const q of baseline) expect(typeof q.governingNum).toBe("number");
  });

  test("every QA has a bucket and a stable id", () => {
    expect(qa.length).toBeGreaterThan(0);
    const ids = qa.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
