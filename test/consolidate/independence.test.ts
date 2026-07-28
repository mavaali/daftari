// Independence-aware promotion: the would-be verdict, the shadow journal,
// and the needs-review tension body (2026-07-26 spec, Decisions 3-4, PR-2).

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendIndependenceShadow,
  classesForTension,
  type IndependenceShadowRow,
  independenceShadowPath,
  independenceVerdict,
  listIndependenceShadow,
  needsReviewTensionInput,
} from "../../src/consolidate/independence.js";
import { addTension, parseTensionLog } from "../../src/curation/tension.js";

function tmpVault(): string {
  const root = join(
    tmpdir(),
    `daftari-independence-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, ".daftari"), { recursive: true });
  return root;
}

function cleanup(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
}

const baseRow: IndependenceShadowRow = {
  at: "2026-07-27T00:00:00Z",
  fromPath: "a.md",
  toPath: "b.md",
  kSurvived: 3,
  kEff: 1.9375,
  strength: 3,
  strengthIndependent: 1.9375,
  classes: [{ key: "h1\np1\nm1", count: 3 }],
  panelClassKeys: ["h1\np1\nm1"],
  marginalGain: 0.125,
  wouldDecision: "would_needs_review",
};

describe("independenceVerdict — boundary math", () => {
  it("empty preClasses: each fresh-class vote gains 1.0 → accrues", () => {
    const r = independenceVerdict(new Map(), ["classA"]);
    expect(r.marginalGain).toBeCloseTo(1, 6);
    expect(r.wouldDecision).toBe("would_accrue");
  });

  it("a second vote in a count-1 class gains exactly 0.5 → accrues (boundary inclusive)", () => {
    const r = independenceVerdict(new Map([["classA", 1]]), ["classA"]);
    expect(r.marginalGain).toBeCloseTo(0.5, 6);
    expect(r.wouldDecision).toBe("would_accrue");
  });

  it("a third vote in a count-2 class gains 0.25 → needs-review (strictly below 0.5)", () => {
    const r = independenceVerdict(new Map([["classA", 2]]), ["classA"]);
    expect(r.marginalGain).toBeCloseTo(0.25, 6);
    expect(r.wouldDecision).toBe("would_needs_review");
  });

  it("sequential same-panel votes discount against each other, not just against preClasses", () => {
    // Two panel votes into an empty class: 1.0 (fresh) + 0.5 (second in-panel) = 1.5.
    const r = independenceVerdict(new Map(), ["classA", "classA"]);
    expect(r.marginalGain).toBeCloseTo(1.5, 6);
    expect(r.wouldDecision).toBe("would_accrue");
  });

  it("a fresh class always accrues regardless of other classes' saturation", () => {
    const r = independenceVerdict(new Map([["classA", 5]]), ["classB"]);
    expect(r.marginalGain).toBeCloseTo(1, 6);
    expect(r.wouldDecision).toBe("would_accrue");
  });
});

describe("independence shadow journal", () => {
  let vault: string;
  beforeEach(() => {
    vault = tmpVault();
  });
  afterEach(() => {
    cleanup(vault);
  });

  it("append/read round-trips a row", async () => {
    const res = await appendIndependenceShadow(vault, baseRow);
    expect(res.ok).toBe(true);
    const listed = await listIndependenceShadow(vault);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]).toEqual(baseRow);
  });

  it("a missing log reads as empty, not an error", async () => {
    const listed = await listIndependenceShadow(vault);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value).toEqual([]);
  });

  it("skips a corrupt line without failing the whole read", async () => {
    await appendIndependenceShadow(vault, baseRow);
    appendFileSync(independenceShadowPath(vault), "not json at all\n");
    await appendIndependenceShadow(vault, { ...baseRow, toPath: "c.md" });
    const listed = await listIndependenceShadow(vault);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(2);
    expect(listed.value.map((r) => r.toPath)).toEqual(["b.md", "c.md"]);
  });

  it("a wholly malformed jsonl file yields an empty list, not a thrown error", async () => {
    writeFileSync(independenceShadowPath(vault), "{{{not json\n\n   \n");
    const listed = await listIndependenceShadow(vault);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value).toEqual([]);
  });
});

describe("needsReviewTensionInput — the class breakdown (C6)", () => {
  it("claimA is a single line, never a raw newline-joined class key", () => {
    const classes = classesForTension(new Map([["h1234567890abcdef\np1\nm1", 3]]));
    const input = needsReviewTensionInput("a.md", "b.md", classes);
    expect(input.claimA).not.toContain("\n");
    expect(input.title).toBe("correlated-only survival: a.md derives_from b.md");
    expect(input.kind).toBe("interpretive");
    expect(input.sourceA).toBe("a.md");
    expect(input.sourceB).toBe("b.md");
  });

  it("renders ∅ components as 'unfingerprinted' and truncates inputs to a 12-hex prefix", () => {
    // classesForTension decodes the sentinel "∅" (via evidenceClassKey) to null.
    const classes = classesForTension(new Map([["∅\n∅\n∅", 5]]));
    const input = needsReviewTensionInput("a.md", "b.md", classes);
    expect(input.claimA).toContain("unfingerprinted");
    expect(input.claimA).not.toContain("∅");
    expect(input.claimA).toBe(
      "1 classes over 5 counted votes — class 1 ×5: model=unfingerprinted, principal=unfingerprinted, inputs=unfingerprinted",
    );
  });

  it("truncates a real sha256 inputs hash to a 12-char prefix and reports N classes over M votes", () => {
    const hash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";
    const classes = classesForTension(
      new Map([
        [`${hash}\np1\nm1`, 2],
        ["∅\np2\nm2", 1],
      ]),
    );
    const input = needsReviewTensionInput("a.md", "b.md", classes);
    expect(input.claimA).toContain("2 classes over 3 counted votes");
    expect(input.claimA).toContain(`inputs=${hash.slice(0, 12)}`);
    expect(input.claimA).not.toContain(hash.slice(0, 13));
  });

  it("the emitted tension round-trips byte-stable through addTension render + parse", async () => {
    const vault = tmpVault();
    try {
      const hash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";
      const classes = classesForTension(
        new Map([
          [`${hash}\nagent:curation-loop\nclaude-haiku`, 3],
          ["∅\n∅\n∅", 2],
        ]),
      );
      const input = needsReviewTensionInput("pricing/plan.md", "research/basis.md", classes);
      const added = await addTension(vault, input);
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      const raw = readFileSync(join(vault, ".daftari", "tensions.md"), "utf-8");
      const parsed = parseTensionLog(raw);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.claimA).toBe(added.value.claimA);
      expect(parsed[0]?.title).toBe(input.title);
      expect(parsed[0]?.kind).toBe("interpretive");
      expect(parsed[0]?.sourceA).toBe("pricing/plan.md");
      expect(parsed[0]?.sourceB).toBe("research/basis.md");
    } finally {
      cleanup(vault);
    }
  });
});
