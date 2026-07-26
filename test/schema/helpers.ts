// Test helper: build a small vault (no git) with hand-written frontmatter, for
// `daftari schema` tests. Schema infer/diff read raw frontmatter only — no git
// history is needed, unlike the backfill fixtures.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface VaultDoc {
  path: string;
  body: string;
}

export function buildVault(docs: VaultDoc[], configYaml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "daftari-schema-"));
  mkdirSync(join(dir, ".daftari"), { recursive: true });
  writeFileSync(join(dir, ".daftari", "config.yaml"), configYaml ?? "version: 1\n");
  for (const doc of docs) {
    const abs = join(dir, doc.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, doc.body);
  }
  return dir;
}

export function cleanupVault(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
