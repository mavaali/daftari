import { describe, expect, it } from "vitest";
import { type EmbedFn, rankQuestionCandidates } from "../../src/curation/question-candidates.js";
import { collectOpenQuestions, normalizeQuestion } from "../../src/curation/questions.js";
import type { LoadedDoc } from "../../src/curation/vault-docs.js";
import { err, type Frontmatter, ok } from "../../src/frontmatter/types.js";

function doc(path: string, fm: Partial<Frontmatter>): LoadedDoc {
  return {
    path,
    content: "",
    frontmatter: {
      title: path,
      status: "draft",
      created: "2026-01-01",
      updated: "2026-01-01",
      questions_answered: [],
      questions_raised: [],
      ...fm,
    } as Frontmatter,
    validation: { valid: true, errors: [], warnings: [] } as unknown as LoadedDoc["validation"],
  };
}

// Vectors keyed by marker word, so "closest in meaning" is exact and needs no
// model: texts sharing a marker are identical, everything else is orthogonal.
const MARKERS = ["pricing", "tiers", "cost", "region"];
const SYNONYMS: Record<string, string> = { charge: "pricing", levels: "tiers" };

function markerEmbed(): EmbedFn {
  return async (texts) =>
    ok(
      texts.map((t) => {
        const vec = new Float32Array(MARKERS.length + 1);
        const words = t.toLowerCase().split(/\W+/);
        for (const w of words) {
          const i = MARKERS.indexOf(SYNONYMS[w] ?? w);
          if (i >= 0) vec[i] = 1;
        }
        if (vec.every((v) => v === 0)) vec[MARKERS.length] = 1;
        return vec;
      }),
    );
}

const failingEmbed: EmbedFn = async () => err(new Error("model unavailable"));

describe("collectOpenQuestions", () => {
  it("merges duplicate raisings, skips answered and retired raisers", () => {
    const open = collectOpenQuestions([
      doc("a.md", { questions_raised: ["What is  the price?", "Closed?"] }),
      doc("b.md", { questions_raised: ["what is the price?"] }),
      doc("c.md", { status: "superseded", questions_raised: ["Retired curiosity?"] }),
      doc("d.md", { status: "deprecated", questions_answered: ["closed?"] }),
    ]);
    expect(open).toEqual([
      {
        key: normalizeQuestion("what is the price?"),
        text: "What is  the price?",
        raisedBy: ["a.md", "b.md"],
      },
    ]);
  });
});

