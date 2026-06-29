// consensus-marker — extract the consensus-item numbers referenced by inline
// markers in a revision's wikitext. Markers live in HTML comments
// ("<!-- DO NOT CHANGE ... -->") and reference items in evolving formats:
//   "[[Talk:Donald Trump#C70|consensus 70]]"  (newer)
//   "consensus 70"
//   "[[Talk:Donald Trump#Current consensus]], item 70"  (older)
// Only numbers inside a comment that mentions "consensus" are taken, so body
// text and unrelated "item N" notes don't leak in. This reads markers from the
// FULL revision content (not just the diff window), which is how Arm C localizes
// the governing passage non-circularly even when the marker isn't on the changed
// line.

const COMMENT_RE = /<!--([\s\S]*?)-->/g;
const NUM_RE = /#C(\d+)\b|consensus\s*#?\s*(\d+)\b|\bitem\s*(\d+)\b/gi;

export function extractMarkerNums(content: string): number[] {
  const nums = new Set<number>();
  for (const c of content.matchAll(COMMENT_RE)) {
    const body = c[1];
    if (!/consensus/i.test(body)) continue;
    for (const m of body.matchAll(NUM_RE)) {
      nums.add(Number(m[1] ?? m[2] ?? m[3]));
    }
  }
  return [...nums].sort((a, b) => a - b);
}
