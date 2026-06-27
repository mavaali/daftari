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
