// Markdown + JSON rendering for `daftari court`. The docket reads like a
// cause list: numbered cases in priority order, each with the two sides,
// the stakes (blast), and the precedents. Claims and rationales are quoted
// from the tension log verbatim — the court report frames, it never
// paraphrases.

import type { Docket, DocketEntry } from "./docket.js";

export interface CourtReport {
  generatedAt: string;
  vault: string;
  docket: Docket;
  // Set when the report is a single-case brief (--tension <id>).
  briefId: string | null;
}

function tierBadge(e: DocketEntry): string {
  const parts = [e.agingTier ?? "unclassified", e.kind, `${e.ageDays}d`];
  return parts.join(" · ");
}

function renderSide(label: string, s: DocketEntry["sideA"]): string[] {
  const state = s.decayLevel !== null ? `${s.status}, ${s.decayLevel}` : s.status;
  return [`- **${label}:** \`${s.path}\` (${state})`, `  > ${s.claim}`];
}

function renderEntry(e: DocketEntry, index: number, full: boolean): string[] {
  const lines: string[] = [];
  lines.push(`## ${index}. ${e.title}  [${tierBadge(e)}]`);
  lines.push("");
  lines.push(`- id: ${e.id ?? "(none — legacy entry, cannot be ruled by id)"}`);
  lines.push(...renderSide("A", e.sideA));
  lines.push(...renderSide("B", e.sideB));
  lines.push(
    `- **stakes:** ${e.blast.total} downstream document(s) ` +
      `(${e.blast.primary} primary, ${e.blast.advisory} advisory, max depth ${e.blast.maxDepth})`,
  );
  if (e.clusterId) {
    lines.push(`- cluster: ${e.clusterId} (${e.clusterSize} docs)`);
  }
  if (e.precedents.length > 0) {
    lines.push(`- **precedents:**`);
    for (const p of e.precedents) {
      const head = `  - [${p.matchTier}] ${p.date} · “${p.title}” → **${p.resolutionKind}** (${p.matchDetail})`;
      lines.push(head);
      if (full && p.rationale) lines.push(`    > ${p.rationale}`);
      if (full && p.references.length > 0) lines.push(`    refs: ${p.references.join(", ")}`);
    }
  } else {
    lines.push("- precedents: none — first impression");
  }
  if (e.id) {
    lines.push(
      `- to rule: \`daftari court rule ${e.id} --kind <superseded|corrected|accepted|invalid> --rationale "…"\``,
    );
  }
  lines.push("");
  return lines;
}

export function renderMarkdown(report: CourtReport): string {
  const { docket, briefId } = report;
  const lines: string[] = [];

  if (briefId !== null) {
    const entry = docket.entries.find((e) => e.id === briefId);
    lines.push(`# Tension Court — Brief`);
    lines.push("");
    if (!entry) {
      lines.push(`No open tension with id \`${briefId}\` on the docket.`);
      lines.push("");
      return `${lines.join("\n")}\n`;
    }
    lines.push(...renderEntry(entry, 1, true));
    return `${lines.join("\n")}\n`;
  }

  lines.push(`# Tension Court — Docket`);
  lines.push("");
  lines.push(
    `**${docket.openCount}** case(s) open · **${docket.rulingCount}** ruling(s) on record`,
  );
  lines.push("");
  if (docket.entries.length === 0) {
    lines.push("The docket is clear. No open tensions.");
    lines.push("");
  }
  docket.entries.forEach((e, i) => {
    lines.push(...renderEntry(e, i + 1, false));
  });

  return `${lines.join("\n")}\n`;
}

export function renderJson(report: CourtReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
