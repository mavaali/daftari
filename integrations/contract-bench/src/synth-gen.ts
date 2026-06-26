// synth-gen — deterministic two-variant synthetic contract chain generator.
// Produces a master + amendments whose text the existing parseCitations /
// resolveChain pipeline handles correctly.
//
// Design notes:
// - "clean" variant: amendments only contain operative restate phrases
// - "stale" variant: the latest amendment ALSO has a RECITAL for the
//   scoped-current clause (its old value, phrased with "as follows:" but
//   without any operative phrase). parseCitations must NOT emit an op for it.
// - Value bookkeeping: masterValue[k] = OLD; governingValue[k] = NEW.
//   The stale recital repeats masterValue[k] (OLD). perturbValues applied
//   later in assemble() maps each consistently, so chain stays aligned.

import type { ChainDoc } from "./clause-edge.js";

export interface SynthChainResult {
  docs: ChainDoc[];
  noValueClauses: string[];
}

export interface SynthGenOptions {
  seed: number;
  variant: "clean" | "stale";
  nClauses?: number; // defaults to 3
  nAmendments?: number; // defaults to 2
}

// Simple deterministic hash (FNV-1a) — same one perturb.ts uses internally.
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Deterministic value picker — produces a string from a fixed value catalogue
// based on a hash key. Each index gets its own OLD and NEW value that differ.
function pickValue(type: "old" | "new", clauseIdx: number, seed: number): string {
  // Catalogue: currency, durations, percentages — all perturbable by perturb.ts
  const catalogue = [
    ["$100,000", "$200,000"],
    ["$250,000", "$500,000"],
    ["$750,000", "$1,000,000"],
    ["30 days", "60 days"],
    ["60 days", "90 days"],
    ["90 days", "120 days"],
    ["5%", "10%"],
    ["2%", "4%"],
    ["12 months", "24 months"],
  ];
  const h = hashStr(`${clauseIdx}:${seed}`);
  const entry = catalogue[h % catalogue.length];
  return type === "old" ? entry[0] : entry[1];
}

// Which amendment index (1-based) each clause is restated in.
// We ensure:
//   - At least one clause's LAST restate is NOT in the latest amendment (scoped-current).
//   - At least one clause's LAST restate IS the latest amendment (latest-current).
// Strategy: clause 0 → amendment 1 (scoped); clause 1 → amendment nAmendments (latest).
// If nClauses > 2, additional clauses get distributed across amendments.
function assignAmendment(clauseIdx: number, nClauses: number, nAmendments: number): number {
  if (clauseIdx === 0) return 1; // scoped-current: restated in first amendment
  if (clauseIdx === 1) return nAmendments; // latest-current: restated in last amendment
  // Additional clauses: distribute across intermediate amendments (1..nAmendments).
  return 1 + (clauseIdx % nAmendments);
}

export function generateChain(opts: SynthGenOptions): SynthChainResult {
  const { seed, variant } = opts;
  const nClauses = opts.nClauses ?? 3;
  const nAmendments = opts.nAmendments ?? 2;

  if (nClauses < 2) throw new Error("nClauses must be >= 2 (need scoped + latest control)");
  if (nAmendments < 2) throw new Error("nAmendments must be >= 2 (scoped clause can't be in latest)");

  // Clause ids: 4.1, 4.2, ...
  const clauses = Array.from({ length: nClauses }, (_, i) => `4.${i + 1}`);

  // Old and new values per clause.
  const oldValues: Record<string, string> = {};
  const newValues: Record<string, string> = {};
  for (let i = 0; i < nClauses; i++) {
    oldValues[clauses[i]] = pickValue("old", i, seed);
    newValues[clauses[i]] = pickValue("new", i, seed);
  }

  // Which amendment (1-indexed) governs each clause.
  const governingAmendment: Record<string, number> = {};
  for (let i = 0; i < nClauses; i++) {
    governingAmendment[clauses[i]] = assignAmendment(i, nClauses, nAmendments);
  }

  // The scoped-current clause is the one assigned to amendment 1 (clauseIdx=0).
  const scopedClause = clauses[0];

  // Master document: defines all clauses with their OLD values.
  // Format: "Section 4.k is set at <OLD VALUE>." — extractValue falls back to
  // first sentence (no "as follows:" in master).
  const masterLines = clauses.map(
    (cl) => `Section ${cl} is set at ${oldValues[cl]}.`,
  );
  const masterText = masterLines.join("\n");

  // Amendments map: amendmentIdx (1-based) → list of (clause, newValue) restated.
  const amendmentClauses: Record<number, string[]> = {};
  for (let a = 1; a <= nAmendments; a++) amendmentClauses[a] = [];
  for (const cl of clauses) amendmentClauses[governingAmendment[cl]].push(cl);

  // Build amendment documents.
  const docs: ChainDoc[] = [{ id: "master", order: 0, text: masterText }];

  for (let a = 1; a <= nAmendments; a++) {
    const isLatest = a === nAmendments;
    const parts: string[] = [];

    // Operative restates for clauses governed by this amendment.
    for (const cl of amendmentClauses[a]) {
      parts.push(
        `Section ${cl} is hereby amended and restated in its entirety as follows: "${newValues[cl]}".`,
      );
    }

    // Stale recital: in the LATEST amendment, recite EVERY scoped-current clause
    // (one governed by a non-latest amendment) with its OLD value, so Arm A's
    // most-recent mention is stale across the WHOLE scoped bucket — not just one
    // clause. The recital uses "reads as follows:" (not any operative phrase) so
    // parseCitations emits NO op (governing pointer is unaffected; ground truth
    // intact). `scopedClause` (clauses[0]) is always among these.
    if (variant === "stale" && isLatest) {
      for (const cl of clauses) {
        if (governingAmendment[cl] !== nAmendments) {
          parts.push(
            `For reference, Section ${cl} remains in full force and reads as follows: "${oldValues[cl]}".`,
          );
        }
      }
    }

    docs.push({
      id: `amendment-${a}`,
      order: a,
      text: parts.join(" "),
    });
  }

  // noValueClauses: section ids that don't appear anywhere in the chain.
  const noValueClauses = ["4.99", "4.100"];

  return { docs, noValueClauses };
}
