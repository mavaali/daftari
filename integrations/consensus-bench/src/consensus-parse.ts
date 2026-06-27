// consensus-parse — parse a Wikipedia "Current consensus" subpage (wikitext)
// into a list of consensus items with their supersession edges. The consensus
// box is a human-maintained, dated supersession graph: active items are the
// current ground truth; superseded/canceled items carry pointers to what
// replaced them. This is the corpus-(B) analog of the contract-bench amendment
// chain — the daftari resolution oracle and the held-out ground truth.

export type ConsensusStatus = "active" | "superseded" | "canceled";

export interface ConsensusItem {
  num: number;
  anchor: string;
  status: ConsensusStatus;
  statement: string;
  supersededBy: number[];
  supersedes: number[];
}

// Each item is keyed by an anchor template: {{anchor|C12}}.
const ANCHOR_RE = /\{\{anchor\|(C(\d+))\}\}/g;

export function parseConsensus(wikitext: string): ConsensusItem[] {
  const matches = [...wikitext.matchAll(ANCHOR_RE)];
  const items: ConsensusItem[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const anchor = m[1];
    const num = Number(m[2]);
    const start = (m.index ?? 0) + m[0].length;
    // Bound the item body to the next anchor so cross-references don't leak
    // from one item into the next.
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? wikitext.length) : wikitext.length;
    const after = wikitext.slice(start);
    const body = wikitext.slice(start, end);
    const header = extractHeader(after);
    items.push({
      num,
      anchor,
      status: classifyStatus(header),
      statement: extractStatement(body),
      supersededBy: extractItemRefs(header),
      supersedes: extractSupersedes(body),
    });
  }
  return items;
}

// The reverse edge: a "Supersedes [[#C11|#11]]" phrase in the item body names
// the predecessor(s) this item replaced.
function extractSupersedes(body: string): number[] {
  return [...body.matchAll(/\bSupersedes\s+\[\[#C(\d+)/gi)].map((m) => Number(m[1]));
}

// The "header" is the text between the anchor and the first hide-template
// separator " |", dated citation " ([[", or end of line. For a hidden
// (superseded/canceled) item it reads e.g. "Superseded by [[#C15|#15]]"; for
// an active item it is the start of the statement itself.
function extractHeader(after: string): string {
  let end = after.length;
  for (const marker of [" |", " ([[", "\n"]) {
    const i = after.indexOf(marker);
    if (i >= 0) end = Math.min(end, i);
  }
  return after.slice(0, end).trim();
}

function classifyStatus(header: string): ConsensusStatus {
  if (/superseded/i.test(header)) return "superseded";
  if (/canceled/i.test(header)) return "canceled";
  return "active";
}

// Item cross-references are wikilinks to anchors: [[#C15|#15]] -> 15.
function extractItemRefs(text: string): number[] {
  return [...text.matchAll(/#C(\d+)\b/g)].map((m) => Number(m[1]));
}

// The statement is the consensus prose, up to the first dated-discussion
// citation " ([[" or end of line. Hidden (superseded/canceled) items carry it
// inside the hide template's "|content=" parameter; active items carry it
// inline right after the anchor.
function extractStatement(body: string): string {
  const contentIdx = body.indexOf("|content=");
  let s = contentIdx >= 0 ? body.slice(contentIdx + "|content=".length) : body;
  s = s.replace(/^\s+/, "");
  let end = s.length;
  for (const marker of [" ([[", "\n"]) {
    const i = s.indexOf(marker);
    if (i >= 0) end = Math.min(end, i);
  }
  return s.slice(0, end).trim();
}
