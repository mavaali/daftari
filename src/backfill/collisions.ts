// Frontmatter field-name collision detection for `daftari backfill` (#116).
//
// A collision is a present field whose NAME is one of Daftari's built-in ENUM
// fields but whose VALUE is outside that field's enum — i.e. an existing wiki's
// own vocabulary (status: ACTIVE, domain: Architecture) clashing with Daftari's
// reserved meaning. Detecting it lets backfill preserve the value and tell the
// operator to rename, instead of silently laundering it into a default. Pure.

import { CONFIDENCES, DOMAINS, PROVENANCES, STATUSES } from "../frontmatter/types.js";
import type { Collision } from "./types.js";

// The built-in fields whose values are constrained to an enum. Non-enum
// built-ins (title, dates, arrays) are out of scope: a malformed value there is
// ordinary invalid frontmatter the apply guard already catches.
const ENUM_FIELDS: Record<string, readonly string[]> = {
  domain: DOMAINS,
  status: STATUSES,
  confidence: CONFIDENCES,
  provenance: PROVENANCES,
};

// Present means non-null, non-undefined, non-empty-string — mirrors derive's
// isPresent so detection and preservation agree on what counts as "present".
function isPresent(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string" && v.length === 0) return false;
  return true;
}

export function detectCollisions(raw: Record<string, unknown>): Collision[] {
  const collisions: Collision[] = [];
  for (const [field, expected] of Object.entries(ENUM_FIELDS)) {
    const v = raw[field];
    if (!isPresent(v)) continue;
    if (typeof v === "string" && expected.includes(v)) continue;
    collisions.push({ field, value: String(v), expected });
  }
  return collisions;
}
