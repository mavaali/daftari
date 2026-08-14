// src/distill/output-fence.ts
//
// U11 — distill-and-discard fence (R8). Distill COMPILES conversation into
// graded belief; it must never emit RAW source material. This is the emit-time
// guard that keeps that invariant enforceable: it refuses any proposal whose
// landing would put it in the raw/source tier that `daftari import` and the
// interview transcript path own.
//
// The emitter (propose.ts) hardcodes a `provenance: synthesized`, distill-
// collection proposal with no tier, so in normal operation this never fires.
// It exists as defense-in-depth: a bad path override (U5's update-in-place
// threads caller-supplied paths) or a future refactor must fail LOUD rather
// than silently poison the import-reserved namespace.

import { err, ok, type Result } from "../frontmatter/types.js";

/**
 * Refuse a distill output landing that would write raw/source material.
 *
 * Two invariants:
 *   1. The target path's top-level segment must not be `raw/` — that namespace
 *      is reserved for `daftari import`'s verbatim ingest. (A non-leading
 *      `raw` segment or a slug that merely contains "raw" is fine.)
 *   2. The frontmatter must not be `tier: source` — that is the raw-ingested
 *      marker, immutable to every writer (src/tools/write.ts). Distill output
 *      is compiled, never source.
 *
 * Returns `ok` when the landing is safe, `err` (to skip the proposal) otherwise.
 */
export function refuseRawDistillOutput(
  targetPath: string,
  frontmatter: Record<string, unknown>,
): Result<void, Error> {
  const leadingSegment = targetPath.replace(/\\/g, "/").split("/")[0];
  if (leadingSegment === "raw") {
    return err(
      new Error(`distill output path is under the import-reserved raw/ namespace: ${targetPath}`),
    );
  }
  if (frontmatter.tier === "source") {
    return err(
      new Error(`distill output must not be tier: source (raw-ingested material): ${targetPath}`),
    );
  }
  return ok(undefined);
}
