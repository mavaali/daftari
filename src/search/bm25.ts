// Lexical ranking — now a thin shim over SQLite FTS5.
//
// Until v1.9 this file held a hand-rolled BM25 implementation that scanned
// every document's JSON-tokens column in JavaScript. SQLite's built-in FTS5
// virtual table is faster, scales further, and ships with its own (Okapi)
// BM25 ranker — so this file is now reduced to (a) a query-side tokenizer
// used by snippet building and `relatedSearch`, and (b) a helper that turns
// a free-text query into the prefix-OR'd MATCH string FTS5 expects.
//
// The FTS5 virtual table (`documents_fts`) is declared in
// `src/storage/index-db.ts`; AFTER INSERT/UPDATE/DELETE triggers on the
// `documents` table keep it in sync.

// Common English words carry no discriminating signal; dropping them keeps
// the query side aligned with FTS5's porter/unicode61 tokenizer (which also
// drops stopwords from BM25 scoring via low IDF) and gives snippet building
// a cleaner highlight list.
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "he",
  "her",
  "his",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "she",
  "that",
  "the",
  "their",
  "them",
  "they",
  "this",
  "to",
  "was",
  "were",
  "will",
  "with",
  "you",
  "your",
]);

// Lowercases, splits on any non-alphanumeric run, and drops stopwords and
// 1-character fragments. Used for snippet highlighting and as the BM25
// query-side tokens fed into FTS5's MATCH parser.
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// Extracts quoted spans from the RAW query (before tokenize() strips the
// quotes) and turns each into an FTS5 phrase branch, for buildMatchQuery's
// phrase-emission step (spec 2026-07-26 fusion overhaul, Decision 2 — this
// is what makes the router's "quoted phrase → extreme-lexical" route
// actually true at the FTS5 layer: without it, buildMatchQuery already
// stripped the quotes by the time the extreme route's {bm25:1, vector:0}
// weights disabled the semantic ranker, leaving nothing to distinguish the
// phrase from token-scatter). A span survives only when it tokenizes to >=2
// usable tokens — a single-token or empty quoted span degrades to today's
// behaviour (the prefix-OR branch already covers it). Deduplicated in
// caller order.
function phraseBranches(rawQuery: string): string[] {
  const spans = rawQuery.match(/"[^"]*"/g) ?? [];
  const branches: string[] = [];
  const seen = new Set<string>();
  for (const span of spans) {
    const inner = span.slice(1, -1);
    const phraseTokens = tokenize(inner);
    if (phraseTokens.length < 2) continue;
    const phrase = `"${phraseTokens.join(" ")}"`;
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    branches.push(phrase);
  }
  return branches;
}

// Builds an FTS5 MATCH query from a free-text user query.
//
// We tokenize the same way as `tokenize()`, then OR every term together as
// a prefix match (`cirrus*`). Prefix matching is friendly to partial
// keystrokes ("pric" → "pricing", "prices") and to morphologically related
// words; FTS5's porter tokenizer already collapses many of these on the
// document side, so the prefix is mostly a query-side recall booster.
//
// A quoted span of >= 2 usable tokens ALSO emits an FTS5 phrase branch
// (`"tok1 tok2"`) as an extra OR alternative alongside the prefix branches —
// never a replacement. This is strictly recall-non-shrinking (a superset
// query: every prefix-OR match the old query found still matches), but a
// document containing the exact phrase now additionally satisfies the
// phrase branch and BM25 scores it higher than a document where the terms
// merely scatter — which is what quoting a phrase is supposed to mean.
//
// FTS5 query syntax is fragile in the face of user input: quotes, hyphens,
// the bare words AND / OR / NOT, and the trailing `*` operator all have
// meaning to the parser. We strip every character outside [a-zA-Z0-9_]
// during tokenization (already done), so the only remaining hazard is the
// reserved words. We bypass that by lower-casing every token — FTS5's
// reserved words are matched case-sensitively in upper case, so `or` is
// just a search term. The phrase branch is built from ALREADY-tokenized
// (lowercased, alphanumeric-only) terms, so it inherits the same safety.
//
// Returns null when the query yields no usable tokens (all-whitespace or
// all-stopwords). Callers must treat null as "no lexical match possible"
// rather than passing an empty string to MATCH, which is a syntax error.
export function buildMatchQuery(query: string): string | null {
  const tokens = tokenize(query);
  if (tokens.length === 0) return null;
  // Deduplicate to keep the MATCH string short. Prefix every token with `*`
  // for partial matches.
  const unique = [...new Set(tokens)];
  const branches = [...unique.map((t) => `${t}*`), ...phraseBranches(query)];
  return branches.join(" OR ");
}
