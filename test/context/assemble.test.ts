// Pure-function tests for src/context/assemble.ts (spec 2026-07-26-context-
// packs-progressive-disclosure-design.md, final plan Phase 2.7 / C6).
//
// No database, no fixture vault, no golden-brief byte pin — determinism is
// proven by calling the assembler twice on the same in-memory PackEntry[]
// and comparing outputs to each other (C6).

import { describe, expect, it } from "vitest";
import { assembleContextPack, type PackEntry } from "../../src/context/assemble.js";

function entry(overrides: Partial<PackEntry> & Pick<PackEntry, "path" | "score">): PackEntry {
  return {
    title: overrides.path,
    reason: "matches task",
    snippet: "a short snippet",
    ...overrides,
  };
}

describe("assembleContextPack — determinism (C6)", () => {
  it("calling twice on the same input produces byte-identical output", () => {
    const entries: PackEntry[] = [
      entry({ path: "a.md", score: 0.9, snippet: "alpha" }),
      entry({ path: "b.md", score: 0.5, snippet: "beta" }),
    ];
    const a = assembleContextPack("do the thing", 4000, entries, "none");
    const b = assembleContextPack("do the thing", 4000, entries, "none");
    expect(a).toEqual(b);
    expect(a.brief).toBe(b.brief);
  });
});

describe("assembleContextPack — budget cut", () => {
  it("never returns a brief whose estimated tokens exceed the stated budget", () => {
    const entries: PackEntry[] = Array.from({ length: 8 }, (_, i) =>
      entry({ path: `doc-${i}.md`, score: 8 - i, snippet: "x".repeat(300) }),
    );
    for (const budget of [500, 1000, 2000, 4000]) {
      const pack = assembleContextPack("task", budget, entries, "none");
      expect(pack.estimatedTokens, `budget=${budget}`).toBeLessThanOrEqual(budget);
    }
  });

  it("a larger budget never includes fewer entries than a smaller one", () => {
    const entries: PackEntry[] = Array.from({ length: 8 }, (_, i) =>
      entry({ path: `doc-${i}.md`, score: 8 - i, snippet: "x".repeat(300) }),
    );
    const small = assembleContextPack("task", 500, entries, "none");
    const large = assembleContextPack("task", 20000, entries, "none");
    expect(large.manifest.included.length).toBeGreaterThanOrEqual(small.manifest.included.length);
  });

  it("omitted_over_budget accounts for every entry not included", () => {
    const entries: PackEntry[] = Array.from({ length: 5 }, (_, i) =>
      entry({ path: `doc-${i}.md`, score: 5 - i, snippet: "x".repeat(500) }),
    );
    const pack = assembleContextPack("task", 500, entries, "none");
    expect(pack.manifest.included.length + pack.manifest.omitted_over_budget).toBe(entries.length);
  });

  it("stops at the first entry that does not fit — no skip-ahead", () => {
    const entries: PackEntry[] = [
      entry({ path: "fits.md", score: 3, snippet: "tiny" }),
      // Score 2: ranks second, and its huge snippet blows the budget.
      entry({ path: "huge.md", score: 2, snippet: "x".repeat(200_000) }),
      // Score 1: ranks last, but its snippet is tiny too — would fit on its
      // own if the walk skipped ahead past `huge.md`. It must not be
      // included: the walk stops at the FIRST non-fitting entry.
      entry({ path: "also-fits.md", score: 1, snippet: "tiny" }),
    ];
    const pack = assembleContextPack("task", 500, entries, "none");
    expect(pack.manifest.included.map((e) => e.path)).toEqual(["fits.md"]);
    expect(pack.manifest.omitted_over_budget).toBe(2);
  });
});

describe("assembleContextPack — degenerate outcomes (C9)", () => {
  it("zero candidates (zero-hit task): body reads 'no matching documents'", () => {
    const pack = assembleContextPack("task", 4000, [], "none");
    expect(pack.manifest.included).toEqual([]);
    expect(pack.manifest.omitted_over_budget).toBe(0);
    expect(pack.brief).toContain("No matching documents");
  });

  it("candidates exist but none fit the budget: distinct body from the zero-hit case", () => {
    const entries: PackEntry[] = [entry({ path: "a.md", score: 1, snippet: "x".repeat(200_000) })];
    const pack = assembleContextPack("task", 500, entries, "none");
    expect(pack.manifest.included).toEqual([]);
    expect(pack.manifest.omitted_over_budget).toBe(1);
    expect(pack.brief).toContain("Nothing fit the requested budget");
    expect(pack.brief).not.toContain("No matching documents");
  });
});

describe("assembleContextPack — hidden_remainder disclosure", () => {
  it("the scope line is absent when hidden_remainder is 'none'", () => {
    const pack = assembleContextPack("task", 4000, [entry({ path: "a.md", score: 1 })], "none");
    expect(pack.brief).not.toContain("withheld outside your read scope");
  });

  it("the scope line appears when hidden_remainder is non-'none', never an exact count", () => {
    const pack = assembleContextPack("task", 4000, [entry({ path: "a.md", score: 1 })], "some");
    expect(pack.brief).toContain("some additional document(s) withheld outside your read scope");
  });
});

describe("assembleContextPack — Decision 3 refusal, structurally enforced", () => {
  it("a tension flag renders BOTH claims verbatim, never a blended sentence", () => {
    const entries: PackEntry[] = [
      entry({
        path: "a.md",
        score: 1,
        tensions: [
          {
            kind: "factual",
            counterpart: "b.md",
            claimSelf: "the deploy target is X",
            claimOther: "the deploy target is Y",
          },
        ],
        contestedCount: 1,
      }),
    ];
    const pack = assembleContextPack("task", 4000, entries, "none");
    expect(pack.brief).toContain('this doc claims "the deploy target is X"');
    expect(pack.brief).toContain('b.md claims "the deploy target is Y"');
    // Never a resolved/composed verdict line.
    expect(pack.brief.toLowerCase()).not.toContain("resolv");
  });

  it("supersession prints only the pointer and hop count, not paraphrased content", () => {
    const entries: PackEntry[] = [
      entry({
        path: "head.md",
        score: 1,
        snippet: "the head's own verbatim content",
        supersedes: 3,
      }),
    ];
    const pack = assembleContextPack("task", 4000, entries, "none");
    expect(pack.brief).toContain("supersedes 3 older documents matching this task");
    expect(pack.brief).toContain("the head's own verbatim content");
  });

  it("flag lines are absent-is-healthy: no flags means no flag bullet lines", () => {
    const entries: PackEntry[] = [entry({ path: "a.md", score: 1 })];
    const pack = assembleContextPack("task", 4000, entries, "none");
    expect(pack.brief).not.toContain("- decay:");
    expect(pack.brief).not.toContain("- contested");
    expect(pack.brief).not.toContain("- structural:");
    expect(pack.brief).not.toContain("- upstream:");
  });
});
