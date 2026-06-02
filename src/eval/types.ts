// src/eval/types.ts
// Shared types for the cortex quality metric. Pure data shapes; no logic.
// See docs/superpowers/specs/2026-05-31-cortex-quality-metric-design.md.

import type { Result } from "../frontmatter/types.js";

// --- Tiers ---

export const TIERS = ["retrieval", "cross_reference", "contradiction"] as const;
export type Tier = (typeof TIERS)[number];

// Tier weight for the aggregate score formula.
export const TIER_WEIGHT: Record<Tier, number> = {
  retrieval: 1,
  cross_reference: 2,
  contradiction: 3,
};

// --- Question shapes ---

export interface Question {
  id: string; // stable hash of (tier + question text + expected sources)
  tier: Tier;
  question: string;
  expected_answer: string;
  expected_sources: string[]; // absolute-from-vault paths
  origin: "generated" | "augmented"; // augmented = derived from tension_log, no generator LLM. Named `origin` (not `source`) to avoid confusion with `expected_sources` and frontmatter `sources`.
}

export interface QuestionSet {
  id: string; // <vault-hash>-<seed>-<timestamp>
  vault_hash: string;
  seed: string;
  timestamp: string; // ISO8601 UTC
  subgraph: {
    seed_doc: string;
    nodes: string[];
    edges: SubgraphEdge[];
  };
  questions: Question[];
  generator_model: string;
  prompt_version: number;
  tier_counts_requested: Record<Tier, number>;
  tier_counts_produced: Record<Tier, number>;
}

export interface SubgraphEdge {
  from: string;
  to: string;
  kind: "sources" | "link" | "tension";
}

// --- Run shapes ---

export interface Trace {
  tool_calls: ToolCall[];
  final_answer: string;
  total_tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  wall_ms: number;
  stop_reason: string;
}

export interface ToolCall {
  tool: string;
  input: unknown;
  output: unknown; // or `{ tool_error: string }` if the call failed
  latency_ms: number;
}

export type RunStatus = "complete" | "incomplete";

interface PerRunResultBase {
  question_id: string;
  question_index: number;
  k_index: number;
}

// Discriminated on `status`: a complete run always carries a Trace; an
// incomplete (not-yet-run) slot always has null. This makes `trace` non-null
// without a guard once `status === "complete"` is checked.
export type PerRunResult =
  | (PerRunResultBase & { status: "complete"; trace: Trace })
  | (PerRunResultBase & { status: "incomplete"; trace: null });

export interface EvalRun {
  id: string; // <questions-id>-<model>-<timestamp>
  questions_id: string;
  answerer_model: string;
  prompt_version: number;
  timestamp: string;
  k: number;
  // Keyed by `"${question_index}:${k_index}"`. See spec §6.5 for rationale.
  runs: Record<string, PerRunResult>;
}

// --- Grade and score shapes ---

export type GradeVerdict = "yes" | "partial" | "no" | "ungraded";

export interface Grade {
  question_id: string;
  question_index: number;
  k_index: number;
  verdict: GradeVerdict;
  reasoning: string;
  grader_model: string;
}

export interface TierScore {
  mean: number;
  std: number;
  n: number;
  trace_efficiency: number; // mean tool calls per correct-or-partial answer
}

export interface Score {
  score: number;
  score_std: number;
  by_tier: Record<Tier, TierScore>;
  models: { generator: string; answerer: string; grader: string };
  prompt_version: number;
  spec_version: number;
  questions_id: string;
  results_id: string;
  vault_hash: string;
  k: number;
  n: number;
  timestamp: string;
}

// --- History ---

export interface HistoryEntry {
  score_id: string;
  score: number;
  score_std: number;
  by_tier: Record<Tier, number>; // just means here, not full TierScore
  vault_hash: string;
  timestamp: string;
  n: number;
  k: number;
  models: { generator: string; answerer: string; grader: string };
  prompt_version: number;
  spec_version: number;
}

export interface HistoryFile {
  version: 1;
  runs: HistoryEntry[];
}

export const HISTORY_RETENTION = 50;
export const SPEC_VERSION = 1;

// --- Errors ---

export type EvalError =
  | { kind: "config"; message: string }
  | { kind: "runtime"; message: string }
  | { kind: "llm"; message: string; retryable: boolean };

// --- JSON Schema for generator output ---
// The generator LLM is asked to return JSON matching this schema. Embedded
// here so the prompt, runtime validator, and types share one source of truth.
// NOTE: kept in sync MANUALLY with the `Question` interface above — there is no
// codegen between them. When you add/rename a Question field that the generator
// produces, update both this schema and `Question` in the same edit. (`id` and
// `origin` are assigned post-generation, so they are intentionally absent here.)

export const QuestionSetSchema = {
  type: "object",
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        required: ["tier", "question", "expected_answer", "expected_sources"],
        properties: {
          tier: { enum: TIERS },
          question: { type: "string", minLength: 1 },
          expected_answer: { type: "string", minLength: 1 },
          expected_sources: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
          },
        },
      },
    },
  },
} as const;

// --- Re-export Result for convenience in eval/* files ---
export type { Result };
