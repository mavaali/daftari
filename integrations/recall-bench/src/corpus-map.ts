// Maps one Recall Bench day onto a daftari daily note.
//
// Daftari has no bespoke metadata layer — everything rides in YAML frontmatter,
// and reindexVault SILENTLY COERCES anything that violates the builtin schema
// (e.g. an unquoted ISO date becomes a Date, then a string; a bad enum falls
// back). So this mapper must emit only values that survive parseDocument
// byte-for-byte: the value we write must deep-equal the value daftari reads
// back. The corpus-map.test.ts gate enforces exactly that.
//
// Concretely: date scalars are QUOTED so YAML keeps them as the literal string
// "YYYY-MM-DD" rather than parsing them into Date objects (which would then be
// coerced and no longer equal the raw value). dayNumber stays an unquoted
// number. Arrays use a flow sequence of double-quoted strings.

import type { DayMetadata } from "./types.js";

export interface DaftariDaily {
  relPath: string;
  markdown: string;
}

// Escape a value for a YAML double-quoted scalar: backslash and double-quote
// are the only characters that need escaping inside a double-quoted YAML string.
function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlStringArray(values: string[]): string {
  return `[${values.map(yamlQuote).join(", ")}]`;
}

export function mapDay(day: number, content: string, meta: DayMetadata): DaftariDaily {
  const padded = String(day).padStart(4, "0");
  const relPath = `${meta.personaId}/day-${padded}.md`;

  const title = `Day ${day} — ${meta.personaId}`;

  // Builtin daftari fields, then benchmark extension fields. Every scalar that
  // must stay a string is quoted; dayNumber is emitted as a bare number.
  const lines = [
    "---",
    `title: ${yamlQuote(title)}`,
    `collection: ${yamlQuote(meta.personaId)}`,
    `tags: ${yamlStringArray(meta.activeArcs)}`,
    `created: ${yamlQuote(meta.date)}`,
    `updated: ${yamlQuote(meta.date)}`,
    // Daftari requires these enums + updated_by, and SILENTLY COERCES them to
    // fallback values when absent (domain→accumulation, status→draft,
    // confidence→low, provenance→inferred). A benchmark daily is an observed,
    // first-party log entry, so we set those values EXPLICITLY rather than let
    // them be coerced — the corpus then indexes deterministically and
    // validation reports zero issues.
    `domain: accumulation`,
    `status: canonical`,
    `confidence: high`,
    `updated_by: ${yamlQuote("agent:recall-bench")}`,
    `provenance: direct`,
    // Extension fields — harmless to daftari, useful for traceability.
    `dayNumber: ${meta.dayNumber}`,
    `date: ${yamlQuote(meta.date)}`,
    "---",
    "",
    content,
    "",
  ];

  return { relPath, markdown: lines.join("\n") };
}
