import { describe, expect, it } from "vitest";
import {
  applyAssert,
  comparePositions,
  conflictPairs,
  dissentIds,
  foreignPositionViolation,
  isContested,
  legacySnapshot,
  nextPositionId,
  unsuperseded,
} from "../../src/curation/positions.js";
import type { Position } from "../../src/frontmatter/types.js";

function pos(over: Partial<Position> & Pick<Position, "id" | "principal" | "stance">): Position {
  return {
    statement: null,
    confidence: "medium",
    provenance: "direct",
    valid_from: null,
    superseded_by: null,
    created: "2026-08-01",
    sources: [],
    ...over,
  };
}

const assertInput = {
  principal: "alice",
  stance: "assert" as const,
  statement: "the floor causes storms",
  confidence: "high" as const,
  provenance: "direct" as const,
  valid_from: null,
  sources: [],
  created: "2026-08-06",
};

describe("positions core (U-2)", () => {
  it("first assert on a null set mints pos-001, not contested", () => {
    const out = applyAssert(null, assertInput);
    expect(out.newPosition.id).toBe("pos-001");
    expect(out.newPosition.principal).toBe("alice");
    expect(out.superseded).toBeNull();
    expect(out.positions).toHaveLength(1);
    expect(isContested(out.positions)).toBe(false);
  });

  it("assert + qualify does not conflict; assert + dispute does (R-1 rule)", () => {
    const a = pos({ id: "pos-001", principal: "alice", stance: "assert" });
    const q = pos({ id: "pos-002", principal: "bob", stance: "qualify" });
    const d = pos({ id: "pos-003", principal: "bob", stance: "dispute" });
    expect(isContested([a, q])).toBe(false);
    expect(conflictPairs(q, [a, q])).toEqual([]);
    expect(isContested([a, d])).toBe(true);
    expect(conflictPairs(d, [a, d])).toEqual([{ a, b: d }]);
  });

  it("re-assert supersedes only the caller's prior live position (mandated: self-supersession)", () => {
    const a1 = pos({ id: "pos-001", principal: "alice", stance: "assert" });
    const b1 = pos({ id: "pos-002", principal: "bob", stance: "dispute" });
    const out = applyAssert([a1, b1], assertInput);
    expect(out.newPosition.id).toBe("pos-003");
    expect(out.superseded?.id).toBe("pos-001");
    expect(out.positions.find((p) => p.id === "pos-001")?.superseded_by).toBe("pos-003");
    expect(out.positions.find((p) => p.id === "pos-002")).toEqual(b1);
    expect(unsuperseded(out.positions).filter((p) => p.principal === "alice")).toHaveLength(1);
    // Inputs are never mutated.
    expect(a1.superseded_by).toBeNull();
  });

  it("superseding the only dispute un-contests the doc (conflict needs two live sides)", () => {
    const a = pos({ id: "pos-001", principal: "alice", stance: "dispute" });
    const b = pos({ id: "pos-002", principal: "bob", stance: "assert" });
    const out = applyAssert([a, b], { ...assertInput, stance: "qualify" });
    expect(isContested(out.positions)).toBe(false);
  });

  it("id allocation scans max numeric suffix over ALL entries incl. superseded (gaps ok)", () => {
    const set = [
      pos({ id: "pos-001", principal: "x", stance: "assert", superseded_by: "pos-007" }),
      pos({ id: "pos-007", principal: "x", stance: "assert" }),
    ];
    expect(nextPositionId(set)).toBe("pos-008");
    expect(nextPositionId([])).toBe("pos-001");
  });

  it("orders by confidence desc, created desc, id asc (LD-11)", () => {
    const low = pos({ id: "pos-001", principal: "a", stance: "assert", confidence: "low" });
    const highOld = pos({
      id: "pos-002",
      principal: "b",
      stance: "assert",
      confidence: "high",
      created: "2026-01-01",
    });
    const highNew = pos({
      id: "pos-003",
      principal: "c",
      stance: "assert",
      confidence: "high",
      created: "2026-08-01",
    });
    expect([low, highOld, highNew].sort(comparePositions).map((p) => p.id)).toEqual([
      "pos-003",
      "pos-002",
      "pos-001",
    ]);
  });
});

