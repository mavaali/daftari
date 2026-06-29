import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseConsensus } from "./consensus-parse.js";
import { resolveCurrent } from "./consensus-resolve.js";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("./__fixtures__/trump-current-consensus.wikitext", import.meta.url)),
  "utf8",
);

describe("resolveCurrent", () => {
  test("resolves an active item to itself", () => {
    const items = parseConsensus(FIXTURE);
    const r = resolveCurrent(items, 1);
    expect(r.item?.num).toBe(1);
    expect(r.item?.status).toBe("active");
    expect(r.resolved).toBe(true);
  });

  test("follows a multi-hop supersession chain to the active governing item", () => {
    const items = parseConsensus(FIXTURE);
    const r = resolveCurrent(items, 11);
    expect(r.chain).toEqual([11, 17, 50, 70]);
    expect(r.item?.num).toBe(70);
    expect(r.item?.status).toBe("active");
    expect(r.resolved).toBe(true);
  });

  test("returns unresolved at a dead-end chain rather than minting (the no-mint guard)", () => {
    const items = parseConsensus(FIXTURE);
    // #4 -> #15, and #15 is "Superseded by lead rewrite" with no in-corpus
    // successor. The walk must stop unresolved, not invent a current value.
    const r = resolveCurrent(items, 4);
    expect(r.chain).toEqual([4, 15]);
    expect(r.resolved).toBe(false);
    expect(r.item?.num).toBe(15);
    expect(r.item?.status).toBe("superseded");
  });
});
