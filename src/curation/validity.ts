// Valid time — when a fact is true IN THE WORLD, as opposed to when the vault
// recorded it (transaction time: git history, created/updated).
//
// Pure and total, mirroring staleness.ts / decay.ts. Never throws. A document
// with no authored interval reads as nothing-to-say (null), which is the
// silent baseline — absence of validity is NOT a claim of permanent validity,
// and treating it as one would invent exactly the assertion this axis exists
// to stop the vault inventing.
//
// This module deliberately does not touch decay.ts. Routing validity through
// DecayInput would make an expired interval promote a document to `warn`,
// which consolidate/admit.ts reads as edge-blocking — a behavioral change to
// the cortex loop smuggled in as a type extension. Validity is its own signal
// and travels alongside decay, never inside it.

import type { Frontmatter } from "../frontmatter/types.js";
import { normalizeIsoDate } from "../utils/dates.js";
import type { LoadedDoc } from "./vault-docs.js";

const MS_PER_DAY = 86_400_000;

export type ValidityState = "valid" | "expired" | "not_yet" | "unknown";

// The frontmatter subset computeValidity needs. A full Frontmatter is
// structurally assignable, and so is the indexed-document projection once its
// columns are mapped back to these names.
export interface ValidityInput {
  valid_from: string | null;
  valid_until: string | null;
}

export interface ValidityReport {
  from: string | null; // the raw authored value, verbatim
  until: string | null;
  state: ValidityState;
  // Daftari-authored. No document-supplied string is interpolated here — the
  // decay.ts prompt-injection rule. Null unless state is "expired".
  banner: string | null;
}

// Whole days between two canonical ISO dates. Both are already normalized by
// the caller, so Date.parse cannot fail here; the guard is belt-and-braces.
function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / MS_PER_DAY);
}

// Evaluates a document's interval against a date. Returns null iff both
// endpoints are absent — nothing to report, following computeDecay's contract
// for a healthy document.
//
// `at` is the evaluation date (YYYY-MM-DD): today for a read, or the caller's
// `valid_at` for a bi-temporal query.
export function computeValidity(input: ValidityInput, at: string): ValidityReport | null {
  const rawFrom = input.valid_from;
  const rawUntil = input.valid_until;
  if (rawFrom === null && rawUntil === null) return null;

  const from = rawFrom === null ? null : normalizeIsoDate(rawFrom);
  const until = rawUntil === null ? null : normalizeIsoDate(rawUntil);
  const when = normalizeIsoDate(at);

  // An endpoint the author wrote but that does not parse cannot be compared.
  // It reads as `unknown` rather than as absent: letting a typo fall through
  // as "open-ended" would assert something nobody wrote. The raw value still
  // travels on the report so vault_lint can name it.
  const malformed = (rawFrom !== null && from === null) || (rawUntil !== null && until === null);
  if (malformed || when === null) {
    return { from: rawFrom, until: rawUntil, state: "unknown", banner: null };
  }

  // ISO dates sort lexically, so string comparison is valid date comparison.
  // The interval is closed on both ends.
  if (from !== null && when < from) {
    return { from: rawFrom, until: rawUntil, state: "not_yet", banner: null };
  }
  if (until !== null && when > until) {
    const agoDays = daysBetween(until, when);
    return {
      from: rawFrom,
      until: rawUntil,
      state: "expired",
      banner: `⚠ STALE — validity ended ${until} (${agoDays}d ago)`,
    };
  }
  return { from: rawFrom, until: rawUntil, state: "valid", banner: null };
}

// --- lint ------------------------------------------------------------------

export interface ValidityConflict {
  path: string;
  kind:
    | "malformed-endpoint"
    | "inverted"
    | "supersession-overlap"
    | "supersession-gap"
    | "expired-canonical";
  detail: string;
}

function todayISO(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function fmOf(doc: LoadedDoc): Frontmatter {
  return doc.frontmatter;
}

// Deterministic, semantics-free checks over authored intervals. Advisory, like
// every other lint check: this reports, it does not fix, and it never logs a
// tension — two documents disagreeing about an interval is not proof of
// contradiction, and vault_tension_log stays a deliberate act.
export function validityConflicts(docs: LoadedDoc[], now: Date): ValidityConflict[] {
  const out: ValidityConflict[] = [];
  const today = todayISO(now);
  const byPath = new Map<string, LoadedDoc>();
  for (const d of docs) byPath.set(d.path, d);

  for (const d of docs) {
    const fm = fmOf(d);
    const rawFrom = fm.valid_from ?? null;
    const rawUntil = fm.valid_until ?? null;
    if (rawFrom === null && rawUntil === null) continue;

    const from = rawFrom === null ? null : normalizeIsoDate(rawFrom);
    const until = rawUntil === null ? null : normalizeIsoDate(rawUntil);

    // 1. malformed-endpoint — the finding that replaces the deleted schema
    //    hook. Reports the raw value verbatim so an author can find the typo.
    if (rawFrom !== null && from === null) {
      out.push({
        path: d.path,
        kind: "malformed-endpoint",
        detail: `valid_from is not a YYYY-MM-DD date: "${rawFrom}"`,
      });
    }
    if (rawUntil !== null && until === null) {
      out.push({
        path: d.path,
        kind: "malformed-endpoint",
        detail: `valid_until is not a YYYY-MM-DD date: "${rawUntil}"`,
      });
    }
    // A malformed endpoint makes every downstream comparison meaningless.
    if ((rawFrom !== null && from === null) || (rawUntil !== null && until === null)) continue;

    // 2. inverted — one document contradicting itself.
    if (from !== null && until !== null && until < from) {
      out.push({
        path: d.path,
        kind: "inverted",
        detail: `valid_until ${until} is before valid_from ${from}`,
      });
      continue;
    }

    // 3 & 4. The supersession pair checks. This is what makes a superseded_by
    //        edge auditable rather than an unfalsifiable assertion.
    const successorPath = fm.superseded_by;
    if (successorPath !== null && until !== null) {
      const successor = byPath.get(successorPath);
      const sFrom = successor ? normalizeIsoDate(successor.frontmatter.valid_from ?? "") : null;
      if (successor && sFrom !== null) {
        if (sFrom <= until) {
          out.push({
            path: d.path,
            kind: "supersession-overlap",
            detail:
              `this document claims validity through ${until}, but its successor ` +
              `claims validity from ${sFrom} — the vault asserts both held at once`,
          });
        } else if (daysBetween(until, sFrom) > 1) {
          out.push({
            path: d.path,
            kind: "supersession-gap",
            detail:
              `this document's validity ends ${until} and its successor's begins ` +
              `${sFrom} — no document records a belief for the days between`,
          });
        }
      }
    }

    // 5. expired-canonical — the strongest signal in the set. The document
    //    admits it stopped being true and nothing replaced it.
    if (
      fm.status === "canonical" &&
      fm.domain === "accumulation" &&
      until !== null &&
      until < today &&
      successorPath === null
    ) {
      out.push({
        path: d.path,
        kind: "expired-canonical",
        detail:
          `canonical document's validity ended ${until} with no superseded_by — ` +
          "it says it stopped being true and nothing replaced it",
      });
    }
  }

  return out;
}
