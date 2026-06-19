// Obsidian-specific derivation helpers used only by the `daftari import obsidian`
// path. Pure: no I/O. Kept out of derive.ts so the general backfill derivation
// stays Obsidian-agnostic.

// An Obsidian inline tag: "#tag" or "#parent/child". Rules encoded here:
//   - preceded by start-of-line or whitespace (so "foo#bar" and a URL
//     "page#frag" never match),
//   - NOT followed by a space (that is a Markdown ATX heading, "# Title"),
//   - chars are letters / digits / "_" / "-" / "/",
//   - must contain at least one ASCII letter (Obsidian rejects purely numeric
//     "#1234"; we use "has a letter" as a simple, safe approximation).
// Non-ASCII/unicode tags are not harvested in v1 (documented limitation).
const INLINE_TAG = /(?:^|\s)#([A-Za-z0-9_/-]*[A-Za-z][A-Za-z0-9_/-]*)/g;

export function harvestInlineTags(body: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    // Toggle fenced code state on ``` or ~~~ (allowing leading whitespace).
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Blank out inline code spans so `#notatag` inside backticks is ignored.
    const noCode = line.replace(/`[^`]*`/g, " ");
    for (const m of noCode.matchAll(INLINE_TAG)) {
      // Trim trailing "-"/"/" punctuation (e.g. "#tag/" -> "tag").
      const tag = (m[1] as string).replace(/[/-]+$/, "");
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      found.push(tag);
    }
  }
  return found;
}

// Obsidian Web Clipper writes the captured page URL into a singular `source`
// frontmatter field. Daftari's equivalent is the plural `sources` array. Map it
// when `sources` is absent/empty; the original `source` key is left untouched
// (it survives as a custom field via serializeDocument's raw pass-through), so
// nothing is moved or lost -- `sources` is additively populated.
export function webClipperSources(raw: Record<string, unknown>): string[] | undefined {
  const existing = raw.sources;
  if (Array.isArray(existing) && existing.length > 0) return undefined;
  const source = raw.source;
  if (typeof source === "string" && source.trim().length > 0) return [source.trim()];
  return undefined;
}
