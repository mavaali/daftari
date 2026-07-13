// The vault as witness — per-principal track records, priced by the wager
// schedule. (Positioning ideas 4 + 9, gated on and cleared by the CB7
// result.)
//
// Every write already carries an identity (§11.6), every proposal an
// outcome, every tension a logger and a resolution. This module aggregates
// what the ledger already recorded into a reliability curve per principal —
// and prices it: writing a claim at a confidence level stakes wager points;
// a claim later corrected or retired by someone else burns the stake; a
// claim maintained through a full TTL cycle earns credit. Everything is
// computed at read time from the logs — no new persistent state, no
// enforcement, nothing minted. The constants are provisional and exported:
// they are the thing being calibrated, exactly like the §11.5 impact table.
//
// Kill-condition instrumentation (stated in the positioning doc):
//   idea 4 — if one principal does ~all the writing, the curves are flat and
//   track records are uninformative: `concentration` reports it, and the
//   caller sees `flatCurveWarning` instead of a false signal.
//   idea 9 — if stake-fear suppresses true claims, write volume drops:
//   `firstWriteAt`/`lastWriteAt`/`writes` give the longitudinal series an
//   external monitor needs.

import { type AccessContext, canRead } from "../access/rbac.js";
import { readProvenanceLog } from "../curation/provenance.js";
import { listStagedActions } from "../curation/staged-actions.js";
import { ageInDays, computeStaleness } from "../curation/staleness.js";
import { listTensions } from "../curation/tension.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { ok, type Result } from "../frontmatter/types.js";

// The wager schedule (provisional; exported for calibration). Confidence is
// free to claim — the stake makes it cost something. `low` is deliberately
// free: hedged claims are the honest default and must never be taxed.
export const WAGER_STAKES: Record<string, number> = { low: 0, medium: 1, high: 3 };
// Credit for a claim maintained through at least one full TTL cycle.
export const WAGER_SURVIVAL_CREDIT = 1;
// A claim whose document has since been deleted burns at the medium stake —
// its confidence at write time is no longer recoverable without a ledger.
export const WAGER_GONE_STAKE = 1;
// Write-share above which track records are declared uninformative (idea 4's
// kill condition: one author, flat curves).
export const FLAT_CURVE_SHARE = 0.95;

export function stakeFor(confidence: string): number {
  return WAGER_STAKES[confidence] ?? WAGER_GONE_STAKE;
}

export interface PrincipalRecord {
  principal: string;
  // Raw activity (the idea-9 longitudinal series).
  writes: number;
  firstWriteAt: string | null;
  lastWriteAt: string | null;
  docsAuthored: number;
  // The open book.
  liveClaims: number; // authored docs currently canonical
  openExposure: number; // Σ stake(confidence) over live claims
  contestedOpen: number; // live claims under unresolved tensions
  stakeAtRisk: number; // Σ stakes on contested claims
  // The settled book.
  lost: number; // authored docs retired (deprecated/superseded/gone) or corrected by ruling
  burnedStake: number;
  survived: number; // authored docs maintained through ≥1 full TTL cycle, still canonical
  creditEarned: number;
  balance: number; // creditEarned − burnedStake (advisory; provisional constants)
  // Proposal record (staged actions).
  proposals: {
    total: number;
    ratified: number;
    rejected: number;
    expired: number;
    pending: number;
  };
  tensionsLogged: number;
}

export interface WitnessResult {
  principals: PrincipalRecord[];
  unattributedDocs: number; // docs with no provenance history — nobody's record
  concentration: { topPrincipal: string | null; topShare: number };
  flatCurveWarning: boolean;
}

function topCollection(relPath: string): string {
  return relPath.split("/")[0] ?? "";
}

