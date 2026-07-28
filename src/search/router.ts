// Query router (spec 2026-07-26 fusion overhaul, Decision 2).
//
// Classifies a raw user query into one of three routes and maps the route to
// a static HybridWeights split. Pure functions + types only — the router
// itself does no I/O; `makeDfLookup` is the one place a caller wires it to a
// live index handle, and even that is injected into `classifyQuery` as a
// plain function, not a database handle.
//
// The router is wired into `vault_search` only (src/tools/search.ts), gated
// behind the `search.routing` config switch. CLI/eval/bench callers that use
// `hybridSearch` directly stay on static weights unless they opt in.

import type { IndexDb } from "../storage/index-db.js";
import { tokenize } from "./bm25.js";
import type { HybridWeights } from "./hybrid.js";
import { DEFAULT_WEIGHTS } from "./hybrid.js";

export type RouteClass = "extreme-lexical" | "lexical" | "balanced";

export interface RouterOptions {
  // Document-frequency lookup, stem-aware (see makeDfLookup). Absent →
  // the rare-term signal never fires.
  df?: (token: string) => number;
  // Vault document count. The rare-term signal is disabled below
  // MIN_DOCS_FOR_RARE regardless of df, so this is required alongside df to
  // enable the signal at all.
  docCount?: number;
}

export interface ClassifyResult {
  class: RouteClass;
  signals: string[];
}

// A term is "rare" (in the document-frequency sense) when its df sits in
// [1, DF_RARE_FLOOR]. df === 0 means absent-from-corpus and never fires — an
// unknown token is not evidence the query is about something rare, it's
// evidence the query has a typo or the vault doesn't cover it.
const DF_RARE_FLOOR = 2;

// Below this many vault documents, df <= DF_RARE_FLOOR covers a large
// fraction of the whole vocabulary — the rare-term signal is noise exactly
// where semantic recall matters most, so it is disabled entirely rather than
// floor-adjusted. Kill condition [HYPOTHESIS]: if bench category deltas show
// the signal harming at ~180 docs, this floor is too high and gets
// re-derived before the PR 3 flip.
const MIN_DOCS_FOR_RARE = 100;

// Path-like extensions. Deliberately a fixed, small, source/config-flavoured
// list — this is a vault of markdown + code/config references, not a
// general-purpose file-type sniffer.
const PATH_LIKE_EXTENSIONS = [
  ".md",
  ".ts",
  ".js",
  ".mjs",
  ".json",
  ".yaml",
  ".yml",
  ".py",
  ".sql",
  ".sh",
  ".toml",
];

const QUOTED_PHRASE_RE = /"[^"]{2,}"/;
const CAMEL_CASE_RE = /[a-z0-9][A-Z]/;
const SNAKE_CASE_RE = /[A-Za-z0-9]_[A-Za-z0-9]/;

function isPathLike(token: string): boolean {
  if (token.includes("/")) return true;
  const lower = token.toLowerCase();
  return PATH_LIKE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isDigitHeavy(token: string): boolean {
  if (token.length < 3) return false;
  const digits = (token.match(/[0-9]/g) ?? []).length;
  return digits >= Math.ceil(token.length / 2);
}

// Classifies a raw query into a route class, plus the full list of signals
// that fired (not just the ones that decided the class — a routed extreme
// query that ALSO carries a rare term should surface both in diagnostics).
//
// Precedence: any extreme-lexical signal wins outright; otherwise any
// lexical signal; otherwise balanced.
export function classifyQuery(rawQuery: string, opts: RouterOptions = {}): ClassifyResult {
  const signals: string[] = [];
  let sawExtreme = false;
  let sawLexical = false;

  if (QUOTED_PHRASE_RE.test(rawQuery)) {
    signals.push("quoted-phrase");
    sawExtreme = true;
  }

  const rawTokens = rawQuery.split(/\s+/).filter((t) => t.length > 0);

  let sawPathLike = false;
  let sawCamelCase = false;
  let sawSnakeCase = false;
  let sawDigitHeavy = false;
  for (const token of rawTokens) {
    if (!sawPathLike && isPathLike(token)) sawPathLike = true;
    if (!sawCamelCase && CAMEL_CASE_RE.test(token)) sawCamelCase = true;
    if (!sawSnakeCase && SNAKE_CASE_RE.test(token)) sawSnakeCase = true;
    if (!sawDigitHeavy && isDigitHeavy(token)) sawDigitHeavy = true;
  }
  if (sawPathLike) {
    signals.push("path-like");
    sawExtreme = true;
  }
  if (sawCamelCase) {
    signals.push("camel-case");
    sawLexical = true;
  }
  if (sawSnakeCase) {
    signals.push("snake-case");
    sawLexical = true;
  }
  if (sawDigitHeavy) {
    signals.push("digit-heavy");
    sawLexical = true;
  }

  if (opts.df && opts.docCount !== undefined && opts.docCount >= MIN_DOCS_FOR_RARE) {
    const df = opts.df;
    const isRare = tokenize(rawQuery).some((token) => {
      const count = df(token);
      return count >= 1 && count <= DF_RARE_FLOOR;
    });
    if (isRare) {
      signals.push("rare-term");
      sawLexical = true;
    }
  }

  const cls: RouteClass = sawExtreme ? "extreme-lexical" : sawLexical ? "lexical" : "balanced";
  return { class: cls, signals };
}

// Maps a route class to a static weight split.
//
// extreme-lexical skips query embedding entirely (hybridSearch checks
// weights.vector > 0 before calling embedQuery) — the latency win the
// extreme route buys.
export function routeWeights(cls: RouteClass): HybridWeights {
  switch (cls) {
    case "extreme-lexical":
      return { bm25: 1, vector: 0 };
    case "lexical":
      return { bm25: 0.8, vector: 0.2 };
    case "balanced":
      return { ...DEFAULT_WEIGHTS };
  }
}

// Document-frequency lookup, stem-aware by construction: FTS5 applies its
// own porter tokenizer to the MATCH query, so "locking" and "locks" both
// count postings stemmed to "lock" — no fts5vocab table, no schema change.
// Document-granularity (not chunk): "rare in the vault" is a whole-document
// notion even though default ranking is chunk-granular.
export function makeDfLookup(db: IndexDb): (token: string) => number {
  const stmt = db.prepare("SELECT count(*) AS n FROM documents_fts WHERE documents_fts MATCH ?");
  return (token: string): number => {
    const row = stmt.get(`"${token}"`) as { n: number };
    return row.n;
  };
}
