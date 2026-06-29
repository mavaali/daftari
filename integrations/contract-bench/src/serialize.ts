// serialize — render a CorpusDoc as daftari-ingestable markdown (YAML
// frontmatter + body). String scalars are JSON-encoded, which is valid YAML and
// unambiguous for clause ids like "4.2" / "12(a)". `superseded_by` must be the
// successor's vault path: resolveCurrentSource follows it by path lookup.

import type { CorpusDoc } from "./corpus.js";

export function renderDoc(doc: CorpusDoc): string {
  const fm = Object.entries(doc.frontmatter)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${fm}\n---\n${doc.body}\n`;
}
