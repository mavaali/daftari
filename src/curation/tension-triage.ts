// Tension Triage Card (Story 1) — the pure engine.
//
// Composes the vault's LIVE tensions into a human-legible card: each tension
// grouped by cluster, annotated with its blast, and — per contested side —
// tier, confidence, and read-heat. The point is legibility, not automation:
// this function computes NO composite severity score. Ranking the queue is the
// human's job in v0; a learned priority function is a later, separate concern.
//
// Purity: all vault-derived inputs (doc metadata, read-heat, per-tension blast)
// are passed in already resolved, so the composition is testable with synthetic
// data and never touches the filesystem or the RBAC layer. The async loader in
// the tool wires the real vault reads.

import type { Confidence, Criticality, Provenance, Tier } from "../frontmatter/types.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { computeReadHeat, type ReadHeat, type ReadHeatDoc } from "./read-heat.js";
import { readReadLog } from "./read-log.js";
import { ageInDays } from "./staleness.js";
import { listTensions, type TensionEntry, type TensionKind } from "./tension.js";
import {
  bucketHiddenDownstream,
  buildReverseLinkMap,
  buildReverseSourceMap,
  computeBlast,
  type HiddenDownstream,
} from "./tension-blast.js";
import { computeTensionClusters } from "./tension-clusters.js";
import { loadDocuments } from "./vault-docs.js";

const READ_HEAT_WINDOW_DAYS = 30;

export interface TriageDocMeta {
  tier: Tier | null;
  confidence: Confidence;
  criticality: Criticality | null;
  provenance: Provenance | null;
  updated_by: string | null;
  // Earliest-known date; forwarded to read-heat's instrumented check upstream.
  created?: string;
}

export interface TriageBlast {
  primary_blast: number;
  advisory_blast: number;
  hidden_downstream: HiddenDownstream;
}

// One contested side of a tension. Fields are null when the doc is unknown
// (missing/deleted): absent metadata is reported as unknown, never as a
// misleading zero or default tier.
export interface TriageSide {
  path: string;
  claim: string;
  tier: Tier | null;
  confidence: Confidence | null;
  read_heat: ReadHeat | null;
  criticality: Criticality | null;
  provenance: Provenance | null;
  updated_by: string | null;
}

// A single tension, enriched. Blast fields are null when unavailable (no blast
// was supplied for this tension) — distinct from a real zero blast. There is
// deliberately no score/severity/rank field.
export interface TriageTension {
  id: string;
  title: string;
  kind: TensionKind;
  age_days: number;
  a: TriageSide;
  b: TriageSide;
  primary_blast: number | null;
  advisory_blast: number | null;
  hidden_downstream: HiddenDownstream | null;
}

export interface TriageCluster {
  cluster_id: string;
  documents: string[];
  tensions: TriageTension[];
}

export interface TensionTriageResult {
  cluster_count: number;
  tension_count: number;
  clusters: TriageCluster[];
}

export interface TriageInputs {
  docMeta: Map<string, TriageDocMeta>;
  readHeat: Map<string, ReadHeat>;
  blastByTension: Map<string, TriageBlast>;
}

function sideFor(path: string, claim: string, inputs: TriageInputs): TriageSide {
  const m = inputs.docMeta.get(path);
  return {
    path,
    claim,
    tier: m ? m.tier : null,
    confidence: m ? m.confidence : null,
    read_heat: inputs.readHeat.get(path) ?? null,
    criticality: m ? m.criticality : null,
    provenance: m ? m.provenance : null,
    updated_by: m ? m.updated_by : null,
  };
}

function enrich(tension: TensionEntry, inputs: TriageInputs, now: Date): TriageTension {
  const b = tension.id ? inputs.blastByTension.get(tension.id) : undefined;
  return {
    id: tension.id ?? "",
    title: tension.title,
    kind: tension.kind,
    age_days: ageInDays(tension.date, now),
    a: sideFor(tension.sourceA, tension.claimA, inputs),
    b: sideFor(tension.sourceB, tension.claimB, inputs),
    primary_blast: b ? b.primary_blast : null,
    advisory_blast: b ? b.advisory_blast : null,
    hidden_downstream: b ? b.hidden_downstream : null,
  };
}

// Live-contested scope, mirroring tension-clusters' inScope: unresolved,
// non-accepted, real two-endpoint edge. Kept local so the module has no
// cross-dependency on a private helper.
function inScope(t: TensionEntry): boolean {
  if (t.resolved) return false;
  if (t.resolution?.kind === "accepted") return false;
  if (!t.sourceA || !t.sourceB) return false;
  if (t.sourceA === t.sourceB) return false;
  return true;
}

