// Test helper: copy the sample vault into an isolated temp directory.
//
// Reindexing writes .daftari/index.db inside the vault. Vitest runs test files
// in parallel, so any test that builds an index works on its own throwaway
// copy to avoid clobbering a shared index file.

import { cpSync, mkdtempSync, rmSync } from "node:fs";
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
  // maxRetries: a commit's detached background auto-gc (or a late
  // fire-and-forget append) can still be writing under the vault while
  // rmSync walks it — ENOTEMPTY teardown races seen on CI.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
