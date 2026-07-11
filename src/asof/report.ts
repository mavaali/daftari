// Markdown + JSON rendering for `daftari asof`. Mirrors the audit report's
// conventions: markdown to stdout by default, JSON carries the same
// structure with full detail, long lists are capped in markdown (never in
// JSON) with an explicit "+n more" so truncation is visible, not silent.

import type { AsofReplay, AsofSnapshot, DocTrajectory } from "./snapshot.js";

const LIST_CAP = 50;

export interface AsofReport {
  generatedAt: string;
  vault: string;
  snapshot: AsofSnapshot;
  trajectory: DocTrajectory | null;
  replay: AsofReplay | null;
}

function cappedList(items: string[], render: (s: string) => string): string[] {
  const shown = items.slice(0, LIST_CAP).map(render);
  if (items.length > LIST_CAP) shown.push(`- …and ${items.length - LIST_CAP} more`);
  return shown;
}

function countLine(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${n}`);
  return parts.length > 0 ? parts.join(" · ") : "(none)";
}

export function renderMarkdown(report: AsofReport): string {
  const { snapshot, trajectory, replay } = report;
  const short = snapshot.commit.hash.slice(0, 8);
  const lines: string[] = [];

  lines.push(`# Belief Snapshot — as of ${snapshot.commit.date} (${short})`);
  lines.push("");
  lines.push(`> ${snapshot.commit.subject}`);
  lines.push("");
  lines.push("## The vault then");
  lines.push(`- documents: **${snapshot.docCount}**`);
  lines.push(`- by status: ${countLine(snapshot.byStatus)}`);
  lines.push(`- by collection: ${countLine(snapshot.byCollection)}`);
  lines.push("");

  lines.push(`## Drift since (${short}..now)`);
  const d = snapshot.drift;
  lines.push(
    `- added: **${d.added.length}** · removed: **${d.removed.length}** · ` +
      `belief transitions: **${d.transitions.length}** · bodies changed: **${d.bodiesChanged}**`,
  );
  lines.push("");
  if (d.transitions.length > 0) {
    lines.push("### Belief transitions");
    lines.push("| doc | field | then | now |");
    lines.push("|-----|-------|------|-----|");
    for (const t of d.transitions.slice(0, LIST_CAP)) {
      lines.push(`| ${t.path} | ${t.field} | ${t.from} | ${t.to} |`);
    }
    if (d.transitions.length > LIST_CAP) {
      lines.push(`| …and ${d.transitions.length - LIST_CAP} more | | | |`);
    }
    lines.push("");
  }
  if (d.added.length > 0) {
    lines.push("### Added since");
    lines.push(...cappedList(d.added, (p) => `- ${p}`));
    lines.push("");
  }
  if (d.removed.length > 0) {
    lines.push("### Removed since");
    lines.push(...cappedList(d.removed, (p) => `- ${p}`));
    lines.push("");
  }

  const tn = snapshot.tensions;
  lines.push("## Tensions");
  lines.push(`- open then: **${tn.openThen}** · open now: **${tn.openNow}**`);
  if (tn.openedSince.length > 0) {
    lines.push(`- opened since: **${tn.openedSince.length}**`);
    for (const t of tn.openedSince.slice(0, LIST_CAP)) {
      lines.push(`  - ${t.date} · ${t.kind} · ${t.title}`);
    }
  }
  if (tn.resolvedSince.length > 0) {
    lines.push(`- resolved since: **${tn.resolvedSince.length}**`);
    for (const t of tn.resolvedSince.slice(0, LIST_CAP)) {
      lines.push(`  - ${t.date} · ${t.kind} · ${t.title} → ${t.resolutionKind}`);
    }
  }
  lines.push("");

  if (replay) {
    lines.push(`## Counterfactual replay — ${replay.document}`);
    lines.push(
      `Downstream of this document **as of ${snapshot.commit.date}**: ` +
        `**${replay.downstreamThen.length}** documents ` +
        `(primary ${replay.primaryBlast}, advisory ${replay.advisoryBlast}, ` +
        `max depth ${replay.maxDepth}). ` +
        `Of those, **${replay.stillCanonicalNow}** are still canonical today and ` +
        `**${replay.goneNow}** are gone.`,
    );
    lines.push("");
    if (replay.downstreamThen.length > 0) {
      lines.push("| downstream doc (then) | dependency | distance | status now |");
      lines.push("|----------------------|------------|----------|------------|");
      for (const e of replay.downstreamThen.slice(0, LIST_CAP)) {
        lines.push(`| ${e.path} | ${e.dependency_type} | ${e.distance} | ${e.statusNow} |`);
      }
      if (replay.downstreamThen.length > LIST_CAP) {
        lines.push(`| …and ${replay.downstreamThen.length - LIST_CAP} more | | | |`);
      }
      lines.push("");
    }
  }

  if (trajectory) {
    lines.push(`## Document trajectory — ${trajectory.path}`);
    lines.push("| | then | now |");
    lines.push("|-|------|-----|");
    const fields = ["title", "status", "confidence", "updated", "provenance"] as const;
    for (const f of fields) {
      const a = trajectory.asOf ? trajectory.asOf[f] : "(absent)";
      const b = trajectory.current ? trajectory.current[f] : "(gone)";
      lines.push(`| ${f} | ${a} | ${b} |`);
    }
    lines.push("");
    if (trajectory.commitsBetween.length > 0) {
      lines.push(`### Commits touching it since (${trajectory.commitsBetween.length})`);
      for (const c of trajectory.commitsBetween.slice(0, LIST_CAP)) {
        lines.push(`- ${c.date} · ${c.hash.slice(0, 8)} · ${c.author} · ${c.subject}`);
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderJson(report: AsofReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
