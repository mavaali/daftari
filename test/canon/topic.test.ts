import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { topicEgoGraph, topicEgoGraphFrom } from "../../src/canon/topic.js";
import { contestEdge, observeEdge } from "../../src/curation/edges.js";
import { addTension } from "../../src/curation/tension.js";

describe("topicEgoGraphFrom (pure, no vault)", () => {
  it("includes seed + tension neighbor and active edge neighbor", () => {
    // Tensions: A–B. Active edge: A→C. Revoked edge: A→D.
    // Seed A, depth 1 → {A, B, C}. D must be excluded (revoked).
    const tensions = [{ sourceA: "A.md", sourceB: "B.md" }];
    const edges = [
      { fromPath: "A.md", toPath: "C.md", status: "observed" },
      { fromPath: "A.md", toPath: "D.md", status: "revoked" },
    ];

    const result = topicEgoGraphFrom(tensions, edges, "A.md", 1);
    const set = new Set(result);

    expect(set.has("A.md")).toBe(true);
    expect(set.has("B.md")).toBe(true);
    expect(set.has("C.md")).toBe(true);
    // Revoked edge must not create a link.
    expect(set.has("D.md")).toBe(false);
  });

  it("does not traverse beyond the given depth", () => {
    // Chain: A–B–C (via tensions). Seed A, depth 1 → {A, B}; C is two hops away.
    const tensions = [
      { sourceA: "A.md", sourceB: "B.md" },
      { sourceA: "B.md", sourceB: "C.md" },
    ];

    const result = topicEgoGraphFrom(tensions, [], "A.md", 1);
    const set = new Set(result);

    expect(set.has("A.md")).toBe(true);
    expect(set.has("B.md")).toBe(true);
    expect(set.has("C.md")).toBe(false);
  });
});

describe("topicEgoGraph", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-canon-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("includes seed + direct tension neighbor, excludes depth-3 nodes", async () => {
    // A—B tension, B—C tension, C—D tension. Seed A, depth 2 ⇒ {A,B,C}, not D.
    await addTension(vault, {
      title: "t1",
      kind: "factual",
      sourceA: "A.md",
      claimA: "p",
      sourceB: "B.md",
      claimB: "¬p",
      loggedBy: "test",
    });
    await addTension(vault, {
      title: "t2",
      kind: "factual",
      sourceA: "B.md",
      claimA: "p",
      sourceB: "C.md",
      claimB: "¬p",
      loggedBy: "test",
    });
    await addTension(vault, {
      title: "t3",
      kind: "factual",
      sourceA: "C.md",
      claimA: "p",
      sourceB: "D.md",
      claimB: "¬p",
      loggedBy: "test",
    });

    const res = await topicEgoGraph(vault, "A.md", 2);
    expect(res.ok).toBe(true);
    const set = res.ok ? new Set(res.value) : new Set();
    expect(set).toEqual(new Set(["A.md", "B.md", "C.md"]));
    expect(set.has("D.md")).toBe(false);
  });

  it("traverses derives_from edges and excludes revoked ones", async () => {
    // Seed X→Y (active) and X→Z (then revoked). Seed X, depth 1 ⇒ {X,Y}, not Z.
    await observeEdge(vault, {
      fromPath: "X.md",
      toPath: "Y.md",
      observedBy: "test",
      blind: false,
    });
    await observeEdge(vault, {
      fromPath: "X.md",
      toPath: "Z.md",
      observedBy: "test",
      blind: false,
    });
    await contestEdge(vault, {
      fromPath: "X.md",
      toPath: "Z.md",
      contestedBy: "test",
      reason: "re-derivation failed",
    });

    const res = await topicEgoGraph(vault, "X.md", 1);
    expect(res.ok).toBe(true);
    const set = res.ok ? new Set(res.value) : new Set();
    expect(set.has("Y.md")).toBe(true);
    expect(set.has("Z.md")).toBe(false);
  });
});