describe("foreignPositionViolation (LD-13)", () => {
  const aliceOld = pos({ id: "pos-001", principal: "alice", stance: "assert" });
  const bobOld = pos({ id: "pos-002", principal: "bob", stance: "dispute" });

  it("removing another principal's entry is a violation", () => {
    expect(foreignPositionViolation([aliceOld, bobOld], [aliceOld], "alice")).toContain("pos-002");
  });

  it("altering another principal's statement is a violation", () => {
    const tampered = { ...bobOld, statement: "reworded" };
    expect(foreignPositionViolation([aliceOld, bobOld], [aliceOld, tampered], "alice")).toContain(
      "pos-002",
    );
  });

  it("appending your own entry + superseding your own prior one is fine", () => {
    const aliceNew = pos({ id: "pos-003", principal: "alice", stance: "assert" });
    const after = [{ ...aliceOld, superseded_by: "pos-003" }, bobOld, aliceNew];
    expect(foreignPositionViolation([aliceOld, bobOld], after, "alice")).toBeNull();
  });

  it("ratify carve-out: foreign superseded_by null→same-principal successor passes; hijack fails", () => {
    const bobNew = pos({ id: "pos-003", principal: "bob", stance: "dispute" });
    const after = [aliceOld, { ...bobOld, superseded_by: "pos-003" }, bobNew];
    // Written by carol (a ratifier replaying bob's staged self-supersession).
    expect(foreignPositionViolation([aliceOld, bobOld], after, "carol")).toBeNull();
    const hijack = [aliceOld, { ...bobOld, superseded_by: "pos-001" }, bobNew];
    expect(foreignPositionViolation([aliceOld, bobOld], hijack, "carol")).toContain("pos-002");
  });

  it("dropping the whole positions key (null incoming) violates when foreign entries existed", () => {
    expect(foreignPositionViolation([bobOld], null, "alice")).toContain("pos-002");
  });
});

describe("legacySnapshot (U-12, LD-22)", () => {
  it("builds the pos-000 snapshot from the prior authored fields", () => {
    const snap = legacySnapshot({
      confidence: "high",
      provenance: "direct",
      valid_from: null,
      updated: "2026-08-01",
    });
    expect(snap).toEqual({
      id: "pos-000",
      principal: "unknown",
      stance: "assert",
      statement: null,
      confidence: "high",
      provenance: "direct",
      valid_from: null,
      superseded_by: null,
      created: "2026-08-01",
      sources: [],
    });
  });

  it("applyAssert over [legacySnapshot(fm)] never lets alice's assert supersede pos-000 (guard 2)", () => {
    const snap = legacySnapshot({
      confidence: "medium",
      provenance: "direct",
      valid_from: null,
      updated: "2026-08-01",
    });
    const out = applyAssert([snap], { ...assertInput, principal: "alice" });
    expect(out.newPosition.id).toBe("pos-001");
    expect(out.superseded).toBeNull();
    expect(out.positions.find((p) => p.id === "pos-000")?.superseded_by).toBeNull();
  });

  it("pos-000 assert + alice assert is not contested; + bob dispute is (snapshot is a live assert side)", () => {
    const snap = legacySnapshot({
      confidence: "medium",
      provenance: "direct",
      valid_from: null,
      updated: "2026-08-01",
    });
    const aliceOut = applyAssert([snap], { ...assertInput, principal: "alice" });
    expect(isContested(aliceOut.positions)).toBe(false);
    const bobDispute = pos({ id: "pos-002", principal: "bob", stance: "dispute" });
    expect(isContested([...aliceOut.positions, bobDispute])).toBe(true);
  });
});

describe("dissentIds (U-10, LD-18)", () => {
  const alice = pos({
    id: "pos-001",
    principal: "alice",
    stance: "assert",
    confidence: "high",
    created: "2026-08-01",
  });
  const bob = pos({
    id: "pos-002",
    principal: "bob",
    stance: "dispute",
    confidence: "medium",
    created: "2026-08-02",
  });
  const carol = pos({ id: "pos-003", principal: "carol", stance: "qualify" });

  it("org stance assert → dissent is the live disputes; dispute → live asserts; qualify → none", () => {
    const set = [alice, bob, carol];
    expect(dissentIds(set, "assert")).toEqual(["pos-002"]);
    expect(dissentIds(set, "dispute")).toEqual(["pos-001"]);
    expect(dissentIds(set, "qualify")).toEqual([]);
  });

  it("a superseded dispute never appears in dissent", () => {
    const supersededBob = { ...bob, superseded_by: "pos-004" };
    expect(dissentIds([alice, supersededBob], "assert")).toEqual([]);
  });

  it("two live disputes → both ids, comparePositions order (confidence desc, created desc, id asc)", () => {
    const bobLow = pos({
      id: "pos-004",
      principal: "bob",
      stance: "dispute",
      confidence: "low",
      created: "2026-08-03",
    });
    const daveHigh = pos({
      id: "pos-005",
      principal: "dave",
      stance: "dispute",
      confidence: "high",
      created: "2026-08-01",
    });
    expect(dissentIds([alice, bob, bobLow, daveHigh], "assert")).toEqual([
      "pos-005",
      "pos-002",
      "pos-004",
    ]);
  });
});
