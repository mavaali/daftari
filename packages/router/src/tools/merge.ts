// merge.ts — fan-out result mergers for each router-dispatched tool.
//
// Each merger accepts an array of VaultResult<T> (one per child vault),
// prefixes all path fields with the vault name (via formatVaultPath),
// aggregates counters, and passes per-vault errors through without failing
// the whole call.
//
// IMPORTANT: Field names are verified against the actual daftari source:
//   - vault_themes: VaultTheme has representativeDocs/secondaryDocs (string[]),
//     NOT sources. The plan's sketch used sources; the real type does not.
//   - vault_reindex: ReindexResult uses documentCount/chunkCount, NOT
//     filesProcessed/chunksProcessed. Merger uses real field names.

import { formatVaultPath } from "../path.js";

// ---------------------------------------------------------------------------
// Core discriminated-union type
// ---------------------------------------------------------------------------

export type VaultResult<T> =
  | { vault: string; ok: true; value: T }
  | { vault: string; ok: false; error: string };

export type VaultError = { vault: string; error: string };

function splitOks<T>(rows: VaultResult<T>[]): {
  oks: { vault: string; value: T }[];
  errors: VaultError[];
} {
  const oks: { vault: string; value: T }[] = [];
  const errors: VaultError[] = [];
  for (const r of rows) {
    if (r.ok) oks.push({ vault: r.vault, value: r.value });
    else errors.push({ vault: r.vault, error: r.error });
  }
  return { oks, errors };
}

// ---------------------------------------------------------------------------
// vault_search / vault_search_related
//
// Actual HybridHit shape: { path, title, collection, status, score,
//   bm25Score, vectorScore, snippet, decay }
// HybridSearchResult / RelatedSearchResult: { count, hits, ... extra fields }
// Merger accesses only count and hits; extra fields are carried via spread.
// ---------------------------------------------------------------------------

type SearchHit = { path: string; score: number; collection: string } & Record<string, unknown>;

export function mergeSearch(rows: VaultResult<{ count: number; hits: SearchHit[] }>[]): {
  count: number;
  hits: (SearchHit & { vault: string })[];
  errors: VaultError[];
} {
  const { oks, errors } = splitOks(rows);
  const hits = oks.flatMap(({ vault, value }) =>
    value.hits.map((h) => ({ ...h, vault, path: formatVaultPath(vault, h.path) })),
  );
  hits.sort((a, b) => b.score - a.score);
  return { count: hits.length, hits, errors };
}

// ---------------------------------------------------------------------------
// vault_index
//
// VaultIndexEntry: { path, title, collection, domain, status, confidence,
//   updated, tags, questionsAnswered, questionsRaised, valid }
// VaultIndexResult: { count, entries }
// ---------------------------------------------------------------------------

type IndexEntry = { path: string } & Record<string, unknown>;

export function mergeIndex(rows: VaultResult<{ count: number; entries: IndexEntry[] }>[]): {
  count: number;
  entries: (IndexEntry & { vault: string })[];
  errors: VaultError[];
} {
  const { oks, errors } = splitOks(rows);
  const entries = oks.flatMap(({ vault, value }) =>
    value.entries.map((e) => ({ ...e, vault, path: formatVaultPath(vault, e.path) })),
  );
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { count: entries.length, entries, errors };
}

// ---------------------------------------------------------------------------
// vault_status
//
// VaultStatusResult: { vault, fileCount, collections, invalidCount,
//   generatedAt, stalenessDistribution, unresolvedTensions, recentWrites,
//   embeddingDimMismatches }
// Merger sums the numeric scalars and stalenessDistribution buckets;
// per-vault details are preserved in byVault.
// ---------------------------------------------------------------------------

type StatusValue = {
  fileCount: number;
  invalidCount: number;
  embeddingDimMismatches: number;
  stalenessDistribution: { fresh: number; aging: number; stale: number; total: number };
} & Record<string, unknown>;

export function mergeStatus(rows: VaultResult<StatusValue>[]): {
  fileCount: number;
  invalidCount: number;
  embeddingDimMismatches: number;
  stalenessDistribution: { fresh: number; aging: number; stale: number; total: number };
  generatedAt: string;
  byVault: Record<string, StatusValue>;
  errors: VaultError[];
} {
  const { oks, errors } = splitOks(rows);
  const byVault: Record<string, StatusValue> = {};
  let fileCount = 0;
  let invalidCount = 0;
  let embeddingDimMismatches = 0;
  const sd = { fresh: 0, aging: 0, stale: 0, total: 0 };
  for (const { vault, value } of oks) {
    byVault[vault] = value;
    fileCount += value.fileCount;
    invalidCount += value.invalidCount;
    embeddingDimMismatches += value.embeddingDimMismatches;
    sd.fresh += value.stalenessDistribution.fresh;
    sd.aging += value.stalenessDistribution.aging;
    sd.stale += value.stalenessDistribution.stale;
    sd.total += value.stalenessDistribution.total;
  }
  return {
    fileCount,
    invalidCount,
    embeddingDimMismatches,
    stalenessDistribution: sd,
    generatedAt: new Date().toISOString(),
    byVault,
    errors,
  };
}

