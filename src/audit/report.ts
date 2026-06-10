// src/audit/report.ts
// Pure formatters over AuditReport. No IO.

import type {
  AuditReport,
  BrokenRefFinding,
  DescribesRefFinding,
  StalenessFinding,
} from "./types.js";

function renderBrokenRefs(rows: BrokenRefFinding[]): string {
  if (rows.length === 0) return "_no broken cross-repo references._\n";
  const lines = ["| kind | source | target | href |", "|---|---|---|---|"];
  for (const r of rows) {
    const targetAnchor = r.target.anchor ? `#${r.target.anchor}` : "";
    lines.push(
      `| ${r.kind} | ${r.source.repo}/${r.source.path} | ` +
        `${r.target.repo}/${r.target.path}${targetAnchor} | \`${r.rawHref}\` |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderStaleness(rows: StalenessFinding[]): string {
  if (rows.length === 0) return "_no staleness findings._\n";
  const lines = ["| kind | doc | mtime | chain |", "|---|---|---|---|"];
  for (const r of rows) {
    const chain = r.staleChain ? r.staleChain.map((n) => `${n.repo}/${n.path}`).join(" → ") : "—";
    lines.push(`| ${r.kind} | ${r.repo}/${r.path} | ${r.mtime} | ${chain} |`);
  }
  return `${lines.join("\n")}\n`;
}

function renderDescribesRefs(rows: DescribesRefFinding[]): string {
  if (rows.length === 0) return "_no broken doc-to-code bindings._\n";
  const lines = ["| source | target | binding |", "|---|---|---|"];
  for (const r of rows) {
    const sym = r.target.symbol ? `::${r.target.symbol}` : "";
    lines.push(
      `| ${r.source.repo}/${r.source.path} | ${r.target.repo}/${r.target.path}${sym} | \`${r.raw}\` |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderMarkdown(report: AuditReport): string {
  const t = report.totals;
  const empty =
    t.brokenRefs === 0 &&
    t.directlyStale === 0 &&
    t.transitivelyStale === 0 &&
    t.brokenDescribes === 0;
  const head = [
    "# Coherence Audit Report",
    "",
    `_generated: ${report.generatedAt}_`,
    "",
    "## Totals",
    "",
    `- repos scanned: **${t.reposScanned}**`,
    `- docs scanned: **${t.docsScanned}**`,
    `- broken cross-repo refs: **${t.brokenRefs}**`,
    `- directly stale docs: **${t.directlyStale}**`,
    `- transitively stale docs: **${t.transitivelyStale}**`,
    `- broken doc-to-code bindings: **${t.brokenDescribes}**`,
    "",
  ];
  if (empty) {
    head.push("_no findings — coherence checks passed._\n");
    return head.join("\n");
  }
  return [
    ...head,
    "## Broken cross-repo references",
    "",
    renderBrokenRefs(report.brokenRefs),
    "## Staleness",
    "",
    renderStaleness(report.staleness),
    "## Broken doc-to-code bindings",
    "",
    renderDescribesRefs(report.describesRefs),
  ].join("\n");
}

export function renderJson(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}
