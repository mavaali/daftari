// consensus-cb4-derivation — daftari's ACTUAL cortex derivation classifier, vendored
// verbatim from src/consolidate/derivation-prompt.ts (commit 7adfd42). The bench
// cannot import across rootDir, so we copy + guard against drift (see the
// driftguard test). This acquirer structurally CANNOT mint a supersession — it
// reports {related, premise} only; the keystone in code.
import type { LlmClient } from "./consensus-llm.js";

export type PremiseSide = "A" | "B" | "symmetric";
export interface DerivationVerdict {
  related: boolean;
  premise: PremiseSide | null;
  reason: string;
}

// --- VERBATIM from src/consolidate/derivation-prompt.ts (keep in sync; drift-guarded) ---
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

export function derivationUserBody(aPath: string, aContent: string, bPath: string, bContent: string): string {
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
// --- end verbatim ---

const PREMISE_SIDES: ReadonlySet<string> = new Set(["A", "B", "symmetric"]);

export function parseCb4Derivation(raw: string): DerivationVerdict | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: any;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (typeof obj.related !== "boolean") return null;
  if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) return null;
  if (obj.related === false) return { related: false, premise: null, reason: obj.reason };
  if (typeof obj.premise !== "string" || !PREMISE_SIDES.has(obj.premise)) return null;
  return { related: true, premise: obj.premise as PremiseSide, reason: obj.reason };
}

// daftari-way acquisition: governing = DOC A, stale = DOC B. The prompt is
// presentation-order-agnostic by contract; premise is reported descriptively (a
// derivation foundation, NOT a supersession verdict).
// Reproduces daftari's completeJson system-prompt assembly verbatim
// (src/eval/llm.ts): the schema is embedded as a hint so the model returns the
// {related, premise, reason} shape. Without this the model free-forms keys
// (e.g. "reasoning") and the parse fails — i.e. this IS daftari's mechanism.
export function derivationSystemWithSchema(): string {
  return `${DERIVATION_SYSTEM}\n\nReturn JSON matching:\n${JSON.stringify(DERIVATION_VERDICT_SCHEMA, null, 2)}\nReturn ONLY JSON, no prose.`;
}

export async function acquireDerivation(
  client: LlmClient,
  govText: string,
  staleText: string,
): Promise<DerivationVerdict | null> {
  const body = derivationUserBody("governing", govText, "stale", staleText);
  const raw = await client.complete({
    model: "anthropic/claude-haiku-4.5",
    system: derivationSystemWithSchema(),
    user: body,
  });
  return parseCb4Derivation(raw);
}
