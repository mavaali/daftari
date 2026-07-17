// Shared parser for the optional `run_id` trace identifier (#235/#233).
//
// A run id correlates one agent run's reads and writes: stamped into the
// provenance log on writes, the read log on reads, and staged-action
// proposals — the consumes-graph producer (#233) joins on it. Free text,
// caller-supplied; absent, null, or blank all resolve to `undefined`, and a
// non-string value is a hard error.

import { err, ok, type Result } from "../frontmatter/types.js";

export function readRunId(
  args: Record<string, unknown>,
  tool: string,
): Result<string | undefined, Error> {
  const v = args.run_id;
  if (v === undefined || v === null) return ok(undefined);
  if (typeof v !== "string") {
    return err(new Error(`${tool}: 'run_id' must be a string`));
  }
  const trimmed = v.trim();
  return ok(trimmed.length === 0 ? undefined : trimmed);
}
