// Test helper: copy the sample vault into an isolated temp directory.
//
// Reindexing writes .daftari/index.db inside the vault. Vitest runs test files
// in parallel, so any test that builds an index works on its own throwaway
// copy to avoid clobbering a shared index file.

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FIXTURE = resolve("test/fixtures/sample-vault");

export function makeTempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "daftari-test-"));
  // Skip the .daftari control dir so a stale index.db is never carried over.
  cpSync(FIXTURE, dir, {
    recursive: true,
    filter: (src) => !src.includes(".daftari"),
  });
  return dir;
}

export function cleanupVault(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