export function computeTensionTriage(
  tensions: TensionEntry[],
  inputs: TriageInputs,
  now: Date = new Date(),
): TensionTriageResult {
  const scoped = tensions.filter(inScope);
  // Reuse the cluster computation for grouping + deterministic size-desc order.
  const { clusters } = computeTensionClusters(scoped, now);

  // doc path → cluster id, so each tension routes to its cluster bucket.
  const clusterOfDoc = new Map<string, string>();
  for (const c of clusters) {
    for (const doc of c.documents) clusterOfDoc.set(doc, c.id);
  }

  const tensionsByCluster = new Map<string, TensionEntry[]>();
  for (const t of scoped) {
    const cid = clusterOfDoc.get(t.sourceA);
    if (cid === undefined) continue;
    if (!tensionsByCluster.has(cid)) tensionsByCluster.set(cid, []);
    (tensionsByCluster.get(cid) as TensionEntry[]).push(t);
  }

  const triageClusters: TriageCluster[] = clusters.map((c) => {
    const raw = tensionsByCluster.get(c.id) ?? [];
    const enriched = raw
      .map((t) => enrich(t, inputs, now))
      // Oldest first; tie-break on id ascending for a stable order.
      .sort((x, y) => (y.age_days !== x.age_days ? y.age_days - x.age_days : x.id < y.id ? -1 : 1));
    return { cluster_id: c.id, documents: c.documents, tensions: enriched };
  });

  return {
    cluster_count: triageClusters.length,
    tension_count: scoped.length,
    clusters: triageClusters,
  };
}

// Async loader: reads the vault's tensions, documents, read log, and computes
// per-tension blast, then feeds them all into computeTensionTriage. Mirrors
// loadTensionClusters' Result + entryFilter signature — the visibility policy
// (#212) is injected by the tool layer so this module never imports RBAC.
//
// Blast is seeded on BOTH endpoints of each tension (the contested pair): the
// downstream of the pair is what a resolver's change would touch. The reverse
// maps are built once and reused across every tension. hidden_downstream is
// "none" here — the RBAC recompute (#217) lives in the tool handler, not the
// loader (v0 default: apply the entryFilter, don't replicate per-tension
// kept/hidden downstream counting).
export async function loadTensionTriage(
  vaultRoot: string,
  now: Date = new Date(),
  entryFilter: (entries: TensionEntry[]) => TensionEntry[] = (e) => e,
  windowDays: number = READ_HEAT_WINDOW_DAYS,
): Promise<Result<TensionTriageResult, Error>> {
  const tensionsResult = await listTensions(vaultRoot);
  if (!tensionsResult.ok) return err(tensionsResult.error);
  const tensions = entryFilter(tensionsResult.value);

  const docsResult = await loadDocuments(vaultRoot);
  if (!docsResult.ok) return err(docsResult.error);
  const docs = docsResult.value;

  const docMeta = new Map<string, TriageDocMeta>();
  const readHeatDocs: ReadHeatDoc[] = [];
  for (const d of docs) {
    docMeta.set(d.path, {
      tier: d.frontmatter.tier,
      confidence: d.frontmatter.confidence,
      criticality: d.frontmatter.criticality,
      provenance: d.frontmatter.provenance,
      updated_by: d.frontmatter.updated_by,
      created: d.frontmatter.created,
    });
    readHeatDocs.push({ file: d.path, created: d.frontmatter.created });
  }

  const readLogResult = await readReadLog(vaultRoot);
  if (!readLogResult.ok) return err(readLogResult.error);
  const readHeat = computeReadHeat(readLogResult.value, readHeatDocs, {
    now,
    windowDays,
  });

  const reverseSource = buildReverseSourceMap(docs);
  const reverseLink = buildReverseLinkMap(docs);
  const blastByTension = new Map<string, TriageBlast>();
  for (const t of tensions.filter(inScope)) {
    if (!t.id) continue;
    const { primary_blast, advisory_blast } = computeBlast({
      seeds: [t.sourceA, t.sourceB],
      reverseSource,
      reverseLink,
    });
    blastByTension.set(t.id, {
      primary_blast,
      advisory_blast,
      hidden_downstream: bucketHiddenDownstream(0),
    });
  }

  return ok(computeTensionTriage(tensions, { docMeta, readHeat, blastByTension }, now));
}
