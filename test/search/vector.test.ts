import { afterEach, describe, expect, it } from "vitest";
import { ok } from "../../src/frontmatter/types.js";
import type { EmbeddingProvider } from "../../src/search/embedding-provider.js";
import {
  type ChunkInput,
  chunkDocument,
  cosineSimilarity,
  EMBED_BATCH_SIZE,
  EMBEDDING_DIM,
  embed,
  embeddingInput,
  embedQuery,
  getProvider,
  getQuantize,
  meanEmbedding,
  resetProviderForTests,
  setProviderForTests,
  toIndexDim,
} from "../../src/search/vector.js";
import { sha256Hex } from "../../src/utils/hash.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
  });

  it("is -1 for opposite vectors", () => {
    expect(cosineSimilarity(new Float32Array([1, 1]), new Float32Array([-1, -1]))).toBeCloseTo(-1);
  });

  it("is 0 for length mismatch or a zero vector", () => {
    expect(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([1]))).toBe(0);
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });
});

// Default input for chunkDocument tests; individual tests override fields.
function baseInput(overrides: Partial<ChunkInput> = {}): ChunkInput {
  return {
    title: "Doc Title",
    collection: "notes",
    tags: [],
    body: "",
    ...overrides,
  };
}

describe("chunkDocument", () => {
  it("returns a single chunk for short text with no headings", () => {
    const chunks = chunkDocument(baseInput({ body: "a short paragraph" }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe("a short paragraph");
  });

  it("splits long text into multiple chunks under the size cap", () => {
    const para = "word ".repeat(400); // ~2000 chars in one paragraph
    const chunks = chunkDocument(baseInput({ body: para }));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 800)).toBe(true);
  });

  it("packs separate paragraphs together when they fit, within a section", () => {
    const chunks = chunkDocument(baseInput({ body: "first para\n\nsecond para" }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe("first para\n\nsecond para");
  });

  it("always returns >=1 chunk for an empty or whitespace-only body", () => {
    expect(chunkDocument(baseInput({ body: "" }))).toHaveLength(1);
    expect(chunkDocument(baseInput({ body: "   \n\n  " }))).toHaveLength(1);
    const chunks = chunkDocument(baseInput({ body: "" }));
    expect(chunks[0]?.text).toBe("");
    expect(chunks[0]?.context).toBe("notes › Doc Title");
  });

  it("splits at ATX headings — a heading boundary always starts a new chunk", () => {
    const body = "# H1\n\nIntro text.\n\n## H2\n\nSection two text.";
    const chunks = chunkDocument(baseInput({ body }));
    // "# H1" and "Intro text." pack together (same section, both short);
    // "## H2" and "Section two text." pack together in the NEXT section.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toBe("# H1\n\nIntro text.");
    expect(chunks[1]?.text).toBe("## H2\n\nSection two text.");
  });

  it("never packs across a section boundary, even when both sections are tiny", () => {
    const body = "## A\n\nx\n\n## B\n\ny";
    const chunks = chunkDocument(baseInput({ body }));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toBe("## A\n\nx");
    expect(chunks[1]?.text).toBe("## B\n\ny");
  });

  it("preamble before the first heading gets its own heading-free chunk", () => {
    const body = "Some intro paragraph.\n\n## Section\n\nBody text.";
    const chunks = chunkDocument(baseInput({ title: "T", collection: "c", body }));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toBe("Some intro paragraph.");
    expect(chunks[0]?.context).toBe("c › T"); // heading-path-free
    expect(chunks[1]?.context).toBe("c › T › Section");
  });

  it("a document that starts with a heading produces no empty preamble chunk", () => {
    const body = "## Section\n\nBody text.";
    const chunks = chunkDocument(baseInput({ body }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe("## Section\n\nBody text.");
  });

  it("tracks the open heading stack across levels: a same/shallower heading replaces deeper ones", () => {
    const body = "# H1\n\n## H2a\n\ntext a\n\n### H3\n\ntext b\n\n## H2b\n\ntext c";
    const chunks = chunkDocument(baseInput({ title: "T", collection: "c", body }));
    const contexts = chunks.map((c) => c.context);
    expect(contexts).toContain("c › T › H1");
    expect(contexts).toContain("c › T › H1 › H2a");
    expect(contexts).toContain("c › T › H1 › H2a › H3");
    // H2b closes the open H3 (and H2a) — its path is H1 › H2b, not
    // H1 › H2a › H3 › H2b.
    expect(contexts).toContain("c › T › H1 › H2b");
  });

  it("a heading line inside a fenced code block is not a heading", () => {
    const body = "intro\n\n```\n# not a heading\n```\n\nafter fence";
    const chunks = chunkDocument(baseInput({ body }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("# not a heading");
    expect(chunks[0]?.context).toBe("notes › Doc Title"); // no heading path
  });

  it("a heading line inside a ~~~ fence is not a heading", () => {
    const body = "intro\n\n~~~\n## also not a heading\n~~~\n\nmore";
    const chunks = chunkDocument(baseInput({ body }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.context).toBe("notes › Doc Title");
  });

  it("H5/H6 and setext headings degrade to plain text (not section boundaries)", () => {
    const body = "intro\n\n##### H5 not real\n\nSetext Title\n===\n\nmore text";
    const chunks = chunkDocument(baseInput({ body }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.context).toBe("notes › Doc Title");
    expect(chunks[0]?.text).toContain("##### H5 not real");
  });

  it("oversized single paragraph hard-splits even within a section", () => {
    const para = "word ".repeat(400);
    const body = `## Big Section\n\n${para}`;
    const chunks = chunkDocument(baseInput({ body }));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.context === "notes › Doc Title › Big Section")).toBe(true);
  });

  describe("breadcrumb context", () => {
    it("shape: {collection} › {title} › {headings} · tags: a, b, c", () => {
      const chunks = chunkDocument(
        baseInput({
          title: "My Doc",
          collection: "pricing",
          tags: ["zeta", "alpha"],
          body: "# Heading One\n\nbody",
        }),
      );
      expect(chunks[0]?.context).toBe("pricing › My Doc › Heading One · tags: alpha, zeta");
    });

    it("omits the tag suffix entirely for an untagged doc", () => {
      const chunks = chunkDocument(baseInput({ tags: [], body: "text" }));
      expect(chunks[0]?.context).not.toContain("tags:");
    });

    it("sorts tags lexicographically before capping at 5", () => {
      const chunks = chunkDocument(
        baseInput({ tags: ["z", "y", "x", "w", "v", "u"], body: "text" }),
      );
      expect(chunks[0]?.context).toContain("tags: u, v, w, x, y");
      expect(chunks[0]?.context).not.toContain(", z");
    });

    it("tag reorder produces an identical breadcrumb (and therefore an identical hash)", () => {
      const a = chunkDocument(baseInput({ tags: ["b", "a", "c"], body: "text" }))[0];
      const b = chunkDocument(baseInput({ tags: ["c", "b", "a"], body: "text" }))[0];
      if (!a || !b) throw new Error("expected a chunk");
      expect(a.context).toBe(b.context);
      expect(sha256Hex(embeddingInput(a))).toBe(sha256Hex(embeddingInput(b)));
    });

    it("caps the whole line at 160 chars, collapsing middle headings first", () => {
      const body =
        "# " +
        "A".repeat(50) +
        "\n\n## " +
        "B".repeat(50) +
        "\n\n### " +
        "C".repeat(50) +
        "\n\ntext";
      const chunks = chunkDocument(baseInput({ title: "Title", collection: "col", body }));
      const ctx = chunks[chunks.length - 1]?.context ?? "";
      expect(ctx.length).toBeLessThanOrEqual(160);
      // Innermost heading (C...) survives; the outer ones collapse to "…".
      expect(ctx).toContain("…");
      expect(ctx).toContain("col");
      expect(ctx).toContain("Title");
    });

    it("collection and title always survive as components even under extreme truncation", () => {
      const chunks = chunkDocument(
        baseInput({
          title: "T",
          collection: "c",
          tags: Array.from({ length: 5 }, (_, i) => `tag-${i}-${"x".repeat(30)}`),
          body: `# ${"H".repeat(200)}\n\ntext`,
        }),
      );
      const ctx = chunks[chunks.length - 1]?.context ?? "";
      expect(ctx.length).toBeLessThanOrEqual(160);
      expect(ctx.startsWith("c › T")).toBe(true);
    });
  });

  describe("embeddingInput", () => {
    it("concatenates context and text with a blank line", () => {
      const chunks = chunkDocument(baseInput({ body: "hello world" }));
      const chunk = chunks[0];
      if (!chunk) throw new Error("expected a chunk");
      expect(embeddingInput(chunk)).toBe(`${chunk.context}\n\n${chunk.text}`);
    });

    it("falls back to bare text when context is empty", () => {
      expect(embeddingInput({ context: "", text: "just text" })).toBe("just text");
    });
  });
});

describe("meanEmbedding", () => {
  it("averages component-wise", () => {
    const mean = meanEmbedding([new Float32Array([1, 0]), new Float32Array([0, 1])]);
    expect(mean && [...mean]).toEqual([0.5, 0.5]);
  });

  it("returns null for an empty input", () => {
    expect(meanEmbedding([])).toBeNull();
  });
});

describe("toIndexDim", () => {
  it("is identity (a fresh copy) when the vector is already at the target dim", () => {
    const v = new Float32Array([0.6, 0.8]);
    const out = toIndexDim(v, 2);
    expect(out[0]).toBeCloseTo(0.6, 5);
    expect(out[1]).toBeCloseTo(0.8, 5);
    expect(out).not.toBe(v); // fresh array, not the same reference
  });

  it("slices and re-L2-normalizes when truncating", () => {
    // A unit vector in 4d; truncating to 2d and renormalizing must still be
    // unit length, and the truncated components must be proportional to the
    // original's.
    const v = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    const out = toIndexDim(v, 2);
    expect(out.length).toBe(2);
    let norm = 0;
    for (const x of out) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 6);
    expect(out[0]).toBeCloseTo(out[1] as number, 6); // proportionality preserved
  });
});

describe("provider selection", () => {
  afterEach(() => {
    resetProviderForTests();
  });

  it("getQuantize() defaults to float32 after a reset", () => {
    expect(getQuantize()).toBe("float32");
  });

  it("swaps the active provider when dim changes on an unchanged provider id", async () => {
    resetProviderForTests();
    const { setProvider } = await import("../../src/search/vector.js");
    setProvider("local-embeddinggemma", { dim: 512 });
    const first = getProvider();
    expect(first.dim).toBe(512);
    setProvider("local-embeddinggemma", { dim: 512 }); // repeated tuple: no-op
    expect(getProvider()).toBe(first);
    setProvider("local-embeddinggemma", { dim: 768 }); // dim flip: must swap
    const second = getProvider();
    expect(second.dim).toBe(768);
    expect(second).not.toBe(first);
  });

  it("swaps activeQuantize when quantize changes even though (id, dim) is unchanged", async () => {
    resetProviderForTests();
    const { setProvider } = await import("../../src/search/vector.js");
    setProvider("local-embeddinggemma", { dim: 512, quantize: "none" });
    const providerA = getProvider();
    expect(getQuantize()).toBe("float32");
    setProvider("local-embeddinggemma", { dim: 512, quantize: "int8" });
    expect(getProvider()).toBe(providerA); // same cached instance — id/dim unchanged
    expect(getQuantize()).toBe("int8"); // but the quantize STATE must have swapped
  });

  it("resetProviderForTests reverts to local-minilm and quantize=float32", async () => {
    const { setProvider } = await import("../../src/search/vector.js");
    setProvider("local-embeddinggemma", { dim: 512, quantize: "int8" });
    resetProviderForTests();
    expect(getProvider().id).toBe("local-minilm");
    expect(getQuantize()).toBe("float32");
  });
});

function fakeProvider(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    id: "fake-provider",
    dim: 4,
    async embed(texts) {
      return ok(texts.map(() => new Float32Array([1, 0, 0, 0])));
    },
    async warm() {
      return ok(undefined);
    },
    ...overrides,
  };
}

describe("embedQuery (module-level delegation)", () => {
  afterEach(() => {
    resetProviderForTests();
  });

  it("falls back to embed([text]) + toIndexDim when the provider has no embedQuery", async () => {
    setProviderForTests(fakeProvider());
    const result = await embedQuery("anything");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value]).toEqual([1, 0, 0, 0]);
  });

  it("delegates directly to the provider's own embedQuery when present", async () => {
    const queryVec = new Float32Array([0, 1, 0, 0]);
    setProviderForTests(
      fakeProvider({
        async embedQuery() {
          return ok(queryVec);
        },
      }),
    );
    const result = await embedQuery("anything");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(queryVec); // exactly the provider's own return, untouched
  });

  it("propagates a provider embed() failure as Result.err", async () => {
    const { err } = await import("../../src/frontmatter/types.js");
    setProviderForTests(
      fakeProvider({
        async embed() {
          return err(new Error("boom"));
        },
      }),
    );
    const result = await embedQuery("anything");
    expect(result.ok).toBe(false);
  });
});

describe("embed", () => {
  it("returns an empty array for empty input without loading the model", async () => {
    const result = await embed([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("embeds text and places semantically similar sentences closer", async () => {
    const result = await embed([
      "a cat sat on the mat",
      "a kitten rested on the rug",
      "quarterly cloud infrastructure budget forecast",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [catA, catB, budget] = result.value;
    if (!catA || !catB || !budget) throw new Error("expected three embeddings");
    expect(catA.length).toBe(EMBEDDING_DIM);
    const similar = cosineSimilarity(catA, catB);
    const dissimilar = cosineSimilarity(catA, budget);
    expect(similar).toBeGreaterThan(dissimilar);
  }, 60_000);

  it("embeds inputs spanning multiple batches and reports incremental progress", async () => {
    const n = EMBED_BATCH_SIZE * 2 + 5;
    const texts = Array.from({ length: n }, (_, i) => `progress probe sentence number ${i}`);
    const calls: Array<[number, number]> = [];
    const result = await embed(texts, (done, total) => calls.push([done, total]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(n);
    expect(result.value.every((v) => v.length === EMBEDDING_DIM)).toBe(true);

    // Batching is observable through progress: more than one callback, the
    // final call reports completion, and `done` is strictly increasing.
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[calls.length - 1]).toEqual([n, n]);
    expect(calls.every(([done], i) => i === 0 || done > (calls[i - 1]?.[0] ?? 0))).toBe(true);
    expect(calls.every(([, total]) => total === n)).toBe(true);
  }, 60_000);
});
