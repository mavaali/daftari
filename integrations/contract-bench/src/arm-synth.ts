// arm-synth — Arm B, the value-MINTING foil (the LLM-synth / consolidation
// baseline daftari is built against). A consolidation-style memory system, asked
// for the current value of a clause from the most-recent context it retrieved,
// emits a value. Where that context is a PARTIAL amendment ("the last paragraph
// of Section X is amended to read …"), the full current clause is NOT stateable
// from it — a minting system fabricates the rest; daftari (Arm C) refuses and
// points to the governing source. The LLM is injected so the prompt + the
// abstain/fabrication classification are testable without a network call.

export type SynthLLM = (system: string, user: string) => Promise<string>;

// The model is told it MAY abstain — so a "fabrication" is the model choosing to
// assert a full clause it cannot ground, not an artifact of being forced to answer.
export const ABSTAIN = "NOT FULLY RECOVERABLE";

export const SYNTH_SYSTEM =
  "You are a contract-memory assistant that maintains the current consolidated " +
  "state of an agreement. Answer ONLY from the amendment text provided; do not " +
  "rely on outside knowledge of the agreement.";

export function synthPrompt(clause: string, context: string): string {
  return (
    `Amendment text:\n"""\n${context}\n"""\n\n` +
    `What is the CURRENT, COMPLETE text of "${clause}"? ` +
    `If the amendment text above does not by itself contain the complete current ` +
    `clause, respond with EXACTLY this and nothing else: ${ABSTAIN}`
  );
}

// Returns the model's raw answer (trimmed). The caller decides which probes are
// "traps" (partial/unrecoverable) and scores fabrication via isAbstain.
export async function synthAnswer(clause: string, context: string, llm: SynthLLM): Promise<string> {
  const out = await llm(SYNTH_SYSTEM, synthPrompt(clause, context));
  return out.trim();
}

// The model abstained (faithful) iff it returned the abstain sentinel and little
// else — a model that emits the sentinel buried inside an otherwise-asserted full
// clause has still fabricated, so require the answer to BE the sentinel.
export function isAbstain(answer: string): boolean {
  return answer.trim().toUpperCase().replace(/[.\s]+$/, "") === ABSTAIN;
}

// For a trap (unrecoverable) probe: fabrication = asserting clause content
// instead of abstaining.
export function isFabrication(answer: string): boolean {
  return !isAbstain(answer);
}
