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
// Flat credit for a live position aligned with the org stance at ratify time
// (created <= ratified_at — no bandwagoning onto an already-ratified stance).
// Flat, mirroring WAGER_SURVIVAL_CREDIT: the asymmetry with stake-
// proportional burns is deliberate — confidence inflation on the winning
// side earns nothing extra, while confident wrongness costs 3x.
export const POSITION_RATIFIED_CREDIT = 1;

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
  // The position wager book (multi-user contested beliefs). Same currency as
  // the doc book (WAGER_STAKES over Position.confidence); settled by the
  // CURRENT ratification only — org_position.dissent is the settlement
  // carrier (server-computed at ratify time, LD-18), tension resolutions
  // modulate it: `accepted` exempts (standing dissent — taxing it would make
  // the book punish the keystone), `corrected` extends the burn to both
  // parties, `superseded`/`invalid` settle nothing. Self-revision is
  // structurally free: position supersession is always self-supersession
  // (applyAssert + the foreign-position guard), so a superseded entry never
  // stakes and never burns. pos-000 (principal "unknown") prices nothing.
  positions: {
    // Activity (the idea-9 longitudinal series for stance-taking).
    taken: number; // all entries authored, live + superseded
    live: number; // superseded_by == null
    firstAt: string | null; // min Position.created
    lastAt: string | null; // max Position.created
    // The open book.
    exposure: number; // sum of stakeFor(confidence) over live positions
    contestedOpen: number; // live positions party to an unresolved positional tension
    stakeAtRisk: number; // sum of stakes over those
    // The settled book (current ratification only).
    selfRevised: number; // superseded entries — honest updating, never taxed
    dissented: number; // live ids in the current org_position.dissent
    standingDissent: number; // subset under an `accepted` resolution — priced 0
    corrected: number; // live party to a `corrected`-resolved positional tension
    burned: number; // at most one burn per position (dissent/corrected deduped)
    ratifiedAligned: number; // live, stance === org stance, created <= ratified_at
    credited: number; // ratifiedAligned x POSITION_RATIFIED_CREDIT
    balance: number; // credited − burned (advisory; provisional constants)
  };
}

export interface WitnessResult {
  principals: PrincipalRecord[];
  unattributedDocs: number; // docs with no provenance history — nobody's record
  legacyPositions: number; // pos-000 system snapshots — nobody's record
  concentration: { topPrincipal: string | null; topShare: number };
  positionConcentration: { topPrincipal: string | null; topShare: number };
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

  // Contested / corrected doc sets from the tension log. Positional tensions
  // are excluded — they price the POSITION holders (below), not the doc
  // author: burning the scaffolder's doc stake for other principals' dispute
  // is exactly the cross-wiring that makes the doc book noisy under
  // multi-user, and the R-9 low-cap zeroes the contested doc's stake anyway.
  const contestedDocs = new Set<string>();
  const correctedDocs = new Set<string>();
  for (const t of visibleTensions) {
    if (t.kind === "positional") continue;
    if (!t.resolved) {
      contestedDocs.add(t.sourceA);
      contestedDocs.add(t.sourceB);
    } else if (t.resolution?.kind === "corrected") {
      correctedDocs.add(t.sourceA);
      correctedDocs.add(t.sourceB);
    }
  }

