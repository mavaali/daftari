import { describe, expect, it } from "vitest";
import { buildGraph, type GraphDoc, type GraphInput } from "../../src/view/graph.js";

function doc(path: string, extra: Partial<GraphDoc> = {}): GraphDoc {
  return {
    path,
    title: extra.title ?? path,
    collection: extra.collection ?? "c",
    tier: extra.tier ?? null,
    status: extra.status ?? "draft",
  };
}

function baseInput(over: Partial<GraphInput> = {}): GraphInput {
  return {
    docs: over.docs ?? [doc("a.md"), doc("b.md"), doc("c.md")],
    reverseSource: over.reverseSource ?? new Map(),
    reverseLink: over.reverseLink ?? new Map(),
    derivesEdges: over.derivesEdges ?? [],
    contestedPairs: over.contestedPairs ?? [],
    decayed: over.decayed ?? new Set(),
  };
}

describe("buildGraph (R5/R8)", () => {
  it("emits forward source/link edges from reverse maps, endpoints restricted to known docs", () => {
    const g = buildGraph(
      baseInput({
        // target b.md is cited by a.md (source) and linked by c.md (link)
        reverseSource: new Map([["b.md", ["a.md", "ghost.md"]]]),
        reverseLink: new Map([["b.md", ["c.md"]]]),
      }),
      { scope: "all" },
    );
    expect(g.edges).toContainEqual({ from: "a.md", to: "b.md", kind: "source" });
    expect(g.edges).toContainEqual({ from: "c.md", to: "b.md", kind: "link" });
    // dangling referrer to an unknown doc is dropped
    expect(g.edges.find((e) => e.from === "ghost.md")).toBeUndefined();
  });

  it("carries derives_from and contested edges; flags contested nodes", () => {
    const g = buildGraph(
      baseInput({
        derivesEdges: [{ from: "a.md", to: "b.md" }],
        contestedPairs: [{ a: "c.md", b: "a.md" }],
      }),
      { scope: "all" },
    );
    expect(g.edges).toContainEqual({ from: "a.md", to: "b.md", kind: "derives_from" });
    // contested edge is canonicalized (a<c) for stable dedupe
    expect(g.edges).toContainEqual({ from: "a.md", to: "c.md", kind: "contested" });
    expect(g.nodes.find((n) => n.path === "a.md")?.contested).toBe(true);
    expect(g.nodes.find((n) => n.path === "b.md")?.contested).toBe(false);
  });

  it("marks decayed nodes from the decayed set", () => {
    const g = buildGraph(baseInput({ decayed: new Set(["b.md"]) }), { scope: "all" });
    expect(g.nodes.find((n) => n.path === "b.md")?.decayed).toBe(true);
    expect(g.nodes.find((n) => n.path === "a.md")?.decayed).toBe(false);
  });

  it("ego scope returns only the neighborhood of root to depth", () => {
    // chain a - b - c - d ; ego(a, depth 1) => {a,b}
    const input = baseInput({
      docs: [doc("a.md"), doc("b.md"), doc("c.md"), doc("d.md")],
      reverseLink: new Map([
        ["b.md", ["a.md"]],
        ["c.md", ["b.md"]],
        ["d.md", ["c.md"]],
      ]),
    });
    const g1 = buildGraph(input, { scope: "ego", root: "a.md", depth: 1 });
    expect(new Set(g1.nodes.map((n) => n.path))).toEqual(new Set(["a.md", "b.md"]));
    const g2 = buildGraph(input, { scope: "ego", root: "a.md", depth: 2 });
    expect(new Set(g2.nodes.map((n) => n.path))).toEqual(new Set(["a.md", "b.md", "c.md"]));
  });

  it("ego scope on an unknown root yields an empty graph, not a throw", () => {
    const g = buildGraph(baseInput(), { scope: "ego", root: "nope.md", depth: 2 });
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
  });

  it("caps large graphs and reports truncation (R8), keeping highest-degree nodes", () => {
    const docs = Array.from({ length: 10 }, (_, i) => doc(`n${i}.md`));
    // n0 is a hub linked by everyone; the rest are leaves
    const reverseLink = new Map<string, string[]>([["n0.md", docs.slice(1).map((d) => d.path)]]);
    const g = buildGraph(baseInput({ docs, reverseLink }), { scope: "all", cap: 5 });
    expect(g.truncated).toBe(true);
    expect(g.total).toBe(10);
    expect(g.shown).toBe(5);
    expect(g.nodes).toHaveLength(5);
    // the hub survives the degree-ranked cap
    expect(g.nodes.find((n) => n.path === "n0.md")).toBeDefined();
    // no edge references a dropped node
    const kept = new Set(g.nodes.map((n) => n.path));
    for (const e of g.edges) {
      expect(kept.has(e.from)).toBe(true);
      expect(kept.has(e.to)).toBe(true);
    }
  });

  it("empty vault yields an empty graph (R8 degrade)", () => {
    const g = buildGraph(baseInput({ docs: [] }), { scope: "all" });
    expect(g).toEqual({ nodes: [], edges: [], total: 0, shown: 0, truncated: false });
  });
});
