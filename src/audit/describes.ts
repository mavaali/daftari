// src/audit/describes.ts
// Doc-to-code binding edges. Reads `describes` frontmatter entries off docs-repo
// documents, parses the `repo:path::symbol` form, and emits cross-repo edges
// that the reference-integrity check (checks/describes_refs.ts) verifies against
// the resolved target repo.

import type { DescribesEdge, RepoSnapshot } from "./types.js";

export interface DescribesPin {
  start: number | null; // 1-based line; null for a whole-file pin
  end: number | null; // inclusive; equals start for a bare `#L<n>`; null whole-file
  sha: string; // 7-40 lowercase hex — a git BLOB id prefix
}

export interface ParsedDescribes {
  repo: string; // resolved repo name — sourceRepo for a bare (prefix-less) entry
  path: string; // repo-relative code path
  symbol: string | null; // `::symbol` suffix, retained but unresolved in v1
  pin?: DescribesPin; // JIT anchor pin, present only for a well-formed pin suffix
  malformedPin?: true; // set when a pin suffix parsed structurally but was invalid
}

// The pin suffix (JIT anchors): an optional `[#L<start>[-<end>]]@<sha>` tail.
// End-anchored and sha-strict by construction, so a bare or `::symbol` entry
// with no matching tail parses byte-identically to v1, and a path that happens
// to contain `@`/`#` mid-string is unaffected. A tail whose sha is not 7-40
// lowercase hex is NOT a pin — it is part of the path (indistinguishable from a
// real path), so it degrades silently to a bare binding, never flagged.
const PIN_SUFFIX = /(?:#L(\d+)(?:-(\d+))?)?@([0-9a-f]{7,40})$/;

// Grammar (file-level in v1, plus the optional pin suffix):
//   <entry>  := [<repo> ":"] <path> ["::" <symbol>] [<pin>]
//   <pin>    := ["#L" <start> ["-" <end>]] "@" <sha>
// The pin suffix is stripped FIRST (it is a strict end-anchored tail), then the
// remainder is parsed by the unchanged v1 logic: `::` symbol split first so a
// single ":" in the remainder unambiguously marks the repo prefix. A
// prefix-less entry resolves against `sourceRepo`.
export function parseDescribesEntry(entry: string, sourceRepo: string): ParsedDescribes {
  let head = entry;
  let pin: DescribesPin | undefined;
  let malformedPin: true | undefined;

  const pinMatch = entry.match(PIN_SUFFIX);
  if (pinMatch) {
    const start = pinMatch[1] !== undefined ? Number.parseInt(pinMatch[1], 10) : null;
    // A bare `#L40` means the single line 40 — end defaults to start (spec).
    const end = pinMatch[2] !== undefined ? Number.parseInt(pinMatch[2], 10) : start;
    const sha = pinMatch[3] as string;
    head = entry.slice(0, pinMatch.index);
    if (start !== null && end !== null && end < start) {
      // Structurally a pin, semantically invalid: drop the pin, degrade to a
      // bare binding, and flag for the lint check (U6). Never throw or reject.
      malformedPin = true;
    } else {
      pin = { start, end, sha };
    }
  }

  const symbolIdx = head.indexOf("::");
  const symbol = symbolIdx === -1 ? null : head.slice(symbolIdx + 2).trim() || null;
  const bindingHead = symbolIdx === -1 ? head : head.slice(0, symbolIdx);

  const colonIdx = bindingHead.indexOf(":");
  const base: ParsedDescribes =
    colonIdx === -1
      ? { repo: sourceRepo, path: bindingHead.trim(), symbol }
      : {
          repo: bindingHead.slice(0, colonIdx).trim(),
          path: bindingHead.slice(colonIdx + 1).trim(),
          symbol,
        };

  if (pin) base.pin = pin;
  if (malformedPin) base.malformedPin = true;
  return base;
}

// One edge per describes entry on every docs-repo document. Code repos are
// reference targets only and never act as edge sources.
export function classifyDescribesEdges(snapshots: RepoSnapshot[]): DescribesEdge[] {
  const edges: DescribesEdge[] = [];
  for (const snap of snapshots) {
    if (snap.config.type === "code") continue;
    const sourceRepo = snap.config.name;
    for (const doc of snap.docs.values()) {
      for (const raw of doc.describes ?? []) {
        const parsed = parseDescribesEntry(raw, sourceRepo);
        // A blank or whitespace-only entry resolves to an empty target path —
        // skip it rather than emit a confusing "missing file: repo/" finding.
        if (parsed.path.length === 0) continue;
        edges.push({
          sourceRepo,
          sourcePath: doc.relPath,
          targetRepo: parsed.repo,
          targetPath: parsed.path,
          symbol: parsed.symbol,
          raw,
        });
      }
    }
  }
  return edges;
}
