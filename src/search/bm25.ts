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

// Builds an FTS5 MATCH query from a free-text user query.
//
// We tokenize the same way as `tokenize()`, then OR every term together as
// a prefix match (`cirrus*`). Prefix matching is friendly to partial
// keystrokes ("pric" → "pricing", "prices") and to morphologically related
// words; FTS5's porter tokenizer already collapses many of these on the
// document side, so the prefix is mostly a query-side recall booster.
//
// FTS5 query syntax is fragile in the face of user input: quotes, hyphens,
// the bare words AND / OR / NOT, and the trailing `*` operator all have
// meaning to the parser. We strip every character outside [a-zA-Z0-9_]
// during tokenization (already done), so the only remaining hazard is the
// reserved words. We bypass that by lower-casing every token — FTS5's
// reserved words are matched case-sensitively in upper case, so `or` is
// just a search term.
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
  return unique.map((t) => `${t}*`).join(" OR ");
}
