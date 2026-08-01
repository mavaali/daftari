// Parses the harness-supplied raw config into a validated AdapterConfig.
//
// Follows daftari's Result convention: invalid input returns err, never throws.
// answererModel is required (non-empty string); the two numeric knobs default.

import { ok, err, type Result } from "../../../dist/frontmatter/types.js";

export type TimestampsAxis = "on" | "off";

// Which LLM the answerer talks to. "anthropic" uses the native @anthropic-ai/sdk
// client (needs ANTHROPIC_API_KEY); "openrouter" routes through OpenRouter
// (needs OPENROUTER_API_KEY) — the escape hatch when no billed Anthropic key is
// exposed. answererModel must be a slug the chosen transport understands.
export type AnswererTransport = "anthropic" | "openrouter";

export interface AdapterConfig {
  answererModel: string;
  maxSearchResults: number;
  agentMaxIterations: number;
  // The timestamps axis: when "off", calendar dates are scrubbed from the tool
  // output the answerer sees. Defaults to "on" (production-faithful).
  timestamps: TimestampsAxis;
  answererTransport: AnswererTransport;
}

const DEFAULT_MAX_SEARCH_RESULTS = 15;
const DEFAULT_AGENT_MAX_ITERATIONS = 6;
const DEFAULT_TIMESTAMPS: TimestampsAxis = "on";
const DEFAULT_ANSWERER_TRANSPORT: AnswererTransport = "anthropic";

function asPositiveInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return Number.NaN; // signals an invalid override to the caller
}

export function parseConfig(raw: Record<string, unknown>): Result<AdapterConfig, Error> {
  const model = raw.answererModel;
  if (typeof model !== "string" || model.trim().length === 0) {
    return err(new Error("config.answererModel is required and must be a non-empty string"));
  }

  const maxSearchResults = asPositiveInt(raw.maxSearchResults, DEFAULT_MAX_SEARCH_RESULTS);
  if (Number.isNaN(maxSearchResults)) {
    return err(new Error("config.maxSearchResults must be a positive integer"));
  }

  const agentMaxIterations = asPositiveInt(raw.agentMaxIterations, DEFAULT_AGENT_MAX_ITERATIONS);
  if (Number.isNaN(agentMaxIterations)) {
    return err(new Error("config.agentMaxIterations must be a positive integer"));
  }

  const rawTimestamps = raw.timestamps;
  if (rawTimestamps !== undefined && rawTimestamps !== "on" && rawTimestamps !== "off") {
    return err(new Error('config.timestamps must be "on" or "off"'));
  }
  const timestamps: TimestampsAxis = rawTimestamps === undefined ? DEFAULT_TIMESTAMPS : rawTimestamps;

  const rawTransport = raw.answererTransport;
  if (rawTransport !== undefined && rawTransport !== "anthropic" && rawTransport !== "openrouter") {
    return err(new Error('config.answererTransport must be "anthropic" or "openrouter"'));
  }
  const answererTransport: AnswererTransport =
    rawTransport === undefined ? DEFAULT_ANSWERER_TRANSPORT : rawTransport;

  return ok({
    answererModel: model,
    maxSearchResults,
    agentMaxIterations,
    timestamps,
    answererTransport,
  });
}
