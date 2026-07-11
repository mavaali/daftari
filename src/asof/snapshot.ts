// Belief archaeology core — what the vault believed at a past commit, and
// how belief has drifted since.
//
// Everything here resolves by discovery: the "then" state is read from the
// git tree (the same markdown, parsed by the same parser as the live tools),
// the "now" state from the working tree, and every reported difference is a
// literal comparison between the two. Nothing is synthesized.

import { parseTensionLog, type TensionEntry } from "../curation/tension.js";
import {
  type BlastDependencyType,
  buildReverseLinkMap,
  buildReverseSourceMap,
  computeBlast,
} from "../curation/tension-blast.js";
import { type LoadedDoc, loadDocuments } from "../curation/vault-docs.js";
import { parseDocument } from "../frontmatter/parser.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import {
  type AsofCommit,
  listTreeDocs,
  logRangeForPath,
  type RangeCommit,
  readBlobsAt,
} from "./git-read.js";

const TENSIONS_LOG = ".daftari/tensions.md";

// Loads every managed document from the tree at `commit`, parsed with the
// same parser and the same skip-malformed tolerance as the live loader.
export async function loadDocumentsAt(
  vaultRoot: string,
  commit: string,
): Promise<Result<LoadedDoc[], Error>> {
  const paths = await listTreeDocs(vaultRoot, commit);
  if (!paths.ok) return paths;
  const blobs = await readBlobsAt(vaultRoot, commit, paths.value);
  if (!blobs.ok) return blobs;

  const docs: LoadedDoc[] = [];
  for (const path of paths.value) {
    const raw = blobs.value.get(path);
    if (raw === undefined) continue;
    const parsed = parseDocument(raw);
    if (!parsed.ok) continue;
    docs.push({
      path,
      frontmatter: parsed.value.frontmatter,
      content: parsed.value.content,
      validation: parsed.value.validation,
    });
  }
  return ok(docs);
}

export interface BeliefTransition {
  path: string;
  field: "status" | "confidence";
  from: string;
  to: string;
}

export interface AsofSnapshot {
  commit: AsofCommit;
  docCount: number;
  byStatus: Record<string, number>;
  byCollection: Record<string, number>;
  drift: {
    added: string[]; // present now, absent then
    removed: string[]; // present then, absent now
    transitions: BeliefTransition[];
    bodiesChanged: number; // same path, body text differs
  };
  tensions: {
    openThen: number;
    openNow: number;
    openedSince: { title: string; date: string; kind: string }[];
    resolvedSince: { title: string; date: string; kind: string; resolutionKind: string }[];
  };
}

