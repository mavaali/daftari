// src/audit/report.ts
// Pure formatters over AuditReport. No IO.

import type { PinApplyResult, PinPlanResult } from "./pin.js";
import type { SemanticFinding } from "./semantic.js";
import type {
  AuditReport,
  BrokenRefFinding,
  DescribesRefFinding,
  PinFinding,
  RegistryMismatch,
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

function renderPins(rows: PinFinding[]): string {
  if (rows.length === 0) return "_no pinned bindings._\n";
  const lines = ["| state | source | target | relocated |", "|---|---|---|---|"];
  for (const r of rows) {
    const relocated = r.relocated ? `L${r.relocated.start}-${r.relocated.end}` : "—";
    lines.push(
      `| ${r.state} | ${r.source.repo}/${r.source.path} | ${r.target.repo}/${r.target.path} | ${relocated} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderRegistryMismatches(rows: RegistryMismatch[]): string {
  if (rows.length === 0) return "";
  const lines = ["", "## Registry mismatches (read path vs. audit registry)", ""];
  for (const r of rows) {
    lines.push(`- '${r.repo}' referenced from ${r.docsRepo}: ${r.detail}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderSemantic(rows: SemanticFinding[]): string {
  // Only non-coherent verdicts are worth surfacing (drifted, contradicted, skipped).
  const notable = rows.filter((r) => r.verdict !== "coherent");
  if (notable.length === 0) return "_all checked bindings are coherent._\n";
  const lines = ["| verdict | source | target | detail |", "|---|---|---|---|"];
  for (const r of notable) {
    const sym = r.target.symbol ? `::${r.target.symbol}` : "";
    const detail =
      r.verdict === "skipped"
        ? (r.reason ?? "skipped")
        : r.contradictions.join("; ") || "(no detail)";
    lines.push(
      `| ${r.verdict} | ${r.source.repo}/${r.source.path} | ${r.target.repo}/${r.target.path}${sym} | ${detail} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderMarkdown(report: AuditReport): string {
  const t = report.totals;
  const empty =
    t.brokenRefs === 0 &&
    t.outOfScopeTargets === 0 &&
    t.directlyStale === 0 &&
    t.transitivelyStale === 0 &&
    t.brokenDescribes === 0 &&
    t.pinsMoved === 0 &&
    t.pinsMissing === 0 &&
    report.semantic.length === 0 &&
    report.registryMismatches.length === 0;
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
    `- out-of-scope targets (exist on disk, outside audited repos): **${t.outOfScopeTargets}**`,
    `- directly stale docs: **${t.directlyStale}**`,
    `- transitively stale docs: **${t.transitivelyStale}**`,
    `- broken doc-to-code bindings: **${t.brokenDescribes}**`,
    `- doc-to-code semantic drift: **${t.semanticDrifted}**`,
    `- code pins intact / moved / missing: **${t.pinsIntact} / ${t.pinsMoved} / ${t.pinsMissing}**`,
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
    "## Pin verification",
    "",
    renderPins(report.pins),
    ...(report.semantic.length > 0
      ? ["## Semantic coherence", "", renderSemantic(report.semantic)]
      : []),
    renderRegistryMismatches(report.registryMismatches),
  ].join("\n");
}

// --- `daftari audit --pin` / `--pin --apply` output (pure formatters) -----

export function renderPinPlan(plan: PinPlanResult): string {
  const lines: string[] = [
    `daftari audit --pin: plan for docs repo '${plan.docsRepoName}' (${plan.docsRepoPath})`,
    "",
  ];
  if (plan.proposals.length === 0) {
    lines.push("no unpinned, plannable bindings found.");
  } else {
    for (const p of plan.proposals) {
      lines.push(`${p.path} · ${p.oldEntry} -> ${p.newEntry}`);
    }
  }
  lines.push("", `proposed: ${plan.proposals.length}`);
  if (plan.skipped.length > 0) {
    lines.push("", "skipped: working tree differs from HEAD (commit first, then re-run):");
    for (const s of plan.skipped) lines.push(`  ${s.path} · ${s.repo}:${s.targetPath}`);
    lines.push(`skipped: ${plan.skipped.length}`);
  }
  if (plan.unpinnable.length > 0) {
    lines.push(
      "",
      "unpinnable: not in code_repos (referenced only by the audit's --code-repo/audit.yaml registry):",
    );
    for (const prefix of plan.unpinnable) lines.push(`  ${prefix}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderPinApplyResult(result: PinApplyResult): string {
  const lines: string[] = [
    `daftari audit --pin --apply: ${result.applied.length} doc(s) written, ` +
      `${result.unchanged.length} already at their proposed state, ${result.skipped.length} skipped`,
  ];
  if (result.commit) lines.push(`commit: ${result.commit}`);
  for (const s of result.skipped) lines.push(`skipped: ${s.path} — ${s.reason}`);
  return `${lines.join("\n")}\n`;
}

export function renderJson(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}
