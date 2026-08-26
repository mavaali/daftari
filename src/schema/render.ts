import type { SchemaDiff } from "./diff.js";
import type { InferredSchema } from "./infer.js";
import type { SchemaScanIssue } from "./scan.js";

function escapeTableText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/g, "\\n");
}

function cell(value: unknown): string {
  return escapeTableText(JSON.stringify(value) ?? String(value)).replaceAll("`", "\\`");
}

function inlineCode(value: string): string {
  const safe = value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/g, "\\n");
  const longestRun = Math.max(0, ...[...safe.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longestRun + 1);
  const padding = safe.startsWith("`") || safe.endsWith("`") ? " " : "";
  return `${fence}${padding}${safe}${padding}${fence}`;
}

function scanSummary(
  vault: string,
  scope: string | undefined,
  filesScanned: number,
  documentsAnalyzed: number,
  issues: SchemaScanIssue[],
): string[] {
  return [
    `- vault: ${inlineCode(vault)}`,
    `- scope: ${scope ? inlineCode(scope) : "whole vault"}`,
    `- files scanned: ${filesScanned}`,
    `- documents analyzed: ${documentsAnalyzed}`,
    `- skipped documents: ${issues.length}`,
  ];
}

function scanIssueSection(issues: SchemaScanIssue[]): string[] {
  if (issues.length === 0) return [];
  return [
    "",
    "## Skipped documents",
    "",
    ...issues.map((issue) => `- ${inlineCode(issue.path)}: ${inlineCode(issue.message)}`),
  ];
}

export function renderInferredSchema(
  vault: string,
  scope: string | undefined,
  scan: { filesScanned: number; issues: SchemaScanIssue[] },
  schema: InferredSchema,
): string {
  const lines = [
    "# Frontmatter schema inference",
    "",
    ...scanSummary(vault, scope, scan.filesScanned, schema.documentCount, scan.issues),
    "",
    "| field | occurrences | prevalence | observed types | distinct values | enum-like | examples |",
    "|---|---:|---:|---|---:|---|---|",
  ];
  for (const field of schema.fields) {
    lines.push(
      `| ${inlineCode(field.field)} | ${field.occurrences} | ${(field.prevalence * 100).toFixed(1)}% | ` +
        `${field.types.join(", ")} | ${field.distinctValues}${field.distinctValuesCapped ? "+" : ""} | ` +
        `${field.enumLike ? "yes" : "no"} | ${cell(field.examples)} |`,
    );
  }
  if (schema.fields.length === 0) lines.push("| _none_ | 0 | 0.0% | — | 0 | no | [] |");
  lines.push(...scanIssueSection(scan.issues), "");
  return lines.join("\n");
}

export function renderSchemaDiff(
  vault: string,
  scope: string | undefined,
  scan: { filesScanned: number; issues: SchemaScanIssue[] },
  diff: SchemaDiff,
): string {
  const lines = [
    "# Frontmatter schema drift",
    "",
    ...scanSummary(vault, scope, scan.filesScanned, diff.documentCount, scan.issues),
    `- undeclared-field threshold: ${diff.minOccurrences} occurrence(s)`,
    "",
    "## Undeclared fields in wide use",
    "",
  ];
  if (diff.undeclared.length === 0) lines.push("_none_");
  else {
    lines.push(
      "| field | occurrences | prevalence | observed types | distinct values | enum-like | examples |",
      "|---|---:|---:|---|---:|---|---|",
    );
    for (const field of diff.undeclared) {
      lines.push(
        `| ${inlineCode(field.field)} | ${field.occurrences} | ${(field.prevalence * 100).toFixed(1)}% | ` +
          `${field.types.join(", ")} | ${field.distinctValues}${field.distinctValuesCapped ? "+" : ""} | ` +
          `${field.enumLike ? "yes" : "no"} | ${cell(field.examples)} |`,
      );
    }
  }
  lines.push("", "## Declared but unused extensions", "");
  if (diff.unusedExtensions.length === 0) lines.push("_none_");
  else {
    lines.push("| field | declared type | required |", "|---|---|---|");
    for (const extension of diff.unusedExtensions) {
      lines.push(
        `| ${inlineCode(extension.field)} | ${extension.type} | ${extension.required ? "yes" : "no"} |`,
      );
    }
  }
  lines.push("", "## Observed value drift", "");
  if (diff.valueDrift.length === 0) lines.push("_none_");
  else {
    lines.push(
      "| field | declared type | offending / observed | problems | evidence examples |",
      "|---|---|---:|---|---|",
    );
    for (const drift of diff.valueDrift) {
      lines.push(
        `| ${inlineCode(drift.field)} | ${drift.declaredType} | ${drift.offending} / ${drift.occurrences} | ` +
          `${escapeTableText(drift.messages.join("; "))}${
            drift.messagesCapped ? ` (+${drift.omittedMessages} omitted)` : ""
          } | ${cell(drift.examples)} |`,
      );
    }
  }
  lines.push("", "## Near-miss field names", "");
  if (diff.nearMisses.length === 0) lines.push("_none_");
  else {
    lines.push(
      "| observed | declared candidate | edit distance | occurrences |",
      "|---|---|---:|---:|",
    );
    for (const miss of diff.nearMisses) {
      lines.push(
        `| ${inlineCode(miss.field)} | ${inlineCode(miss.suggestedField)} | ${miss.distance} | ${miss.occurrences} |`,
      );
    }
  }
  lines.push(...scanIssueSection(scan.issues), "");
  return lines.join("\n");
}
