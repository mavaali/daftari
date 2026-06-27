// html-to-text — convert EDGAR exhibit HTML into text that the CB1
// parseCitations contract can read: decode entities (curly quotes arrive as
// numeric entities like &#8220;), unwrap inline tags WITHOUT inserting
// whitespace (so a tag-split quoted term stays one token), and collapse
// structure to spaces WITHOUT minting spurious sentence boundaries.

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  sect: "§", para: "¶", middot: "·",
  mdash: "—", ndash: "–", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  reg: "®", copy: "©", trade: "™", deg: "°",
};

// Windows-1252 mappings for the 0x80–0x9F range that legacy filings emit as
// raw numeric entities (&#147; etc.). Only the punctuation that occurs in
// contract prose is mapped; anything else falls through to fromCodePoint.
const CP1252: Record<number, string> = {
  145: "‘", 146: "’", 147: "“", 148: "”",
  150: "–", 151: "—", 133: "…", 149: "•",
};

function numericEntity(body: string): string | null {
  const code = body[1] === "x" || body[1] === "X"
    ? parseInt(body.slice(2), 16)
    : parseInt(body.slice(1), 10);
  if (!Number.isFinite(code)) return null;
  if (code in CP1252) return CP1252[code];
  try {
    return String.fromCodePoint(code);
  } catch {
    return null;
  }
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] === "#") return numericEntity(body) ?? m;
    return NAMED[body] ?? m; // unknown named entity left intact
  });
}

// Inline tags carry no structural meaning — remove them with no spacing so a
// quoted term split across <b>/<u>/<font> stays a single token. Everything
// else is treated as a block boundary (one space).
const INLINE = new Set([
  "b", "i", "u", "em", "strong", "font", "span", "a", "sup", "sub",
  "small", "big", "tt", "strike", "s", "ins", "del", "mark", "abbr",
]);

export function stripStructure(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "");
  // Named element tags: inline -> "", block -> " ".
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (_m, name: string) =>
    INLINE.has(name.toLowerCase()) ? "" : " ");
  // Any residual stray tags (malformed) -> space, never silently merge tokens.
  s = s.replace(/<[^>]+>/g, " ");
  return s;
}

export function htmlToText(html: string): string {
  const stripped = stripStructure(html);
  const decoded = decodeEntities(stripped);
  // Collapse every run of whitespace (incl. decoded U+00A0) to one space. We
  // never insert a period, so this cannot mint a sentence boundary; it only
  // guarantees at least one space between former block elements.
  return decoded.replace(/[\s ]+/g, " ").trim();
}
