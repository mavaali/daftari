// vault_lint's engine — advisory cross-vault curation checks.
//
// Lint loads every document once, builds the inter-document link graph, then
// runs six checks. It only ever *reports*: no file is edited, no status is
// changed, nothing is auto-fixed. The output is a structured report grouped by
// check, for a human (or an agent acting on a human's behalf) to triage.

import { ok, type Result } from "../frontmatter/types.js";
import { DRAFT_MAX_DAYS, LOW_CONFIDENCE_MAX_DAYS } from "./decay.js";
import { ageInDays, computeStaleness } from "./staleness.js";
import {
  agingTier,
  listTensions,
  RESOLUTION_KINDS,
  type ResolutionKind,
  STALE_TIER_LINT_COPY,
  TENSION_KINDS,
  type TensionKind,
} from "./tension.js";
import { computeTensionClusters } from "./tension-clusters.js";
import {
  buildPathIndexes,
  extractLinks,
  type LoadedDoc,
  loadDocuments,
  resolveLink,
} from "./vault-docs.js";

export const LINT_CHECKS = [
  "staleFiles",
  "orphanFiles",
  "oldDrafts",
  "stagnantLowConfidence",
  "deprecatedStillLinked",
  "unansweredQuestions",
] as const;
export type LintCheckName = (typeof LINT_CHECKS)[number];

export interface LintFinding {
  path: string;
  detail: string;
}

// Tension health: aggregate counts for the curation engine's tension log.
// Added in Phase 1 of the tension graph plan (2026-05-31). Surfaces the
// taxonomy and resolution distribution without flagging anything as a
// defect — the advisory posture matches the rest of vault_lint.
//
// - total: every entry in the tension log, resolved or not.
// - byKind: count of entries grouped by taxonomy. Legacy entries land in
//   `unspecified`.
// - resolvedLifetime: count of all resolutions across the lifetime of the
//   log, with a breakdown by resolution kind.
// - stableAcknowledged: tensions resolved with `kind: accepted` —
//   persistent disagreements that the curator has explicitly chosen to keep.
//   Tracked in a dedicated bucket because aging (Phase 4) excludes them.
// - unspecifiedLegacy: count of entries without a `kind` field. Reported
//   for visibility; never lint-flagged.
// Aging surface (Phase 4 of the tension graph plan, 2026-05-31). Counts are
// taken over the active surface only — unresolved tensions excluding the
// taxonomy carve-outs (`unspecified` and `resolution.kind: accepted`). The
// per-kind stale breakdown surfaces which kinds the stale tier is hitting;
// `staleMessages` carries the kind-specific lint copy when that kind's stale
// count is nonzero. `unspecified` is omitted from `staleMessages` on purpose
// (legacy entries are not aged) and is reported as 0 in `staleByKind` for
// clarity, never lint-flagged.
export interface TensionAging {
  fresh: number;
  aging: number;
  stale: number;
  staleByKind: Record<TensionKind, number>;
  staleMessages: Partial<Record<Exclude<TensionKind, "unspecified">, string>>;
}

// Cluster metrics (Phase 2 of the tension graph plan, 2026-05-31). The two
// flag counts mirror the spec's stale-smell thresholds: a cluster with more
// than 5 documents is large enough to warrant investigation, and a cluster
// whose oldest tension is more than 90 days old is tech debt. Counts only —
// `vault_lint` never auto-acts on them.
export interface TensionClustersHealth {
  count: number;
  maxSize: number;
  large: number; // clusters where size > 5
  aged: number; // clusters where oldest_tension_age_days > 90
}

export interface TensionHealth {
  total: number;
  byKind: Record<TensionKind, number>;
  resolvedLifetime: number;
  byResolutionKind: Record<ResolutionKind, number>;
  stableAcknowledged: number;
  unspecifiedLegacy: number;
  aging: TensionAging;
  clusters: TensionClustersHealth;
}

export interface LintReport {
  generatedAt: string;
  checks: Record<LintCheckName, LintFinding[]>;
  totalFindings: number;
  tensionHealth: TensionHealth;
}

export interface LintOptions {
  now?: Date;
  draftMaxDays?: number; // a draft older than this is flagged
  lowConfidenceMaxDays?: number; // a low-confidence doc unchanged this long is flagged
}

// --- question matching ----------------------------------------------------

