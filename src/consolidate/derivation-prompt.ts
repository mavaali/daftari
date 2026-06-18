// Shared foundational-ordering derivation elicitation (spec §3.1).
//
// Replaces birth.ts's private derives/depends/neither token and decorrelation's
// duplicate. The judgment is two-part:
//   - related: is there a load-bearing derivation at all? (the reliable signal —
//     detection + promiscuity rejection; related=false ⇒ no edge)
//   - premise: foundational ordering — which doc is the load-bearing premise, the
//     one that must be established first for the other to make sense. "symmetric"
//     when each conditions the other; null only on parse failure.
//
// The prompt is presentation-order-agnostic by construction: it asks for a content
// role ("which is the premise"), never "does A derive from B", so it carries no
// position/token bias (validated ~50% DOC1-bias at temp 0). Direction is elicited
// at temperature 0 — a factual, deterministic judgment, not a creative one.

import { err, ok, type Result } from "../frontmatter/types.js";

export type PremiseSide = "A" | "B" | "symmetric";

export interface DerivationVerdict {
  related: boolean;
  premise: PremiseSide | null;
  reason: string;
}

const PREMISE_SIDES: ReadonlySet<string> = new Set(["A", "B", "symmetric"]);

// Embedded in the system prompt as a hint to the LLM (completeJson does not do
// strict JSON-Schema validation; parseDerivationVerdict is the real gate).
export const DERIVATION_VERDICT_SCHEMA = {
  type: "object",
  required: ["related", "premise", "reason"],
  properties: {
    related: { type: "boolean" },
    premise: {
      enum: ["A", "B", "symmetric"],
      description: "which doc is the load-bearing premise; ignored when related is false",
    },
    reason: { type: "string", minLength: 1 },
  },
} as const;

export const DERIVATION_SYSTEM =
  "You assess whether one document's central claim is a load-bearing derivation of " +
  "another's, and if so which is the foundational premise. A load-bearing dependency " +
  "means one claim rests on the other as a premise it could not stand without — not a " +
  "passing reference, a citation, or mere co-occurrence. Be conservative: when the " +
  "dependency is shallow or ambiguous, judge that there is none.";

// Foundational-ordering question. By contract this body contains no "derive"
// token and no "[template:" tag — it asks for a content role, not a directional
// verb, so it is presentation-order-agnostic.
export function derivationUserBody(
  aPath: string,
  aContent: string,
  bPath: string,
  bContent: string,
): string {
  return (
    `DOC A (path: ${aPath}):\n${aContent}\n\n` +
    `DOC B (path: ${bPath}):\n${bContent}\n\n` +
    "First: is there a load-bearing dependency between these two central claims — does " +
    "one rest on the other as a foundational premise (not a passing mention, a citation, " +
    "or mere co-occurrence)? If there is no such dependency, set related to false.\n\n" +
    "If there is a dependency: which of DOC A or DOC B is the load-bearing premise — the " +
    'one that would have to be established first for the other to make sense? Answer "A" ' +
    'or "B". If each claim conditions the other so that neither could be established first, ' +
    'answer "symmetric".\n\nReturn JSON.'
  );
}

// Mirrors birth's reject-and-continue parser, in the {related, premise} space.
// A false `related` discards any premise (-> null); a true `related` requires a
// valid premise side. `reason` is always required.
export function parseDerivationVerdict(raw: unknown): Result<DerivationVerdict, Error> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err(new Error("verdict: expected object"));
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.related !== "boolean") {
    return err(
      new Error(`verdict: 'related' must be a boolean, got ${JSON.stringify(obj.related)}`),
    );
  }
  if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) {
    return err(new Error("verdict: 'reason' is required (and non-empty)"));
  }
  if (obj.related === false) {
    return ok({ related: false, premise: null, reason: obj.reason });
  }
  if (typeof obj.premise !== "string" || !PREMISE_SIDES.has(obj.premise)) {
    return err(
      new Error(
        `verdict: 'premise' must be one of A|B|symmetric, got ${JSON.stringify(obj.premise)}`,
      ),
    );
  }
  return ok({ related: true, premise: obj.premise as PremiseSide, reason: obj.reason });
}
