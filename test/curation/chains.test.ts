import { describe, expect, it } from "vitest";
import { type ChainDoc, computeChains } from "../../src/curation/chains.js";

function doc(path: string, supersededBy: string | null = null, status = "canonical"): ChainDoc {
  return {
    path,
    collection: path.split("/")[0] ?? "",
    status,
    updated: "2026-11-01",
    supersededBy,
  };
}

const everyone = () => true;
const collectionIs =
  (...collections: string[]) =>
  (d: ChainDoc) =>
    collections.includes(d.collection);

describe("computeChains", () => {
  it("lists no chain for documents outside any supersede relation", () => {
    expect(computeChains([doc("a/one.md"), doc("a/two.md")], everyone)).toEqual([]);
  });

  it("reports the end of a linear chain with every entry it replaced", () => {
    const chains = computeChains(
      [doc("a/v1.md", "a/v2.md", "superseded"), doc("a/v2.md", "a/v3.md"), doc("a/v3.md")],
      everyone,
    );
    expect(chains).toEqual([
      {
        head: { path: "a/v3.md", status: "canonical", updated: "2026-11-01" },
        replaced: [
          { path: "a/v2.md", status: "canonical", updated: "2026-11-01", depth: 1 },
          { path: "a/v1.md", status: "superseded", updated: "2026-11-01", depth: 2 },
        ],
        hidden_replaced: "none",
        flags: [],
      },
    ]);
  });

  it("collapses merge fan-in into one chain, flat with depth", () => {
    const chains = computeChains(
      [doc("a/left.md", "a/merged.md"), doc("a/right.md", "a/merged.md"), doc("a/merged.md")],
      everyone,
    );
    expect(chains).toHaveLength(1);
    expect(chains[0]?.replaced.map((r) => [r.path, r.depth])).toEqual([
      ["a/left.md", 1],
      ["a/right.md", 1],
    ]);
  });

  it("orders chains by head path", () => {
    const chains = computeChains(
      [doc("b/old.md", "b/new.md"), doc("b/new.md"), doc("a/old.md", "a/new.md"), doc("a/new.md")],
      everyone,
    );
    expect(chains.map((c) => c.head?.path)).toEqual(["a/new.md", "b/new.md"]);
  });

  // The shape of the audit in #642: 295 documents, 22 chains replacing 29.
  it("resolves every chain end of a vault the audited size in one call", () => {
    const longChains = Array.from({ length: 7 }, (_, n) => [
      doc(`long/${n}-v1.md`, `long/${n}-v2.md`),
      doc(`long/${n}-v2.md`, `long/${n}-v3.md`),
      doc(`long/${n}-v3.md`),
    ]);
    const shortChains = Array.from({ length: 15 }, (_, n) => [
      doc(`short/${n}-v1.md`, `short/${n}-v2.md`),
      doc(`short/${n}-v2.md`),
    ]);
    const bystanders = Array.from({ length: 244 }, (_, n) => doc(`misc/${n}.md`));
    const docs = [...longChains.flat(), ...shortChains.flat(), ...bystanders];
    expect(docs).toHaveLength(295);

    const chains = computeChains(docs, everyone);
    expect(chains).toHaveLength(22);
    expect(chains.reduce((sum, c) => sum + c.replaced.length, 0)).toBe(29);
  });

  describe("flags", () => {
    it("flags a chain that ends in a draft", () => {
      const [chain] = computeChains(
        [doc("a/old.md", "a/new.md"), doc("a/new.md", null, "draft")],
        everyone,
      );
      expect(chain?.flags).toEqual(["draft"]);
      expect(chain?.head?.status).toBe("draft");
    });

    it.each(["deprecated", "archived"])("flags a chain that ends in a %s doc", (status) => {
      const [chain] = computeChains(
        [doc("a/old.md", "a/new.md"), doc("a/new.md", null, status)],
        everyone,
      );
      expect(chain?.flags).toEqual(["retired"]);
    });

    it("flags a pointer at a missing document, with the last real doc as head", () => {
      const chains = computeChains(
        [doc("a/v1.md", "a/v2.md"), doc("a/v2.md", "a/gone.md", "superseded")],
        everyone,
      );
      expect(chains).toHaveLength(1);
      expect(chains[0]?.head?.path).toBe("a/v2.md");
      expect(chains[0]?.replaced.map((r) => r.path)).toEqual(["a/v1.md"]);
      expect(chains[0]?.flags).toEqual(["dangling"]);
    });

    it("lists a lone dangling document as a chain of one", () => {
      const chains = computeChains([doc("a/lone.md", "a/gone.md", "superseded")], everyone);
      expect(chains[0]?.head?.path).toBe("a/lone.md");
      expect(chains[0]?.replaced).toEqual([]);
      expect(chains[0]?.flags).toEqual(["dangling"]);
    });

    it("flags a head whose status says superseded with no pointer forward", () => {
      const chains = computeChains(
        [doc("a/old.md", "a/mid.md"), doc("a/mid.md", null, "superseded")],
        everyone,
      );
      expect(chains[0]?.head?.path).toBe("a/mid.md");
      expect(chains[0]?.flags).toEqual(["unforwarded"]);
    });

    it("lists an unforwarded document with no predecessors", () => {
      const chains = computeChains([doc("a/orphan.md", null, "superseded")], everyone);
      expect(chains[0]?.head?.path).toBe("a/orphan.md");
      expect(chains[0]?.flags).toEqual(["unforwarded"]);
    });

    it("does not list a lone retired document: nothing was replaced", () => {
      expect(computeChains([doc("a/gone.md", null, "deprecated")], everyone)).toEqual([]);
    });
  });

  describe("loops", () => {
    it("reports a two-document loop with no head and terminates", () => {
      const chains = computeChains([doc("a/x.md", "a/y.md"), doc("a/y.md", "a/x.md")], everyone);
      expect(chains).toHaveLength(1);
      expect(chains[0]?.head).toBeNull();
      expect(chains[0]?.flags).toEqual(["loop"]);
      expect(chains[0]?.replaced.map((r) => [r.path, r.depth])).toEqual([
        ["a/x.md", 0],
        ["a/y.md", 0],
      ]);
    });

    it("reports a self-loop", () => {
      const chains = computeChains([doc("a/self.md", "a/self.md")], everyone);
      expect(chains).toHaveLength(1);
      expect(chains[0]?.flags).toEqual(["loop"]);
    });

    it("folds a tail into its loop, depth counted in hops to the loop", () => {
      const chains = computeChains(
        [doc("a/tail.md", "a/x.md"), doc("a/x.md", "a/y.md"), doc("a/y.md", "a/x.md")],
        everyone,
      );
      expect(chains).toHaveLength(1);
      expect(chains[0]?.replaced.map((r) => [r.path, r.depth])).toEqual([
        ["a/x.md", 0],
        ["a/y.md", 0],
        ["a/tail.md", 1],
      ]);
    });

    it("sorts headless chains after headed ones", () => {
      const chains = computeChains(
        [
          doc("a/x.md", "a/y.md"),
          doc("a/y.md", "a/x.md"),
          doc("z/old.md", "z/new.md"),
          doc("z/new.md"),
        ],
        everyone,
      );
      expect(chains.map((c) => c.head?.path ?? null)).toEqual(["z/new.md", null]);
    });
  });

  describe("visibility", () => {
    it("lists readable predecessors and coarsens unreadable ones", () => {
      const chains = computeChains(
        [doc("pub/old.md", "pub/new.md"), doc("hidden/old.md", "pub/new.md"), doc("pub/new.md")],
        collectionIs("pub"),
      );
      expect(chains).toHaveLength(1);
      expect(chains[0]?.replaced.map((r) => r.path)).toEqual(["pub/old.md"]);
      expect(chains[0]?.hidden_replaced).toBe("some");
    });

    it("reports 'many' at the threshold, never an exact count", () => {
      const hidden = [1, 2, 3, 4, 5].map((n) => doc(`hidden/${n}.md`, "pub/new.md"));
      const [chain] = computeChains([...hidden, doc("pub/new.md")], collectionIs("pub"));
      expect(chain?.hidden_replaced).toBe("many");
    });

    it("lists a readable head whose every predecessor is hidden", () => {
      const chains = computeChains(
        [doc("hidden/old.md", "pub/new.md"), doc("pub/new.md")],
        collectionIs("pub"),
      );
      expect(chains[0]?.head?.path).toBe("pub/new.md");
      expect(chains[0]?.replaced).toEqual([]);
      expect(chains[0]?.hidden_replaced).toBe("some");
    });

    it("withholds an unreadable head and every flag derived from its status", () => {
      const chains = computeChains(
        [doc("pub/old.md", "hidden/new.md"), doc("hidden/new.md", null, "draft")],
        collectionIs("pub"),
      );
      expect(chains).toHaveLength(1);
      expect(chains[0]?.head).toBeNull();
      expect(chains[0]?.flags).toEqual(["restricted"]);
      expect(chains[0]?.replaced.map((r) => r.path)).toEqual(["pub/old.md"]);
    });

    it("does not stitch across an unreadable middle hop", () => {
      const chains = computeChains(
        [doc("pub/v1.md", "hidden/v2.md"), doc("hidden/v2.md", "pub/v3.md"), doc("pub/v3.md")],
        collectionIs("pub"),
      );
      expect(chains).toHaveLength(2);
      expect(chains[0]).toMatchObject({
        head: { path: "pub/v3.md" },
        replaced: [],
        hidden_replaced: "some",
        flags: [],
      });
      expect(chains[1]).toMatchObject({ head: null, flags: ["restricted"] });
      expect(chains[1]?.replaced.map((r) => [r.path, r.depth])).toEqual([["pub/v1.md", 1]]);
    });

    it("omits a chain the caller can read none of", () => {
      const chains = computeChains(
        [doc("hidden/old.md", "hidden/new.md"), doc("hidden/new.md")],
        collectionIs("pub"),
      );
      expect(chains).toEqual([]);
    });

    it("downgrades a loop with an unreadable member to restricted", () => {
      const chains = computeChains(
        [doc("pub/x.md", "hidden/y.md"), doc("hidden/y.md", "pub/x.md")],
        collectionIs("pub"),
      );
      expect(chains).toHaveLength(1);
      expect(chains[0]?.head).toBeNull();
      expect(chains[0]?.flags).toEqual(["restricted"]);
      expect(chains[0]?.replaced.map((r) => r.path)).toEqual(["pub/x.md"]);
    });

    it("keeps the loop flag when only a tail is unreadable", () => {
      const chains = computeChains(
        [
          doc("hidden/tail.md", "pub/x.md"),
          doc("pub/x.md", "pub/y.md"),
          doc("pub/y.md", "pub/x.md"),
        ],
        collectionIs("pub"),
      );
      expect(chains).toHaveLength(1);
      expect(chains[0]?.flags).toEqual(["loop"]);
      expect(chains[0]?.hidden_replaced).toBe("some");
    });

    it("counts a hidden document once against a loop it feeds", () => {
      const hidden = [1, 2, 3, 4].map((n) => doc(`hidden/${n}.md`, "pub/x.md"));
      const [chain] = computeChains(
        [...hidden, doc("pub/x.md", "pub/y.md"), doc("pub/y.md", "pub/x.md")],
        collectionIs("pub"),
      );
      expect(chain?.hidden_replaced).toBe("some");
    });

    it("sorts restricted chains by a readable path, never the hidden one", () => {
      const chains = computeChains(
        [
          doc("pub/b.md", "hidden/a.md"),
          doc("hidden/a.md"),
          doc("pub/a.md", "hidden/z.md"),
          doc("hidden/z.md"),
        ],
        collectionIs("pub"),
      );
      expect(chains.map((c) => c.replaced[0]?.path)).toEqual(["pub/a.md", "pub/b.md"]);
    });
  });
});
