import { describe, expect, test } from "vitest";
import { parseConsensusReverts } from "./consensus-reverts.js";
import type { RevisionRecord } from "./consensus-revisions.js";

function rev(revid: number, comment: string): RevisionRecord {
  return { revid, parentid: revid - 1, timestamp: "2025-09-01T00:00:00Z", user: "U", comment };
}

describe("parseConsensusReverts", () => {
  test("matches 'rv per consensus N' and extracts the number", () => {
    const out = parseConsensusReverts([rev(2, "manual rv per consensus 70")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ revid: 2, citedNum: 70 });
  });

  test("matches an anchor-wikilink citation (#C71)", () => {
    const out = parseConsensusReverts([
      rev(3, "partial rv per [[Talk:Donald Trump/Current consensus#C71|consensus 71]]"),
    ]);
    expect(out.map((i) => i.citedNum)).toEqual([71]);
  });

  test("emits one instance per cited number on a multi-cite revert", () => {
    const out = parseConsensusReverts([rev(5, "rv per consensus 30 and consensus 39")]);
    expect(out.map((i) => i.citedNum).sort((a, b) => a - b)).toEqual([30, 39]);
  });

  test("does NOT match a revert with no numbered citation (the near-miss)", () => {
    const out = parseConsensusReverts([rev(4, "restored per the consensus we reached on talk")]);
    expect(out).toEqual([]);
  });

  test("does NOT match a plain edit that is not a revert", () => {
    const out = parseConsensusReverts([rev(1, "ce: tweak wording of lead")]);
    expect(out).toEqual([]);
  });

  test("dedupes a number cited twice in one comment", () => {
    const out = parseConsensusReverts([rev(7, "rv per consensus 70, consensus 70 again")]);
    expect(out.map((i) => i.citedNum)).toEqual([70]);
  });
});