  // Positional-tension settlement carriers, keyed by position id per doc.
  // (Positional tensions are self-tensions: sourceA === sourceB === the doc.)
  const openPositional = new Set<string>(); // `${doc} ${positionId}`
  const acceptedPositional = new Set<string>();
  const correctedPositional = new Set<string>();
  const posKey = (doc: string, id: string): string => `${doc} ${id}`;
  for (const t of visibleTensions) {
    if (t.kind !== "positional" || !t.positionA || !t.positionB) continue;
    const target = !t.resolved
      ? openPositional
      : t.resolution?.kind === "accepted"
        ? acceptedPositional
        : t.resolution?.kind === "corrected"
          ? correctedPositional
          : null;
    if (!target) continue; // `superseded`/`invalid` resolutions settle nothing
    target.add(posKey(t.sourceA, t.positionA));
    target.add(posKey(t.sourceA, t.positionB));
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
        positions: {
          taken: 0,
          live: 0,
          firstAt: null,
          lastAt: null,
          exposure: 0,
          contestedOpen: 0,
          stakeAtRisk: 0,
          selfRevised: 0,
          dissented: 0,
          standingDissent: 0,
          corrected: 0,
          burned: 0,
          ratifiedAligned: 0,
          credited: 0,
          balance: 0,
        },
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

  // The position pass: price each principal's stance-taking from visible
  // frontmatter. pos-000 legacy snapshots (principal "unknown", LD-22
  // unforgeable) price nothing and never materialize a record — counted once,
  // vault-level, the exact analog of unattributedDocs.
  let legacyPositions = 0;
  for (const doc of visibleDocs) {
    const fm = doc.frontmatter;
    if (fm.positions == null) continue;
    // Dead docs price nothing — the same gate as the doc book ("drafts/
    // archived: no live claim, no wager"): a retired doc's frozen
    // ratification must not keep paying credits or collecting burns.
    if (fm.status !== "canonical") continue;
    const org = fm.org_position ?? null;
    const byId = new Map(fm.positions.map((p) => [p.id, p]));

    // Resolve each dissent id through the self-supersession chain. A live
    // descendant with the SAME stance is a re-mint of the dissent — the
    // burn follows it (otherwise one no-op re-assert launders the loss); a
    // stance change is a genuine revision and stays free. Standing
    // (`accepted`) immunity attaches to any id along the chain.
    const dissentLive = new Set<string>();
    const standingLive = new Set<string>();
    for (const id of org?.dissent ?? []) {
      const origin = byId.get(id);
      if (!origin) continue; // dangling dissent id — lint's territory
      let cur = origin;
      const seen = new Set<string>([cur.id]);
      let standing = acceptedPositional.has(posKey(doc.path, cur.id));
      while (cur.superseded_by) {
        const next = byId.get(cur.superseded_by);
        if (!next || seen.has(next.id)) break; // dangling or cyclic chain
        cur = next;
        seen.add(cur.id);
        standing = standing || acceptedPositional.has(posKey(doc.path, cur.id));
      }
      if (cur.superseded_by !== null) continue; // no live end
      if (cur.stance !== origin.stance) continue; // flipped — free
      dissentLive.add(cur.id);
      if (standing) standingLive.add(cur.id);
    }

    for (const p of fm.positions) {
      if (p.principal === "unknown") {
        legacyPositions += 1;
        continue;
      }
      const book = recordFor(p.principal).positions;
      book.taken += 1;
      if (book.firstAt === null || p.created < book.firstAt) book.firstAt = p.created;
      if (book.lastAt === null || p.created > book.lastAt) book.lastAt = p.created;

      // Self-revision is free, full stop: a superseded entry is always the
      // holder's own revision, so it neither stakes nor settles.
      if (p.superseded_by !== null) {
        book.selfRevised += 1;
        continue;
      }

      const stake = stakeFor(p.confidence);
      book.live += 1;
      book.exposure += stake;

      const key = posKey(doc.path, p.id);
      if (openPositional.has(key)) {
        book.contestedOpen += 1;
        book.stakeAtRisk += stake;
      }

      // Settlement, by the current ratification. At most one burn per
      // position (dissent and corrected dedupe), and standing immunity is
      // absolute: dissent the org chose to keep (`accepted`) is priced 0
      // even when another tension on the same position resolved
      // `corrected` — taxing kept disagreement would make the book punish
      // the keystone.
      const standing = acceptedPositional.has(key) || standingLive.has(p.id);
      let burns = false;
      if (dissentLive.has(p.id)) {
        book.dissented += 1;
        if (standing) book.standingDissent += 1;
        else burns = true;
      }
      if (correctedPositional.has(key)) {
        book.corrected += 1;
        if (!standing) burns = true;
      }
      if (burns) book.burned += stake;

      // Alignment credit: live, same stance, and created at-or-before the
      // ratification — no bandwagoning onto an already-ratified stance.
      if (org && p.stance === org.stance && p.created <= org.ratified_at) {
        book.ratifiedAligned += 1;
        book.credited += POSITION_RATIFIED_CREDIT;
      }
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

  // Positional tensions are system-minted as a side effect of vault_assert —
  // counting them here would double-count every dispute as both a position
  // and a deliberate curation act.
  for (const t of visibleTensions) {
    if (t.kind === "positional") continue;
    if (t.loggedBy) recordFor(t.loggedBy).tensionsLogged += 1;
  }

  const principals = [...records.values()];
  for (const r of principals) {
    r.balance = r.creditEarned - r.burnedStake;
    r.positions.balance = r.positions.credited - r.positions.burned;
  }
  principals.sort((a, b) => b.writes - a.writes || a.principal.localeCompare(b.principal));

  const totalWrites = principals.reduce((n, r) => n + r.writes, 0);
  const top = principals[0];
  const topShare = totalWrites > 0 && top ? top.writes / totalWrites : 0;

  // Concentration over LIVE positions: superseded self-revisions price
  // nothing, so revision churn must not re-arm the flat-curve warning.
  const totalPositions = principals.reduce((n, r) => n + r.positions.live, 0);
  const posTop = [...principals].sort(
    (a, b) => b.positions.live - a.positions.live || a.principal.localeCompare(b.principal),
  )[0];
  const posTopShare = totalPositions > 0 && posTop ? posTop.positions.live / totalPositions : 0;

  const unattributedDocs = visibleDocs.filter((d) => !authorOf.has(d.path)).length;

  // Composite kill condition: the warning's contract is "track records are
  // uninformative", not "writes are concentrated". In the expected
  // multi-user regime — one scaffolding agent authors docs, many principals
  // hold positions — the write curve is flat by design while the position
  // curves carry the signal. Both concentrations are always reported, so
  // the caller sees WHICH curve is flat.
  const writesFlat = totalWrites > 0 && topShare >= FLAT_CURVE_SHARE;
  const positionsFlat = posTopShare >= FLAT_CURVE_SHARE;

  return ok({
    principals,
    unattributedDocs,
    legacyPositions,
    // topPrincipal is guarded on activity: a zero-write principal
    // materialized by the position pass must not be named top writer.
    concentration: {
      topPrincipal: totalWrites > 0 ? (top?.principal ?? null) : null,
      topShare,
    },
    positionConcentration: {
      topPrincipal: totalPositions > 0 ? (posTop?.principal ?? null) : null,
      topShare: posTopShare,
    },
    flatCurveWarning: writesFlat && (totalPositions === 0 || positionsFlat),
  });
}
