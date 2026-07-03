// Parses a markdown document into its frontmatter and body.
//
// gray-matter does the YAML extraction; validateFrontmatter coerces and checks
// it. Parsing fails (Result.err) only when the YAML itself is malformed.
// Frontmatter that parses but violates the schema is NOT a failure — the
// validation report carries those issues so a read can still return content.

import matter from "gray-matter";
import { validateFrontmatter } from "./schema.js";
import { err, type Frontmatter, ok, type Result, type ValidationReport } from "./types.js";

export interface ParsedDocument {
  frontmatter: Frontmatter; // coerced, always complete
  content: string; // markdown body with the frontmatter block stripped
  raw: Record<string, unknown>; // frontmatter exactly as parsed from YAML
  validation: ValidationReport;
  hasFrontmatter: boolean;
}

// Upper bound on the source we will hand to gray-matter's synchronous parse.
// A pathologically large `.md` — reachable via `daftari import` over an
// arbitrary folder — would otherwise block the event loop (and risk OOM) while
// matter() parses it in one shot. 5 MiB is far larger than any legitimate
// curated markdown doc; anything past it is treated as non-content and skipped
// with an err Result rather than parsed. Measured in UTF-8 bytes, not JS string
// length, so multi-byte content is bounded by real memory cost.
export const MAX_PARSE_BYTES = 5 * 1024 * 1024;

export function parseDocument(source: string): Result<ParsedDocument, Error> {
  const byteLength = Buffer.byteLength(source, "utf-8");
  if (byteLength > MAX_PARSE_BYTES) {
    return err(
      new Error(
        `document too large to parse: ${byteLength} bytes exceeds the ${MAX_PARSE_BYTES}-byte cap`,
      ),
    );
  }

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
