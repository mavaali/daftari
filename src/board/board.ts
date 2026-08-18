// board.ts — U9: Board engine.
//
// Assembles registry → RBAC → reconcile → columns behind one call.
//
// Public API
// ----------
//
//   listBoard(vaultRoot, access, filters?, now?)
//     → Promise<BoardResult>
//
// Return shape
// ------------
//
//   { columns: Record<BoardColumn, Finding[]>, all: Finding[] }
//
//   Rationale: `columns` is what the board UI (U13) renders directly; `all`
//   is what the REST API (U12) exposes for programmatic consumers that want a
//   flat list without re-aggregating.  Both carry Finding[], so the caller
//   always has the full typed shape — no conversion required on either path.
//
// Filter semantics (R26)
// ----------------------
//
//   Filters are applied AFTER reconcile, to the reconciled findings.
//   Emit is persisted BEFORE filter application — filters are a VIEW concern
//   and do NOT affect what gets written to the ledger.
//
//   collection
//     - lint/staleness target: first path segment of target.path
//       (e.g. "notes/foo.md" → "notes")
//     - tension target: first path segment of sourceA (evidence.sourceA)
//       Rationale: sourceA is the "primary" side of a tension; it is the
//       document the triage owner is most likely curating. Documented here
//       so U12/U13 can surface this choice.
//     - staged target: first path segment of the finding's evidence.target_path
//       (the path the staged action targets)
//     - tier2 target: first path segment of artifact
//       Rationale: artifact is the dependent document, which is the entity
//       that needs attention from the collection's curator.
//
//   check
//     - Equality match on finding.check.
//
//   certainty
//     - Equality match on finding.certainty (Confidence: "low"|"medium"|"high").
//
//   owner
//     - Equality match on finding.owner.
//
//   minAgeDays
//     - Keep findings whose first_seen is >= minAgeDays ago relative to `now`.
//       age = Math.floor((now - first_seen) / 86_400_000) >= minAgeDays.
//       A minAgeDays of 0 keeps everything (all findings are at least 0 days old).
//
//   document
//     - lint/staleness: target.path === document.
//     - staged: evidence.target_path === document.
//     - tension: evidence.sourceA === document || evidence.sourceB === document.
//     - tier2: target.artifact === document || target.unit === document.
//
// RBAC
// ----
//   Each source adapter's list() applies RBAC internally. The engine does NOT
//   re-filter; it simply concats all adapter results (R22). The adapters are
//   the RBAC enforcement point (R17/R18).
//
// Zero-writes guarantee (R7)
// --------------------------
//   If reconcile's emit is empty, appendEvent is never called. The ledger file
//   is untouched. An unused board (no prior dispositions, no resolvable
//   transitions) makes exactly zero filesystem writes.
//
// Reopen idempotency (R6)
// -----------------------
//   Emit events are persisted ONCE, here. On the next listBoard call,
//   loadLedger re-reads the persisted "reopened" event; reconcile sees
//   latest="reopened" and does NOT re-emit. The test in board.test.ts
//   verifies this end-to-end.

import { appendEvent, loadLedger } from "./ledger.js";
import { reconcile } from "./reconcile.js";
import { SOURCE_ADAPTERS } from "./sources/index.js";
import type { AccessContext, BoardColumn, Confidence, Finding, FindingTarget } from "./types.js";

// ---------------------------------------------------------------------------
// BoardFilters — all optional. Filters narrow the VIEW; they do not affect
// what is persisted to the ledger.
// ---------------------------------------------------------------------------

export interface BoardFilters {
  /** Keep findings whose collection (see module comment) equals this value. */
  collection?: string;
  /** Keep findings whose check equals this value. */
  check?: string;
  /** Keep findings whose certainty equals this value. */
  certainty?: Confidence;
  /** Keep findings whose owner equals this value. */
  owner?: string;
  /**
   * Keep findings whose first_seen is at least this many days before `now`.
   * age = Math.floor((now - first_seen) / 86_400_000) >= minAgeDays.
   * 0 keeps everything.
   */
  minAgeDays?: number;
  /**
   * Keep findings that reference this vault-relative document path.
   * See module comment for per-target-kind semantics.
   */
  document?: string;
}

// ---------------------------------------------------------------------------
// BoardResult — the shape listBoard returns.
// ---------------------------------------------------------------------------

export interface BoardResult {
  /**
   * Findings grouped by disposition column. Every Finding appears in exactly
   * one column. The five columns are always present (possibly empty arrays).
   */
  columns: Record<BoardColumn, Finding[]>;
  /**
   * Flat list of all reconciled (and post-filter) findings. Equivalent to
   * Object.values(columns).flat() — provided for programmatic access so
   * callers need not re-aggregate from columns.
   */
  all: Finding[];
}

// ---------------------------------------------------------------------------
// collectionOf — derive the "collection" for filter matching.
// ---------------------------------------------------------------------------

