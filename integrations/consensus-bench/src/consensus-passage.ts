// consensus-passage — turn a Wikipedia compare diff into the stale and governing
// passage text, and detect the inline consensus marker. Deterministic; the
// scorable gate keeps only clean single-hunk replacements (the spec's honest
// attrition).

const DELETED_RE = /<td[^>]*class="[^"]*diff-deletedline[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
const ADDED_RE = /<td[^>]*class="[^"]*diff-addedline[^"]*"[^>]*>([\s\S]*?)<\/td>/g;

export interface ParsedPassage {
  staleText: string;
  governingText: string;
  scorable: boolean;
  reason?: string;
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Clean text for comparison: drop HTML comments and tags, decode entities,
// collapse whitespace. Comments are stripped twice (before and after decode) so
// an entity-encoded `&lt;!-- ... --&gt;` is removed too.
export function cleanText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<[^>]*>/g, "");
  s = decode(s);
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  return s.replace(/\s+/g, " ").trim();
}

export function parsePassage(diffHtml: string): ParsedPassage {
  const deleted = [...diffHtml.matchAll(DELETED_RE)].map((m) => m[1]);
  const added = [...diffHtml.matchAll(ADDED_RE)].map((m) => m[1]);
  if (deleted.length + added.length > 2 || deleted.length > 1 || added.length > 1) {
    return { staleText: "", governingText: "", scorable: false, reason: "multi-hunk" };
  }
  if (deleted.length === 0) return { staleText: "", governingText: "", scorable: false, reason: "add-only" };
  if (added.length === 0) return { staleText: "", governingText: "", scorable: false, reason: "remove-only" };
  return { staleText: cleanText(deleted[0]), governingText: cleanText(added[0]), scorable: true };
}

// The inline marker travels with a governed passage: "...president of the United
// States].<!-- DO NOT CHANGE preceding sentence ... [[Talk:...#C70|consensus 70]] -->".
// Match either "consensus N" or an anchor "#C N" anywhere in the (entity-encoded)
// diff window.
export function markerPresent(diffHtml: string, num: number): boolean {
  const re = new RegExp(`consensus\\s*#?\\s*${num}\\b|#C${num}\\b`, "i");
  return re.test(diffHtml);
}
