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
    const status = classifyStatus(header);
    items.push({
      num,
      anchor,
      status,
      statement: extractStatement(body),
      // The supersededBy pointer lives in the hide header of a superseded/
      // canceled item ("Superseded by [[#C15|#15]]"). An active item has no
      // such header — its "header" is the start of its statement, which may
      // itself open with "Supersedes [[#C..]]" (the reverse edge). Scraping
      // refs from an active item's header would mis-record its predecessor as
      // a successor, so only superseded/canceled items carry a supersededBy.
      supersededBy: status === "active" ? [] : extractItemRefs(header),
      supersedes: extractSupersedes(body),
    });
  }
  return items;
}

// The reverse edge: a "Supersedes [[#C11|#11]]" phrase in the item body names
// the predecessor(s) this item replaced. One item can supersede several at once
// ("Supersedes [[#C21|#21]] and [[#C36|#36]]"), so capture every ref in that
// sentence — bounded to the first "." or newline so later, unrelated anchor
// links in the statement don't leak in as predecessors.
function extractSupersedes(body: string): number[] {
  const m = body.match(/\bSupersedes\b([^.\n]*)/i);
  if (!m) return [];
  return [...m[1].matchAll(/#C(\d+)\b/g)].map((x) => Number(x[1]));
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
