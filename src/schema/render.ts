// Text rendering for `daftari schema infer` / `daftari schema diff`. JSON
// output (--json) skips this and serializes the report directly.

import type { InferredSchema, SchemaDiffReport } from "./types.js";

function fmtExample(v: unknown): string {
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

export function renderInfer(report: InferredSchema): string {
  const lines: string[] = [];
  const scopeLabel = report.scope ? ` (scope: ${report.scope})` : "";
  lines.push(`Inferred frontmatter schema${scopeLabel} — ${report.totalDocs} doc(s) scanned`);
  if (report.skipped.length > 0) {
    lines.push(`  ${report.skipped.length} doc(s) skipped (unreadable or unparseable):`);
    for (const s of report.skipped) lines.push(`    ${s.path}: ${s.reason}`);
  }
  lines.push("");
  if (report.fields.length === 0) {
    lines.push("No frontmatter keys found.");
    return `${lines.join("\n")}\n`;
  }
  for (const f of report.fields) {
    const pct = report.totalDocs > 0 ? Math.round((f.occurrences / report.totalDocs) * 100) : 0;
    const enumTag = f.enumLike ? " [enum-like]" : "";
    const capTag = f.distinctValuesCapped ? "+" : "";
    lines.push(
      `${f.field}  ·  ${f.occurrences}/${report.totalDocs} docs (${pct}%)  ·  ` +
        `${f.types.join("|")}  ·  ${f.distinctValues}${capTag} distinct${enumTag}`,
    );
    if (f.examples.length > 0) {
      lines.push(`    examples: ${f.examples.map(fmtExample).join(", ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderDiff(report: SchemaDiffReport): string {
  const lines: string[] = [];
  const scopeLabel = report.scope ? ` (scope: ${report.scope})` : "";
  lines.push(`Schema diff${scopeLabel} — ${report.totalDocs} doc(s) scanned`);
  lines.push("");

  lines.push(`Undeclared keys in wide use (${report.undeclared.length}):`);
  if (report.undeclared.length === 0) {
    lines.push("  (none)");
  } else {
    for (const u of report.undeclared) {
      const enumTag = u.enumLike ? " [enum-like]" : "";
      const nearMiss = u.nearMiss ? `  — near-miss of declared '${u.nearMiss}'?` : "";
      lines.push(
        `  ${u.field}  ·  ${u.occurrences} doc(s)  ·  ${u.types.join("|")}${enumTag}${nearMiss}`,
      );
    }
  }
  lines.push("");

  lines.push(`Declared extensions never observed (${report.unusedExtensions.length}):`);
  if (report.unusedExtensions.length === 0) {
    lines.push("  (none)");
  } else {
    for (const u of report.unusedExtensions) lines.push(`  ${u.field}  ·  declared as ${u.type}`);
  }
  lines.push("");

  lines.push(`Declared fields drifting from their schema (${report.drift.length}):`);
  if (report.drift.length === 0) {
    lines.push("  (none)");
  } else {
    for (const d of report.drift) {
      lines.push(
        `  ${d.field}  ·  ${d.offending}/${d.occurrences} doc(s) violate declared ${d.declaredType}`,
      );
      for (const m of d.messages) lines.push(`    - ${m}`);
      if (d.examples.length > 0) {
        lines.push(`    examples: ${d.examples.map(fmtExample).join(", ")}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}
