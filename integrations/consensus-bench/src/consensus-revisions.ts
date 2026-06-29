// consensus-revisions — the messy-stream data layer for corpus (B). A
// RevisionRecord is one Wikipedia article revision (the fields we need from the
// API's prop=revisions). RevisionSource is the seam that lets tests inject
// hand-authored fixtures while the one-shot pull script supplies real data.
import { readFileSync } from "node:fs";

export interface RevisionRecord {
  revid: number;
  parentid: number;
  timestamp: string; // ISO 8601, as returned by the API
  user: string;
  comment: string; // the edit summary — the labeling signal
}

export interface RevisionSource {
  revisions(): RevisionRecord[];
}

export function loadRevisionsFromFile(path: string): RevisionRecord[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => ({
    revid: Number(r.revid),
    parentid: Number(r.parentid ?? 0),
    timestamp: String(r.timestamp ?? ""),
    user: String(r.user ?? ""),
    comment: String(r.comment ?? ""),
  }));
}