describe("rankQuestionCandidates", () => {
  const raiser = doc("raiser.md", {
    created: "2026-02-01",
    questions_raised: ["How do we charge per seat?"],
  });

  it("finds a question reworded in a later document's questions_answered", async () => {
    const docs = [
      raiser,
      doc("noise-1.md", { updated: "2026-03-01", title: "Region rollout" }),
      doc("ruling.md", {
        updated: "2026-03-01",
        title: "Unrelated ruling title",
        questions_answered: ["What is our seat pricing?"],
      }),
      doc("noise-2.md", { updated: "2026-03-01", questions_answered: ["Which tiers exist?"] }),
    ];
    const result = await rankQuestionCandidates(collectOpenQuestions(docs), docs, {
      top: 3,
      embed: markerEmbed(),
    });
    expect(result.vectorUsed).toBe(true);
    const [first] = result.questions[0]?.candidates ?? [];
    expect(first).toMatchObject({
      path: "ruling.md",
      matchedField: "questions_answered",
      matchedText: "What is our seat pricing?",
    });
  });

  it("matches on a later document's title", async () => {
    const docs = [raiser, doc("titled.md", { updated: "2026-03-01", title: "Pricing ruling" })];
    const result = await rankQuestionCandidates(collectOpenQuestions(docs), docs, {
      top: 3,
      embed: markerEmbed(),
    });
    expect(result.questions[0]?.candidates[0]).toMatchObject({
      path: "titled.md",
      matchedField: "title",
      matchedText: "Pricing ruling",
    });
  });

  it("excludes the raiser, a retired co-raiser, and documents last touched before the raising", async () => {
    const docs = [
      raiser,
      doc("old-raiser.md", {
        status: "deprecated",
        updated: "2026-03-01",
        questions_raised: ["How do we charge per seat?"],
        title: "Pricing retired",
      }),
      doc("earlier.md", { updated: "2026-01-15", title: "Pricing earlier" }),
      doc("same-day.md", { updated: "2026-02-01", title: "Pricing same day" }),
    ];
    const result = await rankQuestionCandidates(collectOpenQuestions(docs), docs, {
      top: 3,
      embed: markerEmbed(),
    });
    expect(result.questions[0]?.candidates.map((c) => c.path)).toEqual(["same-day.md"]);
  });

  it("uses the earliest raising across duplicate raisers", async () => {
    const docs = [
      doc("first.md", { created: "2026-01-10", questions_raised: ["Pricing?"] }),
      doc("second.md", { created: "2026-05-01", questions_raised: ["Pricing?"] }),
      doc("between.md", { updated: "2026-02-01", title: "Pricing note" }),
    ];
    const result = await rankQuestionCandidates(collectOpenQuestions(docs), docs, {
      top: 3,
      embed: markerEmbed(),
    });
    expect(result.questions[0]?.candidates.map((c) => c.path)).toEqual(["between.md"]);
  });

  it("keeps undateable candidates eligible rather than silently dropping them", async () => {
    const docs = [raiser, doc("undated.md", { updated: "someday", title: "Pricing note" })];
    const result = await rankQuestionCandidates(collectOpenQuestions(docs), docs, {
      top: 3,
      embed: markerEmbed(),
    });
    expect(result.questions[0]?.candidates.map((c) => c.path)).toEqual(["undated.md"]);
  });

  it("keeps a retired candidate and shows its status: an answer anywhere stays an answer", async () => {
    const docs = [
      raiser,
      doc("old.md", { status: "superseded", updated: "2026-03-01", title: "Pricing old" }),
    ];
    const result = await rankQuestionCandidates(collectOpenQuestions(docs), docs, {
      top: 3,
      embed: markerEmbed(),
    });
    expect(result.questions[0]?.candidates[0]).toMatchObject({
      path: "old.md",
      status: "superseded",
    });
  });

  it("caps candidates at top and orders ties newest first, then by path", async () => {
    const docs = [
      raiser,
      doc("b.md", { updated: "2026-03-01", title: "Pricing" }),
      doc("a.md", { updated: "2026-03-01", title: "Pricing" }),
      doc("c.md", { updated: "2026-04-01", title: "Pricing" }),
    ];
    const result = await rankQuestionCandidates(collectOpenQuestions(docs), docs, {
      top: 2,
      embed: markerEmbed(),
    });
    expect(result.questions[0]?.candidates.map((c) => c.path)).toEqual(["c.md", "a.md"]);
  });

  it("falls back to lexical overlap when embedding fails, and reports it", async () => {
    const docs = [
      doc("q.md", { created: "2026-02-01", questions_raised: ["What is the Cirrus seat price?"] }),
      doc("hit.md", {
        updated: "2026-03-01",
        questions_answered: ["How much is a Cirrus seat?"],
      }),
      doc("wordy.md", { updated: "2026-03-01", title: "What is this document?" }),
    ];
    const result = await rankQuestionCandidates(collectOpenQuestions(docs), docs, {
      top: 3,
      embed: failingEmbed,
    });
    expect(result.vectorUsed).toBe(false);
    expect(result.questions[0]?.candidates.map((c) => c.path)).toEqual(["hit.md"]);
  });

  it("treats a wrong-sized embedding result as a failure", async () => {
    const docs = [raiser, doc("titled.md", { updated: "2026-03-01", title: "seat notes" })];
    const result = await rankQuestionCandidates(collectOpenQuestions(docs), docs, {
      top: 3,
      embed: async () => ok([new Float32Array([1])]),
    });
    expect(result.vectorUsed).toBe(false);
  });

  it("spends nothing when there are no questions to rank", async () => {
    let called = false;
    const result = await rankQuestionCandidates([], [raiser], {
      top: 3,
      embed: async (texts) => {
        called = true;
        return ok(texts.map(() => new Float32Array(1)));
      },
    });
    expect(called).toBe(false);
    expect(result.questions).toEqual([]);
  });
});
