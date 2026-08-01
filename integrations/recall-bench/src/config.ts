// Parses the harness-supplied raw config into a validated AdapterConfig.
//
// Follows daftari's Result convention: invalid input returns err, never throws.
// answererModel is required (non-empty string); the two numeric knobs default.

import { ok, err, type Result } from "../../../dist/frontmatter/types.js";

export type TimestampsAxis = "on" | "off";

export interface AdapterConfig {
  answererModel: string;
  maxSearchResults: number;
  agentMaxIterations: number;
  // The timestamps axis: when "off", calendar dates are scrubbed from the tool
  // output the answerer sees. Defaults to "on" (production-faithful).
  timestamps: TimestampsAxis;
}

const DEFAULT_MAX_SEARCH_RESULTS = 15;
const DEFAULT_AGENT_MAX_ITERATIONS = 6;
const DEFAULT_TIMESTAMPS: TimestampsAxis = "on";

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

  return ok({
    answererModel: model,
    maxSearchResults,
    agentMaxIterations,
    timestamps,
  });
}
