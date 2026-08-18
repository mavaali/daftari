// identity.ts — U2: Identity + fingerprint core.
//
// Two responsibilities, strictly separated:
//
//   deriveIdentity(source, check, target, discriminator?)
//     → a STABLE string key that uniquely identifies a finding.
//       The key does NOT change when evidence changes. It is computed
//       entirely from (source, check, target, discriminator?).
//
//   fingerprint(evidence)
//     → a hash of the CURRENT evidence payload. Changes when any
//       evidence field changes. NEVER feeds back into identity.
//
// Separation is the whole point:
//   identity key  → dedup / reopen decisions (joins across reconcile runs).
//   fingerprint   → re-triage signal (did the underlying data drift?).
//
// Native-id contract
// ------------------
// For sources that carry a stable native id in their target:
//   tension → "tension:<tensionId>"
//   staged  → "staged:<stagedActionId>"
// The check, discriminator, and evidence are all IGNORED for these sources.
// This ensures that the same real-world entity always maps to one key,
// regardless of which check or adapter discovered it.
//
// Discriminator contract
// ----------------------
// For hash-path sources (lint / staleness / tier2) the optional discriminator
// participates in the identity hash when supplied. The CALLER (the adapter)
// is responsible for drawing the discriminator exclusively from STABLE
// evidence (e.g. which broken source-ref), never from volatile fields
// (score, ageDays, timestamps). identity.ts cannot enforce that rule —
// it only guarantees the discriminator is included in the hash when present.

import { sha256Hex } from "../utils/hash.js";
import type { FindingSource, FindingTarget } from "./types.js";

// ---------------------------------------------------------------------------
// Version stamp — embedded in every LedgerEvent.identity_scheme_version so
// ledger consumers can detect and migrate across scheme changes.
// ---------------------------------------------------------------------------

export const IDENTITY_SCHEME_VERSION = "1";

// ---------------------------------------------------------------------------
// canonicalizeTarget — deterministic serialization of a FindingTarget for
// use in the hash-path. Sorts struct fields so insertion order doesn't matter.
// ---------------------------------------------------------------------------

function canonicalizeTarget(target: FindingTarget): string {
  switch (target.kind) {
    case "lint":
      return `lint:${target.path}`;
    case "staleness":
      return `staleness:${target.path}`;
    case "tension":
      return `tension:${target.tensionId}`;
    case "staged":
      return `staged:${target.stagedActionId}`;
    case "tier2":
      // Fields are serialized in alphabetical order to be insertion-order-stable.
      return `tier2:artifact=${target.artifact}:edgeClass=${target.edgeClass}:unit=${target.unit}`;
  }
}

// ---------------------------------------------------------------------------
// deriveIdentity — stable identity key for a finding.
// ---------------------------------------------------------------------------

export function deriveIdentity(
  source: FindingSource,
  check: string,
  target: FindingTarget,
  discriminator?: string,
): string {
  // Native-id fast path: tension and staged carry their own stable id.
  // The check, discriminator, and any evidence are intentionally ignored here.
  if (target.kind === "tension") {
    return `tension:${target.tensionId}`;
  }
  if (target.kind === "staged") {
    return `staged:${target.stagedActionId}`;
  }

  // Hash-path: stable tuple hash over (source, check, canonicalized-target,
  // discriminator?). Discriminator participates only when supplied.
  const parts: string[] = [source, check, canonicalizeTarget(target)];
  if (discriminator !== undefined) {
    parts.push(discriminator);
  }
  // Join with NUL so fields can't bleed into each other (e.g. "lint" + "check"
  // vs "lin" + "tcheck" would collide with plain concatenation).
  return sha256Hex(parts.join("\0"));
}

// ---------------------------------------------------------------------------
// canonicalizeEvidence — sorts all object keys (recursively) so that two
// evidence objects with identical content but different insertion order
// produce the same JSON string, and thus the same fingerprint.
// ---------------------------------------------------------------------------

function canonicalizeEvidence(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeEvidence);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = canonicalizeEvidence(obj[key]);
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// fingerprint — hash of the current evidence payload.
//
// Canonicalizes (sorts keys recursively) before hashing, so two evidence
// objects that are logically identical but differ only in key insertion order
// yield the same fingerprint.
// ---------------------------------------------------------------------------

export function fingerprint(evidence: Record<string, unknown>): string {
  return sha256Hex(JSON.stringify(canonicalizeEvidence(evidence)));
}
