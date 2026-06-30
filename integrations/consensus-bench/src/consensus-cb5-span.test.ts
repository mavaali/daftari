import { describe, expect, test } from "vitest";
import { extractChangedSpan, spanPairFromDiff, spanTruePairs, spanControlPairs } from "./consensus-cb5-span.js";

const cell = (inner: string) => `<td class="diff-deletedline diff-side-deleted"><div>${inner}</div></td>`;

describe("extractChangedSpan", () => {
  test("returns the diffchange words plus a context window of windowWords each side", () => {
    const html = cell('the cat sat on <del class="diffchange diffchange-inline">the red mat</del> by the door');
    // words: the cat sat on [the red mat] by the door — changed idx 4,5,6; window 2
    expect(extractChangedSpan(html, 2)).toBe("sat on the red mat by the");
  });

  test("falls back to the full cleaned line when no diffchange marker is present", () => {
    const html = cell("the whole line changed wholesale");
    expect(extractChangedSpan(html, 2)).toBe("the whole line changed wholesale");
  });

  test("spans from first to last changed word when multiple diffchange spans exist", () => {
    const html = cell('a b <del class="diffchange diffchange-inline">c</del> d e <del class="diffchange diffchange-inline">f</del> g h');
    expect(extractChangedSpan(html, 0)).toBe("c d e f");
  });

  test("strips html tags and comments, decodes entities, keeps wikitext", () => {
    const html = cell('x [[A|b]] <del class="diffchange diffchange-inline">c&amp;d</del> e<!-- note -->');
    expect(extractChangedSpan(html, 50)).toBe("x [[A|b]] c&d e");
  });
});

describe("spanPairFromDiff", () => {
  test("staleSpan from the deleted cell, govSpan from the added cell", () => {
    const diff =
      '<tr>' +
      '<td class="diff-deletedline diff-side-deleted"><div>the cat sat on <del class="diffchange diffchange-inline">the red mat</del> by the door</div></td>' +
      '<td class="diff-addedline diff-side-added"><div>the cat sat on <ins class="diffchange diffchange-inline">a blue rug</ins> by the door</div></td>' +
      '</tr>';
    const { staleSpan, govSpan } = spanPairFromDiff(diff, 2);
    expect(staleSpan).toBe("sat on the red mat by the");
    expect(govSpan).toBe("sat on a blue rug by the");
  });
});

describe("spanTruePairs / spanControlPairs (mirror cb4-pairs gating)", () => {
  const mkDiff = (revid: number, num: number, del: string, add: string) => ({
    revid, parentid: revid - 1, citedNum: num, governingNum: num,
    diffHtml:
      `<td class="diff-deletedline"><div>${del}</div></td>` +
      `<td class="diff-addedline"><div>${add}</div></td>`,
  });

  test("spanTruePairs keeps scorable single-hunk diffs and extracts both spans", () => {
    const diffs = [
      mkDiff(10, 70, 'one two <del class="diffchange diffchange-inline">old</del> three', 'one two <ins class="diffchange diffchange-inline">new</ins> three'),
    ];
    const tp = spanTruePairs(diffs, 1);
    expect(tp).toHaveLength(1);
    expect(tp[0]).toMatchObject({ revid: 10, governingNum: 70, staleSpan: "two old three", govSpan: "two new three" });
  });

  test("spanControlPairs joins govSpans from distinct items (adjacent)", () => {
    const diffs = [
      mkDiff(10, 70, 'a b <del class="diffchange diffchange-inline">x</del> c', 'a b <ins class="diffchange diffchange-inline">y</ins> c'),
      mkDiff(20, 72, 'p q <del class="diffchange diffchange-inline">m</del> r', 'p q <ins class="diffchange diffchange-inline">n</ins> r'),
    ];
    const cp = spanControlPairs(diffs, 1);
    expect(cp).toHaveLength(1);
    expect(cp[0]).toMatchObject({ numA: 70, numB: 72, spanA: "b y c", spanB: "q n r" });
  });
});
