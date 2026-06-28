import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseConsensus } from "./consensus-parse.js";
import { groupTopics } from "./consensus-topics.js";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("./__fixtures__/trump-current-consensus.wikitext", import.meta.url)),
  "utf8",
);

describe("groupTopics", () => {
  test("groups a supersession chain into one topic with the active terminal as current", () => {
    const topics = groupTopics(parseConsensus(FIXTURE));
    const leadChain = topics.find((t) => t.items.includes(11));
    expect(leadChain?.items).toEqual([11, 17, 50, 70]);
    expect(leadChain?.current).toEqual([70]);
    expect(leadChain?.resolved).toBe(true);
  });

  test("merges multiple predecessors superseded by one item into a single topic", () => {
    // #39 supersedes both #21 and #36 — all three are one topic, current #39.
    const topics = groupTopics(parseConsensus(FIXTURE));
    const t = topics.find((x) => x.items.includes(39));
    expect(t?.items).toEqual([21, 36, 39]);
    expect(t?.current).toEqual([39]);
  });

  test("a standalone active item is its own single-item topic", () => {
    const topics = groupTopics(parseConsensus(FIXTURE));
    const t = topics.find((x) => x.items.length === 1 && x.items[0] === 1);
    expect(t).toBeDefined();
    expect(t?.current).toEqual([1]);
    expect(t?.resolved).toBe(true);
  });

  test("a chain that dead-ends at a superseded item has no current (honest no-mint)", () => {
    // {4,15}: #4 superseded by #15, #15 "Superseded by lead rewrite" (no
    // in-corpus successor, still flagged superseded). No active terminal.
    const topics = groupTopics(parseConsensus(FIXTURE));
    const t = topics.find((x) => x.items.includes(4));
    expect(t?.items).toEqual([4, 15]);
    expect(t?.current).toEqual([]);
    expect(t?.resolved).toBe(false);
  });

  test("every item belongs to exactly one topic and none are dropped", () => {
    const items = parseConsensus(FIXTURE);
    const topics = groupTopics(items);
    const all = topics.flatMap((t) => t.items).sort((a, b) => a - b);
    expect(all).toHaveLength(items.length);
    expect(new Set(all).size).toBe(items.length);
    expect(all[0]).toBe(1);
    expect(all.at(-1)).toBe(76);
  });
});
