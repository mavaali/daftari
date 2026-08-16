// Test helper: copy the sample vault into an isolated temp directory.
//
// Reindexing writes .daftari/index.db inside the vault. Vitest runs test files
// in parallel, so any test that builds an index works on its own throwaway
// copy to avoid clobbering a shared index file.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const FIXTURE = resolve("test/fixtures/sample-vault");

export function makeTempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "daftari-test-"));
  // Skip the .daftari control dir (stale index.db) and the fixture's own .git
  // directory (the fixture is itself a real git repo for offline auditability;
  // copying it makes the temp vault look like a git repo to isGitRepo, which
  // breaks tests that initialize a fresh repo).
  cpSync(FIXTURE, dir, {
    recursive: true,
    filter: (src) => !src.includes(".daftari") && !src.includes(`${sep}.git`),
  });
  return dir;
}

export function cleanupVault(dir: string): void {
  // CI teardown races: SOMETHING keeps writing under the vault while rmSync
  // walks it (ENOTEMPTY under .git/ and .daftari/ on loaded runners), and
  // rmSync's internal maxRetries alone did not absorb it. Outer loop with
  // real backoff; on final failure, NAME the survivors so the CI log
  // identifies the straggler writer instead of leaving us theorizing.
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (e) {
      lastError = e;
      try {
        execFileSync("sleep", ["0.12"]);
      } catch {
        // sleep unavailable — spin via a bounded no-op loop below
      }
    }
  }
  let survivors: string[] = [];
  try {
    survivors = (readdirSync(dir, { recursive: true }) as string[]).slice(0, 25);
  } catch {
    survivors = ["<unlistable>"];
  }
  throw new Error(
    `cleanupVault: ${dir} still busy after ~5s of retries; ` +
      `surviving entries: ${survivors.join(", ")} — a straggler process or ` +
      `async write is recreating files during teardown`,
    { cause: lastError },
  );
}