function collectionOf(finding: Finding): string | undefined {
  const t: FindingTarget = finding.target;
  switch (t.kind) {
    case "lint":
    case "staleness":
      // First path segment of the vault-relative path.
      return t.path.split("/")[0];

    case "staged": {
      // Staged actions carry the target_path in evidence.
      const tp = (finding.evidence as { target_path?: string }).target_path;
      if (typeof tp === "string") return tp.split("/")[0];
      return undefined;
    }

    case "tension": {
      // First path segment of sourceA (the "primary" side).
      // Documented in module comment.
      const sa = (finding.evidence as { sourceA?: string }).sourceA;
      if (typeof sa === "string") return sa.split("/")[0];
      return undefined;
    }

    case "tier2":
      // First path segment of artifact (the dependent document).
      return t.artifact.split("/")[0];

    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// documentOf — check whether a finding references a given document path.
// ---------------------------------------------------------------------------

function documentMatches(finding: Finding, document: string): boolean {
  const t: FindingTarget = finding.target;
  switch (t.kind) {
    case "lint":
      return t.path === document;
    case "staleness":
      return t.path === document;
    case "staged": {
      const tp = (finding.evidence as { target_path?: string }).target_path;
      return tp === document;
    }
    case "tension": {
      const ev = finding.evidence as { sourceA?: string; sourceB?: string };
      return ev.sourceA === document || ev.sourceB === document;
    }
    case "tier2":
      return t.artifact === document || t.unit === document;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// applyFilters — filter reconciled findings.
//
// Called AFTER emit persistence, so filters are strictly a view concern.
// ---------------------------------------------------------------------------

function applyFilters(findings: Finding[], filters: BoardFilters, now: Date): Finding[] {
  return findings.filter((f) => {
    if (filters.collection !== undefined) {
      if (collectionOf(f) !== filters.collection) return false;
    }
    if (filters.check !== undefined) {
      if (f.check !== filters.check) return false;
    }
    if (filters.certainty !== undefined) {
      if (f.certainty !== filters.certainty) return false;
    }
    if (filters.owner !== undefined) {
      if (f.owner !== filters.owner) return false;
    }
    if (filters.minAgeDays !== undefined) {
      const ageMs = now.getTime() - Date.parse(f.first_seen);
      const ageDays = Math.floor(ageMs / 86_400_000);
      if (ageDays < filters.minAgeDays) return false;
    }
    if (filters.document !== undefined) {
      if (!documentMatches(f, filters.document)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// groupByColumn — partition findings into their five disposition columns.
// ---------------------------------------------------------------------------

function groupByColumn(findings: Finding[]): Record<BoardColumn, Finding[]> {
  const columns: Record<BoardColumn, Finding[]> = {
    new: [],
    accepted: [],
    waiting: [],
    resolved: [],
    dismissed: [],
  };
  for (const f of findings) {
    columns[f.disposition].push(f);
  }
  return columns;
}

// ---------------------------------------------------------------------------
// listBoard — the public entry point.
//
// Steps:
//   1. now := now ?? new Date()
//   2. liveFindings := concat of every SOURCE_ADAPTERS[i].list(vaultRoot, access, now)
//   3. { byFinding } := loadLedger(vaultRoot)
//   4. { findings, emit } := reconcile(liveFindings, byFinding, now)
//   5. For each e in emit: appendEvent(vaultRoot, e)
//      (If an append fails, throw an error naming the finding_id — no silent swallow)
//   6. Apply filters to findings (AFTER emit persistence — filters are view-only)
//   7. Return { columns, all }
// ---------------------------------------------------------------------------

export async function listBoard(
  vaultRoot: string,
  access: AccessContext,
  filters?: BoardFilters,
  now?: Date,
): Promise<BoardResult> {
  const effectiveNow = now ?? new Date();

  // Step 2 — collect from all source adapters (source-agnostic concat, R22).
  // RBAC is applied inside each adapter; the engine does NOT re-filter.
  const perAdapterResults = await Promise.all(
    SOURCE_ADAPTERS.map((adapter) => adapter.list(vaultRoot, access, effectiveNow)),
  );
  const liveFindings: Finding[] = ([] as Finding[]).concat(...perAdapterResults);

  // Step 3 — load ledger.
  const ledgerResult = await loadLedger(vaultRoot);
  if (!ledgerResult.ok) {
    throw new Error(`listBoard: cannot load ledger: ${ledgerResult.error.message}`);
  }
  const { byFinding } = ledgerResult.value;

  // Step 4 — reconcile (pure).
  const { findings, emit } = reconcile(liveFindings, byFinding, effectiveNow);

  // Step 5 — persist system events (the ONE write path for system events).
  // Zero emit → zero writes (R7).
  for (const event of emit) {
    const appendResult = await appendEvent(vaultRoot, event);
    if (!appendResult.ok) {
      throw new Error(
        `listBoard: cannot append system event for finding ${event.finding_id}: ${appendResult.error.message}`,
      );
    }
  }

  // Step 6 — apply filters (view concern, does NOT affect what was persisted).
  const visibleFindings =
    filters !== undefined && Object.keys(filters).length > 0
      ? applyFilters(findings, filters, effectiveNow)
      : findings;

  // Step 7 — group and return.
  const columns = groupByColumn(visibleFindings);
  return { columns, all: visibleFindings };
}