// Normalizes a question for cross-document matching: trimmed, lower-cased,
// internal whitespace collapsed. Exact (normalized) equality is the matching
// rule — a question answered elsewhere must be phrased the same way.
function normalizeQuestion(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

// --- check orchestration --------------------------------------------------

// Maps each document to the set of documents that link to it.
function buildInboundMap(docs: LoadedDoc[]): Map<string, Set<string>> {
  const { byPath, byBasename } = buildPathIndexes(docs);

  const inbound = new Map<string, Set<string>>();
  for (const d of docs) {
    for (const raw of extractLinks(d.content)) {
      const target = resolveLink(raw, d.path, byPath, byBasename);
      if (!target || target === d.path) continue;
      if (!inbound.has(target)) inbound.set(target, new Set());
      (inbound.get(target) as Set<string>).add(d.path);
    }
  }
  return inbound;
}

// Runs every lint check across the vault and returns a grouped report.
export async function runLint(
  vaultRoot: string,
  opts: LintOptions = {},
): Promise<Result<LintReport, Error>> {
  const loaded = await loadDocuments(vaultRoot);
  if (!loaded.ok) return loaded;
  const docs = loaded.value;

  const now = opts.now ?? new Date();
  const draftMaxDays = opts.draftMaxDays ?? DRAFT_MAX_DAYS;
  const lowConfidenceMaxDays = opts.lowConfidenceMaxDays ?? LOW_CONFIDENCE_MAX_DAYS;
  const inbound = buildInboundMap(docs);
  const byPath = new Map(docs.map((d) => [d.path, d]));

  // The set of every question answered anywhere in the vault, normalized. A
  // question raised in one document counts as answered if any document — that
  // one or another — lists it under questions_answered.
  const answeredQuestions = new Set<string>();
  for (const d of docs) {
    for (const q of d.frontmatter.questions_answered) {
      const n = normalizeQuestion(q);
      if (n) answeredQuestions.add(n);
    }
  }

  const checks: Record<LintCheckName, LintFinding[]> = {
    staleFiles: [],
    orphanFiles: [],
    oldDrafts: [],
    stagnantLowConfidence: [],
    deprecatedStillLinked: [],
    unansweredQuestions: [],
  };

  for (const doc of docs) {
    const fm = doc.frontmatter;

    // 1. Stale: a document at or past its TTL.
    const staleness = computeStaleness({ updated: fm.updated, ttl_days: fm.ttl_days }, now);
    if (staleness.expired) {
      checks.staleFiles.push({
        path: doc.path,
        detail:
          `${staleness.ageDays}d since update, ttl ${staleness.ttlDays}d ` +
          `(decay score ${staleness.score.toFixed(2)})`,
      });
    }

    // 2. Orphan: no other document links to it.
    if (!inbound.has(doc.path)) {
      checks.orphanFiles.push({
        path: doc.path,
        detail: "no inbound links from any vault document",
      });
    }

    // 3. Old draft: still a draft well past the draft age limit.
    if (fm.status === "draft") {
      const anchor = fm.created || fm.updated;
      const draftAge = ageInDays(anchor, now);
      if (draftAge > draftMaxDays) {
        checks.oldDrafts.push({
          path: doc.path,
          detail: `draft for ${draftAge}d (limit ${draftMaxDays}d)`,
        });
      }
    }

    // 4. Stagnant low-confidence: low confidence and untouched too long.
    if (fm.confidence === "low") {
      const idleDays = ageInDays(fm.updated, now);
      if (idleDays >= lowConfidenceMaxDays) {
        checks.stagnantLowConfidence.push({
          path: doc.path,
          detail:
            `low confidence, unchanged for ${idleDays}d ` + `(limit ${lowConfidenceMaxDays}d)`,
        });
      }
    }

    // 5. Deprecated but still linked from a canonical document.
    if (fm.status === "deprecated") {
      const linkers = [...(inbound.get(doc.path) ?? [])].filter(
        (from) => byPath.get(from)?.frontmatter.status === "canonical",
      );
      if (linkers.length > 0) {
        checks.deprecatedStillLinked.push({
          path: doc.path,
          detail: `still linked from canonical: ${linkers.sort().join(", ")}`,
        });
      }
    }

    // 6. Unanswered questions: questions raised here that no vault document
    // lists as answered. Turns the questions_raised field into a coverage map.
    const orphanQuestions = fm.questions_raised.filter((q) => {
      const n = normalizeQuestion(q);
      return n.length > 0 && !answeredQuestions.has(n);
    });
    if (orphanQuestions.length > 0) {
      checks.unansweredQuestions.push({
        path: doc.path,
        detail:
          `${orphanQuestions.length} question(s) raised but not answered in ` +
          `any document: ${orphanQuestions.join("; ")}`,
      });
    }
  }

  const totalFindings = LINT_CHECKS.reduce((n, name) => n + checks[name].length, 0);

  const tensionHealth = await computeTensionHealth(vaultRoot, now);
  if (!tensionHealth.ok) return tensionHealth;

  return ok({
    generatedAt: now.toISOString(),
    checks,
    totalFindings,
    tensionHealth: tensionHealth.value,
  });
}

// Aggregates the tension log into the Phase 1 health summary plus the Phase 4
// aging breakdown. A missing log is not an error — every counter is zero.
//
// Aging scope: tiers are counted over the active surface only. An entry
// contributes to fresh / aging / stale iff it is unresolved AND `agingTier`
// returns a non-null tier (which already excludes `unspecified`). Resolved
// entries — including `resolution.kind: accepted` — do not appear in any
// aging tier; they show up in the Phase 1 stable-acknowledged and resolved
// totals instead.
async function computeTensionHealth(
  vaultRoot: string,
  now: Date,
): Promise<Result<TensionHealth, Error>> {
  const tensions = await listTensions(vaultRoot);
  if (!tensions.ok) return tensions;

  const byKind = Object.fromEntries(TENSION_KINDS.map((k) => [k, 0])) as Record<
    TensionKind,
    number
  >;
  const byResolutionKind = Object.fromEntries(RESOLUTION_KINDS.map((k) => [k, 0])) as Record<
    ResolutionKind,
    number
  >;
  const staleByKind = Object.fromEntries(TENSION_KINDS.map((k) => [k, 0])) as Record<
    TensionKind,
    number
  >;
  let total = 0;
  let resolvedLifetime = 0;
  let stableAcknowledged = 0;
  let unspecifiedLegacy = 0;
  let fresh = 0;
  let aging = 0;
  let stale = 0;

  for (const t of tensions.value) {
    total += 1;
    byKind[t.kind] += 1;
    if (t.kind === "unspecified") unspecifiedLegacy += 1;
    if (t.resolution) {
      resolvedLifetime += 1;
      byResolutionKind[t.resolution.kind] += 1;
      if (t.resolution.kind === "accepted") stableAcknowledged += 1;
    }

    if (t.resolved) continue;
    const tier = agingTier(t, now);
    if (tier === "fresh") fresh += 1;
    else if (tier === "aging") aging += 1;
    else if (tier === "stale") {
      stale += 1;
      staleByKind[t.kind] += 1;
    }
  }

  // Render kind-specific stale-tier copy only for kinds with a nonzero count.
  // `unspecified` never produces a message even if the count somehow appears
  // (it can't, since unspecified entries get tier null — defense in depth).
  const staleMessages: Partial<Record<Exclude<TensionKind, "unspecified">, string>> = {};
  for (const kind of ["temporal", "factual", "interpretive"] as const) {
    if (staleByKind[kind] > 0) {
      staleMessages[kind] = STALE_TIER_LINT_COPY[kind];
    }
  }

  // Cluster surface (Phase 2). computeTensionClusters applies the same scope
  // filter the cluster tool does — unresolved AND non-accepted — so the lint
  // metrics line up exactly with what `vault_tension_clusters` reports.
  const clusterResult = computeTensionClusters(tensions.value, now);
  let maxSize = 0;
  let large = 0;
  let aged = 0;
  for (const c of clusterResult.clusters) {
    if (c.size > maxSize) maxSize = c.size;
    if (c.size > 5) large += 1;
    if (c.oldest_tension_age_days > 90) aged += 1;
  }
  const clusters: TensionClustersHealth = {
    count: clusterResult.cluster_count,
    maxSize,
    large,
    aged,
  };

  return ok({
    total,
    byKind,
    resolvedLifetime,
    byResolutionKind,
    stableAcknowledged,
    unspecifiedLegacy,
    aging: { fresh, aging, stale, staleByKind, staleMessages },
    clusters,
  });
}