function countBy(docs: LoadedDoc[], key: (d: LoadedDoc) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of docs) {
    const k = key(d);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function collectionOf(d: LoadedDoc): string {
  return d.frontmatter.collection || (d.path.split("/")[0] ?? "");
}

function tensionIdentity(t: TensionEntry): string {
  return t.id ?? `${t.date}:${t.title}`;
}

export function computeTransitions(then: LoadedDoc[], now: LoadedDoc[]): BeliefTransition[] {
  const nowByPath = new Map(now.map((d) => [d.path, d]));
  const transitions: BeliefTransition[] = [];
  for (const t of then) {
    const n = nowByPath.get(t.path);
    if (!n) continue;
    if (t.frontmatter.status !== n.frontmatter.status) {
      transitions.push({
        path: t.path,
        field: "status",
        from: t.frontmatter.status,
        to: n.frontmatter.status,
      });
    }
    if (t.frontmatter.confidence !== n.frontmatter.confidence) {
      transitions.push({
        path: t.path,
        field: "confidence",
        from: t.frontmatter.confidence,
        to: n.frontmatter.confidence,
      });
    }
  }
  transitions.sort((a, b) =>
    a.path === b.path ? (a.field < b.field ? -1 : 1) : a.path < b.path ? -1 : 1,
  );
  return transitions;
}

// The tension log at a past commit, parsed with the live parser. A vault
// with no committed log at that point reads as zero tensions.
async function tensionsAt(vaultRoot: string, commit: string): Promise<TensionEntry[]> {
  const blob = await readBlobsAt(vaultRoot, commit, [TENSIONS_LOG]);
  if (!blob.ok) return [];
  const raw = blob.value.get(TENSIONS_LOG);
  return raw === undefined ? [] : parseTensionLog(raw);
}

export async function beliefSnapshot(
  vaultRoot: string,
  commit: AsofCommit,
  tensionsNow: TensionEntry[],
): Promise<Result<AsofSnapshot, Error>> {
  const thenDocs = await loadDocumentsAt(vaultRoot, commit.hash);
  if (!thenDocs.ok) return thenDocs;
  const nowDocs = await loadDocuments(vaultRoot);
  if (!nowDocs.ok) return nowDocs;

  const thenPaths = new Set(thenDocs.value.map((d) => d.path));
  const nowPaths = new Set(nowDocs.value.map((d) => d.path));
  const added = [...nowPaths].filter((p) => !thenPaths.has(p)).sort();
  const removed = [...thenPaths].filter((p) => !nowPaths.has(p)).sort();

  const nowByPath = new Map(nowDocs.value.map((d) => [d.path, d]));
  let bodiesChanged = 0;
  for (const t of thenDocs.value) {
    const n = nowByPath.get(t.path);
    if (n && n.content !== t.content) bodiesChanged += 1;
  }

  const thenTensions = await tensionsAt(vaultRoot, commit.hash);
  const thenIds = new Set(thenTensions.map(tensionIdentity));
  const thenUnresolvedIds = new Set(thenTensions.filter((t) => !t.resolved).map(tensionIdentity));
  const openedSince = tensionsNow
    .filter((t) => !thenIds.has(tensionIdentity(t)))
    .map((t) => ({ title: t.title, date: t.date, kind: t.kind }));
  const resolvedSince = tensionsNow
    .filter((t) => t.resolved && thenUnresolvedIds.has(tensionIdentity(t)))
    .map((t) => ({
      title: t.title,
      date: t.date,
      kind: t.kind,
      resolutionKind: t.resolution?.kind ?? "",
    }));

  return ok({
    commit,
    docCount: thenDocs.value.length,
    byStatus: countBy(thenDocs.value, (d) => d.frontmatter.status),
    byCollection: countBy(thenDocs.value, collectionOf),
    drift: {
      added,
      removed,
      transitions: computeTransitions(thenDocs.value, nowDocs.value),
      bodiesChanged,
    },
    tensions: {
      openThen: thenTensions.filter((t) => !t.resolved).length,
      openNow: tensionsNow.filter((t) => !t.resolved).length,
      openedSince,
      resolvedSince,
    },
  });
}

// ---------------------------------------------------------------------------
// Counterfactual replay — blast radius over the historical tree
// ---------------------------------------------------------------------------

export interface ReplayEntry {
  path: string;
  dependency_type: BlastDependencyType;
  distance: number;
  // Where that downstream document stands today: its current status, or
  // "gone" if it no longer exists in the working tree.
  statusNow: string;
}

export interface AsofReplay {
  document: string;
  downstreamThen: ReplayEntry[];
  primaryBlast: number;
  advisoryBlast: number;
  maxDepth: number;
  stillCanonicalNow: number;
  goneNow: number;
}

// "This fact turned out wrong — who had inherited it at the time, and where
// are they now?" Blast is computed over the tree AS OF the commit (the same
// source/link edge semantics as vault_tension_blast), then each downstream
// doc is annotated with its present-day status.
export async function counterfactualReplay(
  vaultRoot: string,
  commit: AsofCommit,
  document: string,
): Promise<Result<AsofReplay, Error>> {
  const thenDocs = await loadDocumentsAt(vaultRoot, commit.hash);
  if (!thenDocs.ok) return thenDocs;
  if (!thenDocs.value.some((d) => d.path === document)) {
    return err(
      new Error(`document not found in the vault at ${commit.hash.slice(0, 8)}: ${document}`),
    );
  }
  const nowDocs = await loadDocuments(vaultRoot);
  if (!nowDocs.ok) return nowDocs;
  const statusNowByPath = new Map(nowDocs.value.map((d) => [d.path, d.frontmatter.status]));

  const blast = computeBlast({
    seeds: [document],
    reverseSource: buildReverseSourceMap(thenDocs.value),
    reverseLink: buildReverseLinkMap(thenDocs.value),
  });

  const downstreamThen: ReplayEntry[] = blast.downstream.map((e) => ({
    ...e,
    statusNow: statusNowByPath.get(e.path) ?? "gone",
  }));

  return ok({
    document,
    downstreamThen,
    primaryBlast: blast.primary_blast,
    advisoryBlast: blast.advisory_blast,
    maxDepth: blast.max_depth,
    stillCanonicalNow: downstreamThen.filter((e) => e.statusNow === "canonical").length,
    goneNow: downstreamThen.filter((e) => e.statusNow === "gone").length,
  });
}

// ---------------------------------------------------------------------------
// Single-document trajectory
// ---------------------------------------------------------------------------

export interface DocState {
  title: string;
  status: string;
  confidence: string;
  updated: string;
  provenance: string;
}

// `asOf` / `current` rather than then/now: a `then` property would make the
// object thenable, which `await` treats as a promise.
export interface DocTrajectory {
  path: string;
  asOf: DocState | null; // null — did not exist at the as-of commit
  current: DocState | null; // null — no longer exists in the working tree
  commitsBetween: RangeCommit[]; // touching this path, newest first
}

function docState(d: LoadedDoc): DocState {
  return {
    title: d.frontmatter.title,
    status: d.frontmatter.status,
    confidence: d.frontmatter.confidence,
    updated: d.frontmatter.updated,
    provenance: d.frontmatter.provenance,
  };
}

export async function docTrajectory(
  vaultRoot: string,
  commit: AsofCommit,
  path: string,
): Promise<Result<DocTrajectory, Error>> {
  const thenDocs = await loadDocumentsAt(vaultRoot, commit.hash);
  if (!thenDocs.ok) return thenDocs;
  const nowDocs = await loadDocuments(vaultRoot);
  if (!nowDocs.ok) return nowDocs;

  const thenDoc = thenDocs.value.find((d) => d.path === path) ?? null;
  const nowDoc = nowDocs.value.find((d) => d.path === path) ?? null;
  if (!thenDoc && !nowDoc) {
    return err(new Error(`document not found then or now: ${path}`));
  }

  const commits = await logRangeForPath(vaultRoot, commit.hash, path);
  if (!commits.ok) return commits;

  return ok({
    path,
    asOf: thenDoc ? docState(thenDoc) : null,
    current: nowDoc ? docState(nowDoc) : null,
    commitsBetween: commits.value,
  });
}
