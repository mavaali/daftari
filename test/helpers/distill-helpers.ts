// Shared test helpers for the daftari distill CLI tests (review.test.ts,
// session-e2e.test.ts). Extracted to prevent the two suites' verbatim copies
// from drifting.

import { expect, vi } from "vitest";
import type { ExtractedClaim } from "../../src/distill/extract.js";
import { proposeAllClaims } from "../../src/distill/propose.js";

export function makeClaim(slug: string, hash8: string): ExtractedClaim {
  return {
    claim_key: `chunk-001:${slug}-${hash8}`,
    statement: `${slug.replace(/-/g, " ")}.`,
    proposed_frontmatter: { title: `${slug.replace(/-/g, " ")}.` },
  };
}

/** Stage a run's proposals; return claim_key → targetPath for later assertions. */
export async function stageRun(
  vault: string,
  sourceId: string,
  runId: string,
  claims: ExtractedClaim[],
): Promise<Record<string, string>> {
  const outcome = await proposeAllClaims(vault, claims, { sourceId, runId });
  expect(outcome.errors).toHaveLength(0);
  const map: Record<string, string> = {};
  for (const r of outcome.results) map[r.claim_key] = r.targetPath;
  return map;
}

/**
 * Stage a run whose proposals carry a controlled corroboration score, driven
 * by an injected overlapSearch stub keyed on the claim statement. `hiStatements`
 * get a high topScore (0.9), everything else gets a low one (0.1) — so
 * `--auto-safe --corroboration-threshold 0.8` splits them cleanly.
 */
export async function stageRunWithCorroboration(
  vault: string,
  sourceId: string,
  runId: string,
  claims: ExtractedClaim[],
  hiStatements: Set<string>,
): Promise<Record<string, string>> {
  const overlapSearch = async (statement: string) =>
    hiStatements.has(statement)
      ? { paths: ["decisions/existing.md"], topScore: 0.9 }
      : { paths: [], topScore: 0.1 };
  const outcome = await proposeAllClaims(
    vault,
    claims,
    { sourceId, runId },
    undefined,
    overlapSearch,
  );
  expect(outcome.errors).toHaveLength(0);
  const map: Record<string, string> = {};
  for (const r of outcome.results) map[r.claim_key] = r.targetPath;
  return map;
}

/** Capture stdout for the duration of `fn` (silences noisy CLI output). */
export async function captureStdout(
  fn: () => Promise<number>,
): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const spyOut = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    chunks.push(String(c));
    return true;
  });
  const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const code = await fn();
    return { code, out: chunks.join("") };
  } finally {
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
}
