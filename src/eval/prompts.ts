// src/eval/prompts.ts
// Frozen prompts for the three eval LLM roles. Bumping any prompt requires
// bumping PROMPT_VERSION in the same commit. PROMPT_VERSION is recorded in
// every output file for forensics and cross-version comparison gates.

export const PROMPT_VERSION = 1;

export const GENERATOR_PROMPT = `You will read a connected subgraph of a Markdown knowledge vault and produce
multi-hop questions across three tiers. The questions must be answerable using
ONLY the docs provided. For each question, supply: question text, tier,
expected answer, source paths (must be a subset of the supplied docs).

Tiers:
  retrieval        — single-doc lookup, 1-hop reasoning
  cross_reference  — requires combining 2–3 docs
  contradiction    — surfaces a tension or conflict across docs (use the
                     tension log entries in the subgraph as seed material
                     where present)

Return JSON matching the QuestionSetSchema declared in src/eval/types.ts.
Do not include questions whose expected_sources are not in the supplied docs.
Do not generate trivial yes/no questions.`;

export const ANSWERER_SYSTEM_PROMPT = `You will answer a question about a Markdown knowledge vault using ONLY the
provided Daftari tools. Do not use training knowledge. Do not guess. If the
vault does not contain the answer, say "Vault does not contain the answer."
Cite source paths in your final answer using the format [path/to/doc.md].`;

// Pack condition (spec 2026-07-26-context-packs-progressive-disclosure-
// design.md, Decision 4 / final plan Phase 3.1). No tools: the answerer's
// ONLY context is the vault_context brief handed to it as the user message.
// A prompt addition does not bump PROMPT_VERSION — the freeze rule covers
// EDITS to an existing prompt an already-scored run depends on; a new,
// separate prompt for a new condition is not an edit. Comparability across
// conditions is carried by EvalRun.condition, not by prompt identity.
export const PACK_ANSWERER_SYSTEM_PROMPT = `You will answer a question about a Markdown knowledge vault using ONLY the
context brief provided below — no tools are available. The brief was
assembled by selecting and annotating the most relevant documents; it is not
synthesized, so treat every line as a direct fact from the vault, never as a
conclusion someone drew for you. Do not use training knowledge. Do not guess.
If the brief does not contain the answer, say "Vault does not contain the
answer." Cite source paths in your final answer using the format
[path/to/doc.md].`;

export const GRADER_PROMPT = `You are grading an answer to a question about a Markdown knowledge vault.

Question:           {{QUESTION}}
Expected answer:    {{EXPECTED_ANSWER}}
Expected sources:   {{EXPECTED_SOURCES}}
Claimed answer:     {{CLAIMED_ANSWER}}
Cited sources:      {{CITED_SOURCES}}

Return JSON: {"correct": "yes" | "partial" | "no", "reasoning": "<string>"}

Definitions:
  yes     — claimed answer is substantively correct and cites at least one
            expected source
  partial — claimed answer is partially correct OR cites the right sources
            but misses key content OR the answerer correctly said "Vault
            does not contain the answer" when the expected answer disagrees
            (records a question-set quality issue, not a cortex failure)
  no      — claimed answer is wrong, hallucinated, or cites no expected
            sources`;
