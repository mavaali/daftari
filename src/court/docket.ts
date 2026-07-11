// The Tension Court docket — a compiled brief for every open tension.
//
// Tensions wait in a log; the docket turns them into decidable cases. Each
// brief carries what a human needs to rule without spelunking: both sides'
// claims and the present state of their documents, how long the dispute has
// been open, the blast radius a ruling would settle, cluster membership, and
// the precedents — past rulings on similar disputes.
//
// Everything is compiled from data the vault already holds (the tension log,
// frontmatter, the same reverse-source/link maps as vault_tension_blast).
// The court never decides: the docket ranks and briefs; the ruling is a
// human act recorded through the existing resolveTension write path.

import { computeDecay, type DecayLevel } from "../curation/decay.js";
import { ageInDays } from "../curation/staleness.js";
import { type AgingTier, agingTier, listTensions, type TensionEntry } from "../curation/tension.js";
import {
  buildReverseLinkMap,
  buildReverseSourceMap,
  computeBlast,
} from "../curation/tension-blast.js";
import { loadTensionClusters, type TensionCluster } from "../curation/tension-clusters.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { ok, type Result } from "../frontmatter/types.js";
import { findPrecedents, type Precedent } from "./precedent.js";

export interface DocketSide {
  path: string;
  claim: string;
  // Present-day state of the document: its status, or "gone" if it no longer
  // exists in the vault.
  status: string;
  decayLevel: DecayLevel | null;
}

export interface DocketBlast {
  primary: number;
  advisory: number;
  total: number;
  maxDepth: number;
}

export interface DocketEntry {
  // Null for legacy tensions logged before ids existed — those cannot be
  // ruled through `court rule` (resolveTension needs an id) and the report
  // says so.
  id: string | null;
  title: string;
  kind: string;
  date: string;
  ageDays: number;
  agingTier: AgingTier | null;
  sideA: DocketSide;
  sideB: DocketSide;
  // Union blast over both sides' documents (those that still exist): the
  // downstream set a ruling would settle.
  blast: DocketBlast;
  clusterId: string | null;
  clusterSize: number;
  precedents: Precedent[];
}

export interface Docket {
  openCount: number;
  rulingCount: number;
  entries: DocketEntry[];
}

// Docket priority: the longest-ignored disputes with the widest reach come
// up first. Stale > aging > fresh > unclassified; then blast size
// descending; then oldest first; then title for a total order.
const TIER_PRIORITY: Record<string, number> = { stale: 0, aging: 1, fresh: 2 };

function priorityCompare(a: DocketEntry, b: DocketEntry): number {
  const ta = a.agingTier === null ? 3 : TIER_PRIORITY[a.agingTier];
  const tb = b.agingTier === null ? 3 : TIER_PRIORITY[b.agingTier];
  if (ta !== tb) return (ta as number) - (tb as number);
  if (a.blast.total !== b.blast.total) return b.blast.total - a.blast.total;
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.title.localeCompare(b.title);
}

export async function buildDocket(
  vaultRoot: string,
  now: Date = new Date(),
): Promise<Result<Docket, Error>> {
  const tensions = await listTensions(vaultRoot);
  if (!tensions.ok) return tensions;
  const open = tensions.value.filter((t) => !t.resolved);
  const rulings = tensions.value.filter((t) => t.resolved && t.resolution);

  const docs = await loadDocuments(vaultRoot);
  if (!docs.ok) return docs;
  const docByPath = new Map(docs.value.map((d) => [d.path, d]));

  const clusters = await loadTensionClusters(vaultRoot, now);
  if (!clusters.ok) return clusters;
  const clusterOf = new Map<string, TensionCluster>();
  for (const c of clusters.value.clusters) {
    for (const doc of c.documents) clusterOf.set(doc, c);
  }

  const reverseSource = buildReverseSourceMap(docs.value);
  const reverseLink = buildReverseLinkMap(docs.value);

  const side = (path: string, claim: string): DocketSide => {
    const doc = docByPath.get(path);
    if (!doc) return { path, claim, status: "gone", decayLevel: null };
    return {
      path,
      claim,
      status: doc.frontmatter.status,
      decayLevel: computeDecay(doc.frontmatter, now)?.level ?? null,
    };
  };

  const entries: DocketEntry[] = open.map((t) => {
    const seeds = [t.sourceA, t.sourceB].filter((p) => p.length > 0 && docByPath.has(p));
    const blast =
      seeds.length > 0
        ? computeBlast({ seeds, reverseSource, reverseLink })
        : { downstream: [], primary_blast: 0, advisory_blast: 0, max_depth: 0 };

    const cluster = clusterOf.get(t.sourceA) ?? clusterOf.get(t.sourceB) ?? null;

    return {
      id: t.id ?? null,
      title: t.title,
      kind: t.kind,
      date: t.date,
      ageDays: ageInDays(t.date, now),
      agingTier: agingTier(t, now),
      sideA: side(t.sourceA, t.claimA),
      sideB: side(t.sourceB, t.claimB),
      blast: {
        primary: blast.primary_blast,
        advisory: blast.advisory_blast,
        total: blast.downstream.length,
        maxDepth: blast.max_depth,
      },
      clusterId: cluster?.id ?? null,
      clusterSize: cluster?.size ?? 0,
      precedents: findPrecedents(t, rulings),
    };
  });

  entries.sort(priorityCompare);

  return ok({ openCount: open.length, rulingCount: rulings.length, entries });
}

// A single case's full brief, looked up by tension id.
export async function buildBrief(
  vaultRoot: string,
  id: string,
  now: Date = new Date(),
): Promise<Result<DocketEntry | null, Error>> {
  const docket = await buildDocket(vaultRoot, now);
  if (!docket.ok) return docket;
  return ok(docket.value.entries.find((e) => e.id === id) ?? null);
}

export type { TensionEntry };
