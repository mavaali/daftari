// qa-build — turn a resolved chain into current-value QAs in the benchmark
// buckets. The answer to "current value of clause X" is read from the clause's
// GOVERNING document, which for a scoped-current clause is an earlier doc than
// the latest — exactly where a recency baseline goes wrong.

import type { ChainDoc, ClauseResolution } from "./clause-edge.js";

export type Bucket = "scoped-current" | "latest-current" | "unamended" | "no-value";

export interface ContractQA {
  id: string;
  clause: string;
  question: string;
  answer: string;
  governingDoc: string;
  bucket: Bucket;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The whole-clause value for a clause in a given doc. A defined-term clause is a
// quoted term followed by "means": its value runs to the next quoted definition
// or the end. Otherwise the value is the text introduced by "as follows:" (a
// Section restate/add), or the clause's own sentence (a master clause body).
export function extractValue(docText: string, clause: string): string {
  const term = new RegExp(
    `["“]\\s*${escapeRegex(clause)}\\s*["”]\\s+(?:means|shall mean)\\s+(.+?)\\s*(?=[.;]\\s+["“]|$)`,
    "is",
  ).exec(docText);
  if (term) return term[1].trim().replace(/[.;]+$/, "");

  const at = new RegExp(`Section\\s+${escapeRegex(clause)}\\b`, "i").exec(docText);
  const tail = at ? docText.slice(at.index) : docText;
  const quoted = /as follows:\s*["“”]([^"“”]+)["“”]/.exec(tail);
  if (quoted) return quoted[1].trim();
  const af = /as follows:\s*(.+?)\s*$/s.exec(tail);
  if (af) return af[1].trim();
  const sentence = /^[^.]*\./.exec(tail);
  return sentence ? sentence[0].trim() : tail.trim();
}

export interface BuildOptions {
  // Synthetic clause ids known to be absent from the chain — fabrication probes.
  noValueClauses?: string[];
}

export function buildQAs(
  docs: ChainDoc[],
  resolutions: ClauseResolution[],
  opts: BuildOptions = {},
): ContractQA[] {
  const ordered = [...docs].sort((a, b) => a.order - b.order);
  const latestId = ordered[ordered.length - 1].id;
  const byId = new Map(ordered.map((d) => [d.id, d]));
  const out: ContractQA[] = [];
  for (const r of resolutions) {
    if (!r.clean || r.status !== "live") continue; // tainted/deleted are not clean ground truth
    const bucket: Bucket = r.governingDoc === latestId ? "latest-current" : "scoped-current";
    const gov = byId.get(r.governingDoc);
    out.push({
      id: `${bucket}:${r.clause}`,
      clause: r.clause,
      question: `What is the current value of Section ${r.clause}?`,
      answer: gov ? extractValue(gov.text, r.clause) : "",
      governingDoc: r.governingDoc,
      bucket,
    });
  }
  for (const clause of opts.noValueClauses ?? []) {
    out.push({
      id: `no-value:${clause}`,
      clause,
      question: `What is the current value of Section ${clause}?`,
      answer: "NOT_PRESENT",
      governingDoc: "",
      bucket: "no-value",
    });
  }
  return out;
}
