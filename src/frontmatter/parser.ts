// Parses a markdown document into its frontmatter and body.
//
// gray-matter does the YAML extraction; validateFrontmatter coerces and checks
// it. Parsing fails (Result.err) only when the YAML itself is malformed.
// Frontmatter that parses but violates the schema is NOT a failure — the
// validation report carries those issues so a read can still return content.

import matter from "gray-matter";
import { validateFrontmatter } from "./schema.js";
import {
  err,
  ok,
  type Frontmatter,
  type Result,
  type ValidationReport,
} from "./types.js";

export interface ParsedDocument {
  frontmatter: Frontmatter; // coerced, always complete
  content: string; // markdown body with the frontmatter block stripped
  raw: Record<string, unknown>; // frontmatter exactly as parsed from YAML
  validation: ValidationReport;
  hasFrontmatter: boolean;
}

export function parseDocument(source: string): Result<ParsedDocument, Error> {
  let extracted: matter.GrayMatterFile<string>;
  try {
    extracted = matter(source);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`malformed YAML frontmatter: ${reason}`));
  }

  const raw = (extracted.data ?? {}) as Record<string, unknown>;
  const { frontmatter, report } = validateFrontmatter(raw);

  return ok({
    frontmatter,
    content: extracted.content,
    raw,
    validation: report,
    hasFrontmatter: Object.keys(raw).length > 0,
  });
}
