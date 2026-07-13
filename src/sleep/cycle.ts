// The circadian cycle — what the vault metabolizes overnight.
//
// `daftari sleep` composes machinery that already exists (staleness scoring,
// blast radius, the tension docket, the staged-action queue) into one
// deterministic nightly pass. Nothing here calls an LLM, edits a document,
// or resolves anything: the cycle measures decay, ranks what needs waking,
// sweeps expired proposals, and reports. Re-verifying a decayed document is
// an agent's job (the wake queue is written for one); deciding is a human's
// (the morning report ends at the ratification queue and the court docket).
//
// The domain split is honored: only ACCUMULATION documents wake. A
// generative document going stale is expected, not a defect — it is counted,
// never woken.

import { buildDocket } from "../court/docket.js";
import { daysUntil, listStagedActions, sweepExpiredActions } from "../curation/staged-actions.js";
import { computeStaleness } from "../curation/staleness.js";
import { agingTier, listTensions } from "../curation/tension.js";
import {
  buildReverseLinkMap,
  buildReverseSourceMap,
  computeBlast,
} from "../curation/tension-blast.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { ok, type Result } from "../frontmatter/types.js";

// A load-bearing decayed document: canonical, accumulation-domain, past its
// TTL, with at least one downstream dependent. The wake queue exists for an
// external agent to re-verify these against their sources — daftari never
// re-verifies on its own.
export interface WakeTask {
  path: string;
  title: string;
  collection: string;
  ageDays: number;
  ttlDays: number | null;
  blastPrimary: number;
  blastAdvisory: number;
  blastTotal: number;
  sources: string[];
  reason: string;
}

export interface QuietDecay {
  path: string;
  ageDays: number;
}

export interface SleepCycleResult {
  staleness: { fresh: number; aging: number; stale: number; total: number };
  // Ranked: widest blast first, then oldest.
  wake: WakeTask[];
  // Expired accumulation docs with no downstream dependents — noted, not woken.
  decayedQuiet: QuietDecay[];
  // Generative docs past TTL — expected, counted for completeness only.
  generativeStale: number;
  tensions: {
    open: number;
    stale: { id: string | null; title: string; ageDays: number }[];
    docketTop: { id: string | null; title: string; tier: string; blastTotal: number }[];
  };
  ratification: {
    pending: number;
    expiringSoon: { id: string; actionType: string; targetPath: string; daysLeft: number }[];
    // The kill-condition monitor from the circadian design: if humans
    // rubber-stamp (rejected ≈ 0 while ratified climbs) or stop looking
    // (expired climbs), the loop has become theater. Reported every morning.
    history: { ratified: number; rejected: number; expired: number };
  };
  sweptExpired: string[];
}

export async function runSleepCycle(
  vaultRoot: string,
  now: Date = new Date(),
): Promise<Result<SleepCycleResult, Error>> {
  // Housekeeping first, so the report reflects the post-sweep queue — the
  // same order lint uses.
  const swept = await sweepExpiredActions(vaultRoot, now);
  if (!swept.ok) return swept;

  const docs = await loadDocuments(vaultRoot);
  if (!docs.ok) return docs;

  const reverseSource = buildReverseSourceMap(docs.value);
  const reverseLink = buildReverseLinkMap(docs.value);

  const staleness = { fresh: 0, aging: 0, stale: 0, total: 0 };
  const wake: WakeTask[] = [];
  const decayedQuiet: QuietDecay[] = [];
  let generativeStale = 0;

  for (const doc of docs.value) {
    const s = computeStaleness(
      { updated: doc.frontmatter.updated, ttl_days: doc.frontmatter.ttl_days },
      now,
    );
    staleness.total += 1;
    if (s.score >= 1) staleness.stale += 1;
    else if (s.score >= 0.5) staleness.aging += 1;
    else staleness.fresh += 1;

    if (!s.expired) continue;
    if (doc.frontmatter.domain === "generative") {
      generativeStale += 1;
      continue;
    }
    if (doc.frontmatter.status !== "canonical") continue;

    const blast = computeBlast({ seeds: [doc.path], reverseSource, reverseLink });
    if (blast.downstream.length === 0) {
      decayedQuiet.push({ path: doc.path, ageDays: s.ageDays });
      continue;
    }
    wake.push({
      path: doc.path,
      title: doc.frontmatter.title,
      collection: doc.frontmatter.collection || (doc.path.split("/")[0] ?? ""),
      ageDays: s.ageDays,
      ttlDays: s.ttlDays,
      blastPrimary: blast.primary_blast,
      blastAdvisory: blast.advisory_blast,
      blastTotal: blast.downstream.length,
      sources: doc.frontmatter.sources,
      reason:
        `canonical, ${s.ageDays}d since update (TTL ${s.ttlDays}d), ` +
        `${blast.downstream.length} downstream document(s) depend on it — ` +
        `re-verify against its sources and stage the diff for ratification`,
    });
  }

  wake.sort((a, b) =>
    a.blastTotal !== b.blastTotal
      ? b.blastTotal - a.blastTotal
      : b.ageDays - a.ageDays || a.path.localeCompare(b.path),
  );
  decayedQuiet.sort((a, b) => b.ageDays - a.ageDays || a.path.localeCompare(b.path));

  // Tension surface: unresolved counts, the stale tier, and the docket head.
  const tensions = await listTensions(vaultRoot);
  if (!tensions.ok) return tensions;
  const openTensions = tensions.value.filter((t) => !t.resolved);
  const staleTensions = openTensions
    .filter((t) => agingTier(t, now) === "stale")
    .map((t) => ({
      id: t.id ?? null,
      title: t.title,
      ageDays: Math.max(
        0,
        Math.floor((now.getTime() - Date.parse(`${t.date}T00:00:00Z`)) / 86_400_000),
      ),
    }));

  const docket = await buildDocket(vaultRoot, now);
  if (!docket.ok) return docket;
  const docketTop = docket.value.entries.slice(0, 3).map((e) => ({
    id: e.id,
    title: e.title,
    tier: e.agingTier ?? "unclassified",
    blastTotal: e.blast.total,
  }));

  // Ratification queue + the rubber-stamp monitor.
  const actions = await listStagedActions(vaultRoot);
  if (!actions.ok) return actions;
  const pending = actions.value.filter((a) => a.status === "pending");
  const expiringSoon = pending
    .map((a) => ({
      id: a.id,
      actionType: a.actionType,
      targetPath: a.targetPath,
      daysLeft: daysUntil(a.expiresAt, now),
    }))
    .filter((a) => a.daysLeft <= 3)
    .sort((a, b) => a.daysLeft - b.daysLeft);
  const history = {
    ratified: actions.value.filter((a) => a.status === "ratified").length,
    rejected: actions.value.filter((a) => a.status === "rejected").length,
    expired: actions.value.filter((a) => a.status === "expired").length,
  };

  return ok({
    staleness,
    wake,
    decayedQuiet,
    generativeStale,
    tensions: { open: openTensions.length, stale: staleTensions, docketTop },
    ratification: { pending: pending.length, expiringSoon, history },
    sweptExpired: swept.value.expired,
  });
}
