// clause-edge — walk an ordered chain (master + amendments) and resolve, per
// clause, the governing document (which doc holds the current value) and its
// supersession history. A clause touched by any UNRECOVERABLE op is flagged
// clean:false — its current value can't be trusted as a ground-truth label.

import { parseCitations } from "./citation-parse.js";

export interface ChainDoc {
  id: string;
  order: number;
  text: string;
}

export interface ClauseResolution {
  clause: string;
  governingDoc: string;
  status: "live" | "deleted";
  clean: boolean;
  history: string[];
}

export function resolveChain(docs: ChainDoc[]): ClauseResolution[] {
  const ordered = [...docs].sort((a, b) => a.order - b.order);
  const masterId = ordered[0].id;
  const map = new Map<string, ClauseResolution>();
  for (const doc of ordered.slice(1)) {
    for (const cite of parseCitations(doc.text)) {
      let res = map.get(cite.clause);
      if (!res) {
        // A restate/delete/partial presupposes the clause already existed (origin
        // = master); an `add` introduces it, so its origin is the adding doc.
        res = {
          clause: cite.clause,
          governingDoc: cite.op === "add" ? doc.id : masterId,
          status: "live",
          clean: true,
          history: cite.op === "add" ? [] : [masterId],
        };
        map.set(cite.clause, res);
      }
      if (res.history[res.history.length - 1] !== doc.id) res.history.push(doc.id);
      if (!cite.recoverable) res.clean = false;
      if (cite.op === "delete") res.status = "deleted";
      // Only a recoverable whole-clause op moves the governing pointer; a partial
      // or indirect edit leaves it at the last known clean value.
      if (cite.recoverable && cite.op !== "delete") res.governingDoc = doc.id;
    }
  }
  return [...map.values()];
}
