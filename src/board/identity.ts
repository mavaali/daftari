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
//
// Bump this value whenever the tuple format, NUL-delimiter layout, or
// canonicalization algorithm changes in a way that would cause the same
// real-world finding to produce a different identity key.
// ---------------------------------------------------------------------------

export const IDENTITY_SCHEME_VERSION = "1";

// ---------------------------------------------------------------------------
// canonicalizeTarget — deterministic serialization of a FindingTarget for
// use in the hash-path. Sorts struct fields so insertion order doesn't matter.
//
// For tier2 targets, each field is appended as a separate NUL-separated entry
// into the caller's parts array (see deriveIdentity) rather than concatenated
// with colon delimiters. Colons appear in vault paths and edge classes such as
// "CONSUMES:SHALLOW", so using them as delimiters is collision-vulnerable.
// ---------------------------------------------------------------------------

// Returned as an array of parts so the caller can NUL-join them together with
// the rest of the identity tuple, keeping field boundaries unambiguous.
function canonicalizeTarget(target: FindingTarget): string[] {
  switch (target.kind) {
    case "lint":
      return [`lint`, target.path];
    case "staleness":
      return [`staleness`, target.path];
    case "tension":
      return [`tension`, target.tensionId];
    case "staged":
      return [`staged`, target.stagedActionId];
    case "tier2":
      // Fields appended in alphabetical order (artifact, edgeClass, unit) to be
      // insertion-order-stable. Each field is a separate NUL-delimited entry so
      // no field value can bleed into another's position.
      return [`tier2`, target.artifact, target.edgeClass, target.unit];
    default: {
      // Exhaustiveness guard: a runtime value that bypasses the type system
      // (e.g. a JSON-parsed target with an unknown kind) must fail loudly rather
      // than silently returning undefined and producing a broken identity key.
      const unexpected = (target as FindingTarget & { kind: string }).kind;
      throw new Error(`canonicalizeTarget: unexpected target kind "${unexpected}"`);
    }
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
  //
  // canonicalizeTarget returns an array of parts so each tier2 field gets its
  // own NUL-delimited slot — prevents colon-containing field values from
  // collapsing two distinct triples into the same canonical string.
  const parts: string[] = [source, check, ...canonicalizeTarget(target)];
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
//
// CONTRACT — evidence MUST be JSON-serializable:
//   • `undefined` values are silently dropped by JSON.stringify (consistent
//     with normal JSON behaviour, but callers should not rely on the absence
//     of a key as meaningful signal).
//   • BigInt, Symbol, and function values are not JSON-serializable;
//     JSON.stringify will throw (BigInt) or silently omit them (Symbol,
//     function). Passing such values is CALLER ERROR — adapters must convert
//     or exclude them before calling fingerprint.
//   • Circular references will cause JSON.stringify to throw; callers must
//     ensure the evidence graph is acyclic.
// ---------------------------------------------------------------------------

export function fingerprint(evidence: Record<string, unknown>): string {
  return sha256Hex(JSON.stringify(canonicalizeEvidence(evidence)));
}
