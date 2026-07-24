// vault_lint's engine — advisory cross-vault curation checks.
//
// Lint loads every document once, builds the inter-document link graph, then
// runs its battery of checks. It only ever *reports*: no file is edited, no
// status is changed, nothing is auto-fixed. The output is a structured report
// grouped by check, for a human (or an agent acting on a human's behalf) to
// triage. The three tier-0 checks (#232, tier0.ts) are certain rather than
// advisory judgments, but the posture is the same: report only.

import { ok, type Result } from "../frontmatter/types.js";
import { type CoverageEquitySummary, coverageEquitySummary } from "./coverage.js";
import { DRAFT_MAX_DAYS, LOW_CONFIDENCE_MAX_DAYS } from "./decay.js";
import { listEdges } from "./edges.js";
import { readProvenanceLog } from "./provenance.js";
import { type ReviewThroughputSummary, reviewThroughputSummary } from "./review-throughput.js";
import { listShadowActions, type ShadowLintSummary, shadowLintSummaryOf } from "./shadow.js";
import {
  listStagedActions,
  pendingLintItems,
  type StagedActionLintItem,
} from "./staged-actions.js";

export type { StagedActionLintItem } from "./staged-actions.js";

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
import { buildReverseLinkMap, buildReverseSourceMap, computeBlast } from "./tension-blast.js";
import { computeTensionClusters } from "./tension-clusters.js";
import { tier0Findings } from "./tier0.js";
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
  "tierDemotions",
  "brokenSourceRefs",
  "lifecycleConflicts",
  "schemaInvalid",
  "domainLeaks",
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
// documents than LARGE_CLUSTER_MIN_SIZE is large enough to warrant
// investigation, and a cluster whose oldest tension is older than
// AGED_CLUSTER_MIN_DAYS is tech debt. Counts only — `vault_lint` never
// auto-acts on them.
export const LARGE_CLUSTER_MIN_SIZE = 5;
export const AGED_CLUSTER_MIN_DAYS = 90;

export interface TensionClustersHealth {
  count: number;
  maxSize: number;
  large: number; // clusters where size > LARGE_CLUSTER_MIN_SIZE
  aged: number; // clusters where oldest_tension_age_days > AGED_CLUSTER_MIN_DAYS
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
  // Step 5 of the tension graph plan (2026-05-31). Cardinality of the
  // deduplicated `primary_blast` set (sources channel only) over the
  // union of contested docs from every entry where `resolved: false`
  // AND `agingTier === "stale"`. Zero when there are no stale
  // unresolved tensions. Reuses computeBlast — see tension-blast.ts.
  blastRadiusOfStaleTensions: number;
}

export interface LintReport {
  generatedAt: string;
  checks: Record<LintCheckName, LintFinding[]>;
  totalFindings: number;
  tensionHealth: TensionHealth;
  // Pending staged actions awaiting ratification (spec §11.2), soonest-to-
  // expire first. Empty when nothing is staged. Reported, not flagged — like
  // the rest of vault_lint. The actual expiry sweep is a side effect of the
  // vault_lint tool, not of runLint (which stays read-only).
  stagedActions: StagedActionLintItem[];
  // Shadow-mode summary (spec §11.5): how many writes were shadow-logged and
  // which would have been gated by the trust budget — the "Would-have-gated
  // actions" surface Decision 3's calibration reads. Zeroes when the vault has
  // never run shadow mode.
  shadowActions: ShadowLintSummary;
  // Coverage/equity summary (Stage 4 — spec §6.2): four budget-drift ratchets
  // over the cortex loop. Read-only monitor; never a target.
  coverageEquity: CoverageEquitySummary;
  // #235's headline measurement (quick win 2 of #236): proposal arrival rate
  // vs. review throughput over the staged-actions log. Vault-global counts by
  // design, like tensionHealth — no paths or principals cross here.
  reviewThroughput: ReviewThroughputSummary;
}

