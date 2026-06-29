// consensus-arm-a — the recency foil: a memory that trusts the latest ingested
// edit. Two snapshots per instance make the foil fair: it fails while the bad
// edit is latest ("before") and passes once it ingests the revert ("after").
import type { ParsedPassage } from "./consensus-passage.js";

export type Snapshot = "before" | "after";
export type Classification = "governing" | "stale" | "other";

export interface ArmAnswer {
  answer: string;
}

export function armA(passage: ParsedPassage, snapshot: Snapshot): ArmAnswer {
  return { answer: snapshot === "before" ? passage.staleText : passage.governingText };
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function classifyAnswer(answer: string, passage: ParsedPassage): Classification {
  const a = norm(answer);
  if (a === norm(passage.governingText)) return "governing";
  if (a === norm(passage.staleText)) return "stale";
  return "other";
}
