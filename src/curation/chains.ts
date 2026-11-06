// computeChains — the end of every `superseded_by` chain in the vault (#642).
//
// `superseded_by` is functional forward and a relation in reverse (vault_merge
// fans in), so a chain is an in-tree rooted at one head, or a component
// wrapped around one loop. Walking uses exact paths, the same semantics as
// resolveCurrentSource, so a chain's end matches what search forwards a reader
// to. Pure; advisory like the rest of curation — it flags, it never repairs.
//
// Visibility (2026-07-14 edge-graph spec): an unreadable document is omitted,
// and the chain is never stitched across it. Readable documents behind an
// unreadable hop get their own headless `restricted` chain, which withholds
// the hop's status and every flag derived from it. Those documents' own
// `superseded_by` already discloses the link, and search's `currentSource`
// already separates restricted from dangling, so neither is a new oracle.
// Hidden predecessors are reported coarsened (B′), never counted.

import type { SupersessionNode } from "../storage/index-db.js";
import { bucketHiddenDownstream, type HiddenDownstream } from "./tension-blast.js";

export type ChainDoc = SupersessionNode;

export const CHAIN_FLAGS = [
  "draft", // the current entry is not certified yet
  "retired", // the current entry is deprecated or archived: forwards to nothing live
  "unforwarded", // status says superseded, but no pointer says by what
  "dangling", // the head's superseded_by names a document that does not exist
  "loop", // no current entry exists: the chain never terminates
  "restricted", // the chain continues into a document the caller cannot read
] as const;
export type ChainFlag = (typeof CHAIN_FLAGS)[number];

export interface ChainMember {
  path: string;
  status: string;
  updated: string;
}

// `depth` is hops to the head. In a loop, members on the loop are 0 and a tail
// counts hops to reach it.
export interface ChainReplaced extends ChainMember {
  depth: number;
}

export interface Chain {
  // null when there is no current entry the caller may see: `loop` or
  // `restricted` in `flags` says which.
  head: ChainMember | null;
  replaced: ChainReplaced[];
  hidden_replaced: HiddenDownstream;
  flags: ChainFlag[];
}

interface ChainDraft {
  head: ChainMember | null;
  replaced: ChainReplaced[];
  hidden: number;
  flags: ChainFlag[];
}

// Where a readable document's walk stops, staying on readable documents.
type WalkEnd =
  | { kind: "head"; doc: ChainDoc; depth: number; dangling: boolean }
  | { kind: "restricted"; hop: ChainDoc; depth: number }
  | { kind: "loop"; cycle: ChainDoc[]; depth: number };

function walkForward(
  start: ChainDoc,
  byPath: Map<string, ChainDoc>,
  readable: (doc: ChainDoc) => boolean,
): WalkEnd {
  const trail: ChainDoc[] = [start];
  const positions = new Map<string, number>([[start.path, 0]]);
  let current = start;

  while (current.supersededBy !== null) {
    const depth = trail.length;
    const next = byPath.get(current.supersededBy);
    if (!next) return { kind: "head", doc: current, depth: depth - 1, dangling: true };
    if (!readable(next)) return { kind: "restricted", hop: next, depth };
    const seenAt = positions.get(next.path);
    if (seenAt !== undefined) {
      return { kind: "loop", cycle: trail.slice(seenAt), depth: seenAt };
    }
    positions.set(next.path, depth);
    trail.push(next);
    current = next;
  }
  return { kind: "head", doc: current, depth: trail.length - 1, dangling: false };
}

function statusFlags(doc: ChainDoc, dangling: boolean): ChainFlag[] {
  const flags: ChainFlag[] = [];
  if (doc.status === "draft") flags.push("draft");
  if (doc.status === "deprecated" || doc.status === "archived") flags.push("retired");
  if (doc.status === "superseded" && !dangling) flags.push("unforwarded");
  if (dangling) flags.push("dangling");
  return flags;
}

function toMember(doc: ChainDoc): ChainMember {
  return { path: doc.path, status: doc.status, updated: doc.updated };
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function smallestPath(replaced: ChainReplaced[]): string {
  return replaced.map((r) => r.path).sort(comparePaths)[0] ?? "";
}

// Headed chains first by head path; headless ones after, by a path the caller
// can read — sorting on the hidden hop would leak its position.
function compareChains(a: Chain, b: Chain): number {
  if (a.head && b.head) return comparePaths(a.head.path, b.head.path);
  if (a.head) return -1;
  if (b.head) return 1;
  return comparePaths(smallestPath(a.replaced), smallestPath(b.replaced));
}

export function computeChains(docs: ChainDoc[], readable: (doc: ChainDoc) => boolean): Chain[] {
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const replacedSomething = new Set<string>();
  for (const doc of docs) {
    if (doc.supersededBy !== null && byPath.has(doc.supersededBy)) {
      replacedSomething.add(doc.supersededBy);
    }
  }

  // Keyed by path so a hidden document's walk can credit the chain it feeds;
  // every member of a loop maps to the same draft.
  const drafts = new Map<string, ChainDraft>();
  const draftAt = (path: string, head: ChainMember | null, flags: ChainFlag[]): ChainDraft => {
    const existing = drafts.get(path);
    if (existing) return existing;
    const draft: ChainDraft = { head, replaced: [], hidden: 0, flags };
    drafts.set(path, draft);
    return draft;
  };

  for (const doc of docs) {
    if (!readable(doc)) continue;
    const end = walkForward(doc, byPath, readable);

    let draft: ChainDraft;
    if (end.kind === "head") {
      // Draft or retired alone is no chain: nothing was replaced. A superseded
      // status with no pointer is one, even with nothing behind it.
      const isChain =
        end.depth > 0 ||
        replacedSomething.has(end.doc.path) ||
        end.dangling ||
        end.doc.status === "superseded";
      if (!isChain) continue;
      draft = draftAt(end.doc.path, toMember(end.doc), statusFlags(end.doc, end.dangling));
    } else if (end.kind === "restricted") {
      draft = draftAt(end.hop.path, null, ["restricted"]);
    } else {
      draft = draftAt(end.cycle[0]?.path ?? doc.path, null, ["loop"]);
      for (const member of end.cycle) drafts.set(member.path, draft);
    }

    if (end.kind !== "head" || end.depth > 0) {
      draft.replaced.push({ ...toMember(doc), depth: end.depth });
    }
  }

  for (const doc of docs) {
    if (readable(doc)) continue;
    // A Set, not a counter: a walk around a loop passes one draft many times.
    const fed = new Set<ChainDraft>();
    const seen = new Set<string>([doc.path]);
    let next = doc.supersededBy === null ? undefined : byPath.get(doc.supersededBy);
    while (next && !seen.has(next.path)) {
      seen.add(next.path);
      const draft = drafts.get(next.path);
      if (draft) fed.add(draft);
      next = next.supersededBy === null ? undefined : byPath.get(next.supersededBy);
    }
    for (const draft of fed) draft.hidden += 1;
  }

  return [...new Set(drafts.values())]
    .map(
      (draft): Chain => ({
        head: draft.head,
        replaced: draft.replaced.sort((a, b) => a.depth - b.depth || comparePaths(a.path, b.path)),
        hidden_replaced: bucketHiddenDownstream(draft.hidden),
        flags: draft.flags,
      }),
    )
    .sort(compareChains);
}
