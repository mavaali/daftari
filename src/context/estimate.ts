// Token estimation for context-pack budgeting (spec 2026-07-26-context-packs-
// progressive-disclosure-design.md, Decision 2 §5). chars/4, no tokenizer: a
// real tokenizer pins daftari to one model's vocabulary and adds a native or
// WASM dependency to every install, to gain precision this use case does not
// need — a brief cut at 3,900 estimated tokens vs. 4,100 real is not a
// failure mode. Deterministic and model-agnostic; within ~±15% on English
// markdown, which is why the assembler reserves 10% headroom on top of it
// (src/context/assemble.ts's BUDGET_HEADROOM). One function, so swapping in a
// real tokenizer later (should a future embedding provider ship one anyway)
// is a one-line change at every call site.

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
