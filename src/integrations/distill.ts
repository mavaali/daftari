import { randomUUID } from "node:crypto";
import { withCallBudget } from "../consolidate/call-budget.js";
import { chunkMessages } from "../distill/chunk.js";
import { type ExtractOutcome, extractClaims } from "../distill/extract.js";
import { type ResolvedDistill, resolveDistillClient } from "../distill/index.js";
import { makeOverlapHinter } from "../distill/propose.js";
import {
  type DistillUpsertInput,
  type DistillUpsertOutcome,
  distillUpsert,
} from "../distill/state.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import type { DistillationInput, DistillationRun } from "./engine.js";

export interface IntegrationDistillDependencies {
  resolve(vaultRoot: string): Result<ResolvedDistill, Error>;
  extract: typeof extractClaims;
  upsert(
    vaultRoot: string,
    input: DistillUpsertInput,
  ): Promise<Result<DistillUpsertOutcome, Error>>;
  now(): Date;
  runNonce(): string;
}

export type IntegrationDistill = (
  input: DistillationInput,
) => Promise<Result<DistillationRun, Error>>;

const DEFAULT_DEPENDENCIES: IntegrationDistillDependencies = {
  resolve: resolveDistillClient,
  extract: extractClaims,
  upsert: distillUpsert,
  now: () => new Date(),
  runNonce: randomUUID,
};

function tracePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 120);
}

function runId(input: DistillationInput, deps: IntegrationDistillDependencies): string {
  return [
    "integration",
    tracePart(input.providerSourceId),
    tracePart(input.revision),
    deps.now().toISOString().replace(/[:.]/g, "-"),
    deps.runNonce(),
  ].join("-");
}

function splitNormalizedText(text: string, limit: number): string[] {
  if (text.length === 0) return [""];
  const parts: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const hardEnd = Math.min(offset + limit, text.length);
    let end = hardEnd;
    if (hardEnd < text.length) {
      const newline = text.lastIndexOf("\n", hardEnd);
      const space = text.lastIndexOf(" ", hardEnd);
      const boundary = Math.max(newline, space);
      if (boundary > offset) end = boundary + 1;
    }
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return parts;
}

function normalizedVerbatim(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function exceedsVerbatimFence(
  source: string,
  claims: ExtractOutcome["claims"],
  maxVerbatimChars: number,
): boolean {
  const normalizedSource = normalizedVerbatim(source);
  if (normalizedSource.length === 0) return false;
  let copiedCharacters = 0;
  for (const claim of claims) {
    const statement = normalizedVerbatim(claim.statement);
    if (statement.length === 0) continue;
    if (statement === normalizedSource) return true;
    if (normalizedSource.includes(statement)) copiedCharacters += statement.length;
    if (copiedCharacters > maxVerbatimChars) return true;
  }
  return false;
}

function preparedIntegrationDistill(
  vaultRoot: string,
  deps: IntegrationDistillDependencies,
  resolved: ResolvedDistill,
): IntegrationDistill {
  return async (input) => {
    const config = resolved.config;
    const messageTimestamp = deps.now().toISOString().slice(0, 19);
    const renderedPrefixLength = `[${messageTimestamp}] ${input.providerSourceId}: `.length;
    const sourceTextLimit = config.inCallInputCap - renderedPrefixLength;
    if (sourceTextLimit < 1) {
      return err(new Error("distill input cap is too small for integration source attribution"));
    }
    const chunks = chunkMessages(
      splitNormalizedText(input.text, sourceTextLimit).map((text) => ({
        ts: messageTimestamp,
        sender: input.providerSourceId,
        type: "text",
        text,
        attachment: null,
      })),
      1,
    );
    const budgeted = withCallBudget(resolved.client, config.maxLlmCalls);
    let extracted: ExtractOutcome;
    try {
      extracted = await deps.extract(chunks, budgeted, {
        model: config.model,
        maxClaims: config.maxClaims,
        inCallInputCap: config.inCallInputCap,
      });
    } catch {
      return err(new Error("integration claim extraction failed"));
    }
    if (extracted.budget_exhausted || extracted.chunkErrors.length > 0) {
      return err(new Error("integration claim extraction was incomplete"));
    }
    if (exceedsVerbatimFence(input.text, extracted.claims, config.maxVerbatimChars)) {
      return err(new Error("integration claim extraction exceeded the verbatim safety limit"));
    }

    const id = runId(input, deps);
    const upserted = await deps.upsert(vaultRoot, {
      sourceId: input.providerSourceId,
      sourceContent: input.text,
      claims: extracted.claims,
      runId: id,
      overlapSearch: makeOverlapHinter(vaultRoot),
    });
    if (!upserted.ok) return upserted;
    if ((upserted.value.propose?.errors.length ?? 0) > 0) {
      return err(new Error("integration proposal staging was incomplete"));
    }
    if (!upserted.value.stateWritten) {
      return err(new Error("integration distillation state could not be written"));
    }
    return ok({ runId: id });
  };
}

export function prepareIntegrationDistill(
  vaultRoot: string,
  overrides: Partial<IntegrationDistillDependencies> = {},
): Result<IntegrationDistill, Error> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const resolved = deps.resolve(vaultRoot);
  if (!resolved.ok) return resolved;
  return ok(preparedIntegrationDistill(vaultRoot, deps, resolved.value));
}

export function createIntegrationDistill(
  vaultRoot: string,
  overrides: Partial<IntegrationDistillDependencies> = {},
): IntegrationDistill {
  return async (input) => {
    const prepared = prepareIntegrationDistill(vaultRoot, overrides);
    return prepared.ok ? prepared.value(input) : prepared;
  };
}