export async function buildWitness(
  vaultRoot: string,
  now: Date = new Date(),
  access?: AccessContext,
): Promise<Result<WitnessResult, Error>> {
  const log = await readProvenanceLog(vaultRoot);
  if (!log.ok) return log;
  const docs = await loadDocuments(vaultRoot);
  if (!docs.ok) return docs;
  const tensions = await listTensions(vaultRoot);
  if (!tensions.ok) return tensions;
  const actions = await listStagedActions(vaultRoot);
  if (!actions.ok) return actions;

  // RBAC: with an access context, everything is scoped to readable
  // collections (the vault_status precedent) — a witness report never leaks
  // activity counts from a denied collection.
  const readable = (path: string, fmCollection?: string): boolean =>
    !access || canRead(access.role, fmCollection || topCollection(path));

  const visibleLog = log.value.filter((e) => readable(e.file));
  const visibleDocs = docs.value.filter((d) => readable(d.path, d.frontmatter.collection));
  const docByPath = new Map(visibleDocs.map((d) => [d.path, d]));
  const visibleTensions = tensions.value.filter((t) => readable(t.sourceA) && readable(t.sourceB));
  const visibleActions = actions.value.filter((a) => readable(a.targetPath));

  // Authorship: the identity on a file's FIRST provenance entry. The
  // principal (authenticated, §11.6) outranks the free-text agent claim.
  const authorOf = new Map<string, string>();
  const identityOf = (e: { principal?: string; agent: string }): string => e.principal ?? e.agent;
  for (const e of visibleLog) {
    if (!authorOf.has(e.file)) authorOf.set(e.file, identityOf(e));
  }

  // Contested / corrected doc sets from the tension log.
  const contestedDocs = new Set<string>();
  const correctedDocs = new Set<string>();
  for (const t of visibleTensions) {
    if (!t.resolved) {
      contestedDocs.add(t.sourceA);
      contestedDocs.add(t.sourceB);
    } else if (t.resolution?.kind === "corrected") {
      correctedDocs.add(t.sourceA);
      correctedDocs.add(t.sourceB);
    }
  }

  const records = new Map<string, PrincipalRecord>();
  const recordFor = (principal: string): PrincipalRecord => {
    let r = records.get(principal);
    if (!r) {
      r = {
        principal,
        writes: 0,
        firstWriteAt: null,
        lastWriteAt: null,
        docsAuthored: 0,
        liveClaims: 0,
        openExposure: 0,
        contestedOpen: 0,
        stakeAtRisk: 0,
        lost: 0,
        burnedStake: 0,
        survived: 0,
        creditEarned: 0,
        balance: 0,
        proposals: { total: 0, ratified: 0, rejected: 0, expired: 0, pending: 0 },
        tensionsLogged: 0,
      };
      records.set(principal, r);
    }
    return r;
  };

  for (const e of visibleLog) {
    const r = recordFor(identityOf(e));
    r.writes += 1;
    if (r.firstWriteAt === null || e.timestamp < r.firstWriteAt) r.firstWriteAt = e.timestamp;
    if (r.lastWriteAt === null || e.timestamp > r.lastWriteAt) r.lastWriteAt = e.timestamp;
  }

  for (const [path, author] of authorOf) {
    const r = recordFor(author);
    r.docsAuthored += 1;
    const doc = docByPath.get(path);

    if (!doc) {
      // The claim's document is gone — settled against the author.
      r.lost += 1;
      r.burnedStake += WAGER_GONE_STAKE;
      continue;
    }
    const fm = doc.frontmatter;
    const stake = stakeFor(fm.confidence);
    const retired = fm.status === "deprecated" || fm.status === "superseded";

    if (retired || correctedDocs.has(path)) {
      r.lost += 1;
      r.burnedStake += stake;
      continue;
    }
    if (fm.status !== "canonical") continue; // drafts/archived: no live claim, no wager

    r.liveClaims += 1;
    r.openExposure += stake;
    if (contestedDocs.has(path)) {
      r.contestedOpen += 1;
      r.stakeAtRisk += stake;
    }
    // Survived: maintained through at least one full TTL cycle — old enough
    // to have needed re-verification, and not currently expired.
    const s = computeStaleness({ updated: fm.updated, ttl_days: fm.ttl_days }, now);
    if (fm.ttl_days !== null && ageInDays(fm.created, now) >= fm.ttl_days && !s.expired) {
      r.survived += 1;
      r.creditEarned += WAGER_SURVIVAL_CREDIT;
    }
  }

  for (const a of visibleActions) {
    const r = recordFor(a.proposedBy);
    r.proposals.total += 1;
    if (a.status === "ratified" || a.status === "ratified-pending-tool") r.proposals.ratified += 1;
    else if (a.status === "rejected") r.proposals.rejected += 1;
    else if (a.status === "expired") r.proposals.expired += 1;
    else r.proposals.pending += 1;
  }

  for (const t of visibleTensions) {
    if (t.loggedBy) recordFor(t.loggedBy).tensionsLogged += 1;
  }

  const principals = [...records.values()];
  for (const r of principals) r.balance = r.creditEarned - r.burnedStake;
  principals.sort((a, b) => b.writes - a.writes || a.principal.localeCompare(b.principal));

  const totalWrites = principals.reduce((n, r) => n + r.writes, 0);
  const top = principals[0];
  const topShare = totalWrites > 0 && top ? top.writes / totalWrites : 0;

  const unattributedDocs = visibleDocs.filter((d) => !authorOf.has(d.path)).length;

  return ok({
    principals,
    unattributedDocs,
    concentration: { topPrincipal: top?.principal ?? null, topShare },
    flatCurveWarning: totalWrites > 0 && topShare >= FLAT_CURVE_SHARE,
  });
}