// ---------------------------------------------------------------------------
// vault_lint
//
// VaultLintResult: { generatedAt, filter, checks, totalFindings }
// LintFinding: { path: string; detail: string } — path is always present.
// All findings get their path prefixed; totalFindings is summed.
// ---------------------------------------------------------------------------

type LintFinding = { path: string } & Record<string, unknown>;
type LintValue = {
  checks: Record<string, LintFinding[]>;
  totalFindings: number;
  generatedAt: string;
  filter: string | null;
};

export function mergeLint(rows: VaultResult<LintValue>[]): {
  totalFindings: number;
  checks: Record<string, (LintFinding & { vault: string })[]>;
  byVault: Record<string, LintValue>;
  errors: VaultError[];
} {
  const { oks, errors } = splitOks(rows);
  const checks: Record<string, (LintFinding & { vault: string })[]> = {};
  const byVault: Record<string, LintValue> = {};
  let totalFindings = 0;
  for (const { vault, value } of oks) {
    byVault[vault] = value;
    totalFindings += value.totalFindings;
    for (const [name, findings] of Object.entries(value.checks)) {
      const prefixed = findings.map((f) =>
        typeof f.path === "string"
          ? { ...f, vault, path: formatVaultPath(vault, f.path) }
          : { ...f, vault },
      );
      if (!checks[name]) checks[name] = [];
      checks[name].push(...prefixed);
    }
  }
  return { totalFindings, checks, byVault, errors };
}

// ---------------------------------------------------------------------------
// vault_themes
//
// VERIFIED SHAPE (from src/tools/themes.ts):
//   VaultTheme: { label, documentCount, coherence, representativeDocs: string[],
//                 secondaryDocs: string[], relatedTags: string[] }
//   VaultThemesResult: { themes: VaultTheme[], totalDocuments, skippedDocuments,
//                        selectedK, clusteredAt }
//
// NOTE: The plan's sketch used `sources?: Array<{ path }>` — that field does
// NOT exist in the real type. The real per-theme paths live in representativeDocs
// and secondaryDocs (string arrays). We prefix those path strings.
// ---------------------------------------------------------------------------

type VaultTheme = {
  label: string;
  documentCount: number;
  coherence: number | null;
  representativeDocs: string[];
  secondaryDocs: string[];
  relatedTags: string[];
} & Record<string, unknown>;

type ThemesValue = {
  themes: VaultTheme[];
} & Record<string, unknown>;

export function mergeThemes(rows: VaultResult<ThemesValue>[]): {
  themes: (VaultTheme & { vault: string })[];
  errors: VaultError[];
} {
  const { oks, errors } = splitOks(rows);
  const themes: (VaultTheme & { vault: string })[] = [];
  for (const { vault, value } of oks) {
    for (const cluster of value.themes ?? []) {
      themes.push({
        ...cluster,
        vault,
        representativeDocs: (cluster.representativeDocs ?? []).map((p) =>
          formatVaultPath(vault, p),
        ),
        secondaryDocs: (cluster.secondaryDocs ?? []).map((p) => formatVaultPath(vault, p)),
      });
    }
  }
  return { themes, errors };
}

// ---------------------------------------------------------------------------
// vault_reindex
//
// VERIFIED SHAPE (from src/search/reindex.ts + src/tools/search.ts):
//   ReindexResult: { documentCount, chunkCount, vectorEnabled, skipped,
//                    indexedAt, embeddedCount, cacheHits, orphansRemoved }
//   VaultReindexResult: { ...ReindexResult, vault: string }
//
// NOTE: The plan's sketch used filesProcessed/chunksProcessed — those field
// names do NOT exist. The real fields are documentCount and chunkCount.
// ---------------------------------------------------------------------------

type ReindexValue = {
  vault: string;
  documentCount?: number;
  chunkCount?: number;
} & Record<string, unknown>;

export function mergeReindex(rows: VaultResult<ReindexValue>[]): {
  documentCount: number;
  chunkCount: number;
  byVault: Record<string, ReindexValue>;
  errors: VaultError[];
} {
  const { oks, errors } = splitOks(rows);
  const byVault: Record<string, ReindexValue> = {};
  let documentCount = 0;
  let chunkCount = 0;
  for (const { vault, value } of oks) {
    byVault[vault] = value;
    documentCount += value.documentCount ?? 0;
    chunkCount += value.chunkCount ?? 0;
  }
  return { documentCount, chunkCount, byVault, errors };
}