export interface LintOptions {
  now?: Date;
  draftMaxDays?: number; // a draft older than this is flagged
  lowConfidenceMaxDays?: number; // a low-confidence doc unchanged this long is flagged
  // #217: when set, findings compute from the caller's vantage — invisible
  // docs are excluded from the doc set BEFORE any check runs, so they are
  // neither named in findings nor counted as linkers. Filtering the output
  // instead would leak through absence (an unflagged "orphan" implies a
  // hidden linker exists). tensionHealth is exempt: vault-global counts by
  // design (see the 2026-07-14 edge-graph spec, decision C).
  pathVisible?: (path: string) => boolean;
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
  const allDocs = loaded.value;
  const pathVisible = opts.pathVisible;
  const docs = pathVisible ? allDocs.filter((d) => pathVisible(d.path)) : allDocs;

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
    tierDemotions: [],
    brokenSourceRefs: [],
    lifecycleConflicts: [],
    schemaInvalid: [],
    domainLeaks: [],
  };

  // 8-10. Tier 0 (#232; quick win 1 of #236): referential integrity over the
  // typed dependency channels (sources / superseded_by), lifecycle
  // consistency (canonical citing draft/deprecated/archived), and schema
  // conformance. Certain failures, not judgments — but reported like every
  // other check, never enforced here (enforcement lives in the ratify gate).
  // Computed over the caller-visible doc set like the rest of lint (#217):
  // a source the caller cannot read is indistinguishable from one that does
  // not exist.
  const t0 = tier0Findings(docs);
  checks.brokenSourceRefs = t0.brokenSourceRefs;
  checks.lifecycleConflicts = t0.lifecycleConflicts;
  checks.schemaInvalid = t0.schemaInvalid;
  checks.domainLeaks = t0.domainLeaks;

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

  // 7. Tier demotions (#141): every provenance entry that moved `tier` off
  // `source`, whatever tool did it — this is the tripwire that keeps the
  // demote-then-write escape hatch honest. Advisory, like everything here:
  // a demotion may be entirely legitimate (corrected re-ingest); whether it
  // was is a judgment call for review. Respects pathVisible (#217) — a
  // demotion names a doc path, so invisible paths are omitted, not coarsened.
  const provenance = await readProvenanceLog(vaultRoot);
  if (!provenance.ok) return provenance;
  for (const entry of provenance.value) {
    const tierChange = entry.frontmatter_diff?.tier;
    if (tierChange?.before !== "source" || tierChange.after === "source") continue;
    if (pathVisible && !pathVisible(entry.file)) continue;
    checks.tierDemotions.push({
      path: entry.file,
      detail:
        `tier demoted source→${String(tierChange.after ?? "unset")} by ${entry.agent} ` +
        `(${entry.tool}, ${entry.timestamp.slice(0, 10)})`,
    });
  }

  const totalFindings = LINT_CHECKS.reduce((n, name) => n + checks[name].length, 0);

  // Vault-global by design (#216 rider / #217 decision C): tension health is
  // the operator's whole-vault view, so it aggregates over ALL docs and
  // tensions regardless of pathVisible. Counts only — no paths cross here.
  const tensionHealth = await computeTensionHealth(vaultRoot, allDocs, now);
  if (!tensionHealth.ok) return tensionHealth;

  // Each JSONL log is read ONCE; the lint summaries and the coverage view
  // below are derived from the same in-memory records. Read order (staged,
  // shadow, edges) matches the pre-consolidation sequence so a multi-log
  // failure surfaces the same first error it always did.
  const stagedRes = await listStagedActions(vaultRoot);
  if (!stagedRes.ok) return stagedRes;
  const shadowRecordsRes = await listShadowActions(vaultRoot);
  if (!shadowRecordsRes.ok) return shadowRecordsRes;
  const edgesRes = await listEdges(vaultRoot, {}, now);
  if (!edgesRes.ok) return edgesRes;

  const stagedActions = pendingLintItems(stagedRes.value, now);
  const shadowActions = shadowLintSummaryOf(shadowRecordsRes.value);
  const coverageEquityRes = coverageEquitySummary({
    docs,
    edges: edgesRes.value,
    shadowRecords: shadowRecordsRes.value,
    stagedActions: stagedRes.value,
    now,
  });
  if (!coverageEquityRes.ok) return coverageEquityRes;

  return ok({
    generatedAt: now.toISOString(),
    checks,
    totalFindings,
    tensionHealth: tensionHealth.value,
    stagedActions,
    shadowActions,
    coverageEquity: coverageEquityRes.value,
    reviewThroughput: reviewThroughputSummary(stagedRes.value, now),
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
  docs: LoadedDoc[],
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
  for (const kind of ["temporal", "factual", "interpretive", "inter-proposal"] as const) {
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
    if (c.size > LARGE_CLUSTER_MIN_SIZE) large += 1;
    if (c.oldest_tension_age_days > AGED_CLUSTER_MIN_DAYS) aged += 1;
  }
  const clusters: TensionClustersHealth = {
    count: clusterResult.cluster_count,
    maxSize,
    large,
    aged,
  };

  // Step 5 of the tension graph plan (2026-05-31). Collect every contested
  // doc from every entry where `resolved: false` AND `agingTier === "stale"`,
  // then reuse computeBlast to walk the dependency graph from that union as
  // seeds. We report the count of the `primary_blast` channel — the same
  // sources-only primary set that vault_tension_blast returns. Advisory link
  // edges still participate in BFS traversal (so a doc reached via a link
  // edge can still gain `source` classification from a separate incoming
  // source edge), but the published metric is the primary count only — the
  // top-level lint metric stays disciplined against advisory inflation.
  const staleSeeds = new Set<string>();
  for (const t of tensions.value) {
    if (t.resolved) continue;
    if (agingTier(t, now) !== "stale") continue;
    if (t.sourceA) staleSeeds.add(t.sourceA);
    if (t.sourceB) staleSeeds.add(t.sourceB);
  }
  const reverseSource = buildReverseSourceMap(docs);
  const reverseLink = buildReverseLinkMap(docs);
  const blast = computeBlast({
    seeds: [...staleSeeds],
    reverseSource,
    reverseLink,
  });

  return ok({
    total,
    byKind,
    resolvedLifetime,
    byResolutionKind,
    stableAcknowledged,
    unspecifiedLegacy,
    aging: { fresh, aging, stale, staleByKind, staleMessages },
    clusters,
    blastRadiusOfStaleTensions: blast.primary_blast,
  });
}
