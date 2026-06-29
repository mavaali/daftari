// consensus-content — the diff layer for CO2. A RevertDiff pairs a CO1 revert
// instance with the Wikipedia compare HTML (compare["*"]) between the bad edit
// (parentid) and the revert (revid). DiffSource is the seam that lets tests
// inject fixtures while the one-shot pull script supplies real diffs.
import { readFileSync } from "node:fs";

export interface RevertDiff {
  revid: number;
  parentid: number;
  citedNum: number;
  governingNum: number;
  diffHtml: string;
}

export interface DiffSource {
  diffs(): RevertDiff[];
}

export function loadDiffsFromFile(path: string): RevertDiff[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) return [];
  return raw.map((d) => ({
    revid: Number(d.revid),
    parentid: Number(d.parentid),
    citedNum: Number(d.citedNum),
    governingNum: Number(d.governingNum),
    diffHtml: String(d.diffHtml ?? ""),
  }));
}
