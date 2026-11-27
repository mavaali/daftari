//
// amendedByFor — the documents that declare they amend this one (#643), for
// inline foregrounding on search hits and vault_read.
//
// The counterpart to resolveCurrentSource for a claim that stays true as
// written: an amender adds to the earlier document without replacing it, so
// there is no terminal head to resolve to. Reports direct amenders only, one
// hop, each with its status so a reader can see a stale amender without a
// walk. daftari authors the RELATION, never the VALUE: the snippet is read
// verbatim from the amender's indexed content.
//
// RBAC is plain omission, deliberately NOT currentSource's `restricted`
// marker. That marker adds nothing to a superseded document's own bytes,
// which already name the successor. An amended document carries no mark, so
// any signal about a hidden amender would be derived purely from a document
// the caller cannot read: linked existence, in a cell of one (#217).

import { type AccessContext, canRead } from "../access/rbac.js";
import { amendersOf, getDocument, type IndexDb } from "../storage/index-db.js";
import { previewSnippet } from "./current-source.js";

export const AMENDED_BY_CAP = 3;

export interface AmendedByEntry {
  path: string;
  title: string;
  status: string;
  snippet: string;
}

export interface AmendedBy {
  amendedBy: AmendedByEntry[]; // capped at AMENDED_BY_CAP
  amendedByCount: number; // TOTAL visible amenders (may exceed the cap)
}

// Pure over the index; never throws. Null when no visible document amends
// this one. `access` undefined ⇒ RBAC unconfigured ⇒ readable.
export function amendedByFor(db: IndexDb, path: string, access?: AccessContext): AmendedBy | null {
  const visible = amendersOf(db, path).filter(
    (doc) => !access || canRead(access.role, doc.collection),
  );
  if (visible.length === 0) return null;
  return {
    amendedBy: visible.slice(0, AMENDED_BY_CAP).map((doc) => ({
      path: doc.path,
      title: doc.title,
      status: doc.status,
      snippet: previewSnippet(getDocument(db, doc.path)?.content ?? ""),
    })),
    amendedByCount: visible.length,
  };
}

// Output schemas, here rather than in tools/ so vault_search and vault_read can
// share them without importing each other at module load.
// The array is absent, never empty,
// when no visible document amends the hit; an unreadable amender is omitted.
export const amendedBySchema = {
  type: "array",
  description:
    "Documents that declare they amend or fulfil this one via `amends`, capped " +
    "at 3. This document stays true as written, but read these for its current " +
    "state. One hop: an amender's own status is shown, its chain is not followed.",
  items: {
    type: "object",
    properties: {
      path: { type: "string", description: "Vault-relative path of the amending document." },
      title: { type: "string" },
      status: { type: "string", description: "The amending document's lifecycle status." },
      snippet: { type: "string", description: "Leading preview of the amender's body." },
    },
    required: ["path", "title", "status", "snippet"],
    additionalProperties: false,
  },
};

export const amendedByCountSchema = {
  type: "integer",
  description: "True total of visible amenders; may exceed the capped `amendedBy` list.",
};
